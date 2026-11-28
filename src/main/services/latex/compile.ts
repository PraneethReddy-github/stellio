import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pdfPageCount, pdfToText } from '../../ai/extract';
import type { Engine } from './engine';
import { precheckTex } from './precheck';
import { bwrapArgs, probeSandbox, SANDBOX_MISSING_MESSAGE, tectonicCacheDir, type Sandbox } from './sandbox';

export interface CompileError {
  line?: number;
  message: string;
}
export interface CompileWarning {
  kind: 'overfull' | 'underfull' | 'other';
  message: string;
}
export interface CompileResult {
  ok: boolean;
  pdf?: Buffer;
  pages?: number;
  log: string;
  errors: CompileError[];
  warnings: CompileWarning[];
  /** The only-cached compile failed because the TeX packages were never downloaded. */
  cacheMissing?: boolean;
  /** Nothing was compiled because bubblewrap is missing or fails its self-test. */
  sandboxUnavailable?: boolean;
  durationMs: number;
}

export interface CompileOptions {
  engine: Engine;
  tex: string;
  timeoutMs?: number;
  /** Default true: never touch the network. First run needs warmUp(). */
  onlyCached?: boolean;
  signal?: AbortSignal;
  /** Tests only: null simulates a host without bubblewrap. Default: probe for it. */
  sandbox?: Sandbox | null;
  /** Tests only: false skips the static pre-check to prove the sandbox holds on its own. */
  precheck?: boolean;
  /** The resume photo (D26), written into the work dir as photo.jpg. */
  photo?: Uint8Array;
}

export const CACHE_MISSING_MESSAGE = 'LaTeX packages not downloaded yet — run warm-up';

/**
 * The file an offline compile stopped on because the cache never got it: a font size (`clmr2j8t12`) or a package
 * (`fontawesome5.sty`). The warm-up only fetches what the seed templates use, so an edit that asks for another
 * size or package ends here. Null for any other error.
 */
export function missingCachedFile(log: string, stderr: string): string | null {
  const text = `${log}\n${stderr}`;
  const font = /Font [^=\s]+=(\S+) at [\d.]+pt not loadable: Metric \(TFM\) file/.exec(text);
  if (font?.[1]) return font[1];
  const file = /LaTeX Error: File `([^']+)' not found/.exec(text);
  // The resume photo comes from Profile, never from the internet: no download can bring it.
  return file?.[1] && !/^photo(\.\w+)?$/.test(file[1]) ? file[1] : null;
}

/** Puts `\resumephotofalse` in place of `\resumephototrue`: the tex compiles without the photo file. */
export const withoutPhoto = (tex: string): string =>
  tex.replace(/^\\resumephototrue$/gm, '\\resumephotofalse');

/** Failures a missing or broken connection causes (as opposed to TeX errors in the document). */
const NETWORK = /network|resolve|dns|connect|timed? ?out|tls|certificate|download|http|unreachable/i;
/** True when a failed warm-up looks like a connection problem; a TeX error in the document is not one. */
export const isNetworkError = (message: string, log: string): boolean =>
  !/^LaTeX Error|^Undefined control sequence|not loadable/.test(message) &&
  NETWORK.test(`${message}\n${log}`);

/** What the user reads when an edit needs a file the offline cache does not have. */
export const missingFileMessage = (file: string): string =>
  `LaTeX needs a file Stellio has not downloaded yet (${file}). Download missing files, then it compiles.`;

/** `! message` followed (within a few lines) by `l.<n> ...` is a TeX error with its source line. */
export function parseLog(log: string): { errors: CompileError[]; warnings: CompileWarning[] } {
  const lines = log.split(/\r?\n/);
  const errors: CompileError[] = [];
  const warnings: CompileWarning[] = [];
  const seen = new Set<string>();
  lines.forEach((l, i) => {
    if (l.startsWith('!')) {
      const message = l.replace(/^!\s*/, '').replace(/\.$/, '');
      let line: number | undefined;
      for (const next of lines.slice(i + 1, i + 12)) {
        const m = /^l\.(\d+)/.exec(next);
        if (m) {
          line = Number(m[1]);
          break;
        }
      }
      errors.push(line === undefined ? { message } : { line, message });
      return;
    }
    const box = /^(Overfull|Underfull) \\[hv]box/.exec(l);
    const other = /^(LaTeX|Package \S+) Warning:/.exec(l);
    if ((box || other) && !seen.has(l) && warnings.length < 30) {
      seen.add(l);
      warnings.push({ kind: box ? (box[1] === 'Overfull' ? 'overfull' : 'underfull') : 'other', message: l });
    }
  });
  return { errors, warnings };
}

/** Plain text of a PDF as ATS parsers see it: NFKC folds ligatures (U+FB01 → "fi"). */
export async function pdfText(pdf: Uint8Array): Promise<string> {
  return (await pdfToText(new Uint8Array(pdf))).normalize('NFKC');
}

function run(
  bin: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number; signal?: AbortSignal },
): Promise<{ code: number | null; stderr: string; timedOut: boolean; aborted: boolean }> {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs,
        killSignal: 'SIGKILL',
        signal: opts.signal,
        maxBuffer: 16 * 1024 * 1024,
      },
      (err, _stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: unknown }) | null;
        resolve({
          code: e === null ? 0 : typeof e.code === 'number' ? e.code : -1,
          stderr,
          timedOut: !!e?.killed && !opts.signal?.aborted,
          aborted: !!opts.signal?.aborted,
        });
      },
    );
  });
}

/**
 * Compiles one self-contained .tex in a fresh temp dir (removed afterwards), always inside the bubblewrap
 * sandbox and after the static pre-check (docs/06 §7). No shell; `--untrusted` disables shell escape.
 * Never throws for compile failures: they come back in `errors`.
 */
export async function compileTex(o: CompileOptions): Promise<CompileResult> {
  const started = Date.now();
  const timeoutMs = o.timeoutMs ?? 60_000;
  const onlyCached = o.onlyCached ?? true;
  const done = (
    r: Omit<CompileResult, 'durationMs' | 'log' | 'errors' | 'warnings'> & Partial<CompileResult>,
  ) => ({ log: '', errors: [], warnings: [], ...r, durationMs: Date.now() - started });

  const unsafe = o.precheck === false ? [] : precheckTex(o.tex);
  if (unsafe.length > 0) return done({ ok: false, errors: unsafe });
  let sandbox = o.sandbox;
  if (sandbox === undefined) {
    const p = await probeSandbox(o.engine.path);
    if (!p.ok) return done({ ok: false, errors: [{ message: p.reason }], sandboxUnavailable: true });
    sandbox = p.sandbox;
  }
  if (sandbox === null)
    return done({ ok: false, errors: [{ message: SANDBOX_MISSING_MESSAGE }], sandboxUnavailable: true });

  const cacheDir = tectonicCacheDir();
  await mkdir(cacheDir, { recursive: true }); // bwrap needs the bind source to exist
  const dir = await mkdtemp(join(tmpdir(), 'stellio-tex-'));
  try {
    await writeFile(join(dir, 'main.tex'), o.tex, 'utf8');
    if (o.photo) await writeFile(join(dir, 'photo.jpg'), o.photo);
    const args = bwrapArgs({ engine: o.engine.path, workDir: dir, cacheDir, network: !onlyCached });
    args.push('-X', 'compile', '--untrusted', '--keep-logs', '--outdir', '/work');
    if (onlyCached) args.push('--only-cached');
    args.push('main.tex');
    const r = await run(sandbox.path, args, { cwd: dir, timeoutMs, signal: o.signal });
    const log = await readFile(join(dir, 'main.log'), 'utf8').catch(() => '');
    const parsed = parseLog(log);
    if (r.aborted) return done({ ok: false, log, errors: [{ message: 'Compile cancelled' }] });
    if (r.timedOut)
      return done({
        ok: false,
        log,
        errors: [{ message: `LaTeX compile timed out after ${Math.round(timeoutMs / 1000)} s` }],
        warnings: parsed.warnings,
      });

    const pdf = await readFile(join(dir, 'main.pdf')).catch(() => null);
    if (r.code === 0 && pdf) {
      return done({ ok: true, pdf, pages: await pdfPageCount(pdf), log, warnings: parsed.warnings });
    }

    // A named file first: the message can say what is missing.
    const file = onlyCached ? missingCachedFile(log, r.stderr) : null;
    if (file) {
      const line = parsed.errors[0]?.line;
      return done({
        ok: false,
        log: log || r.stderr,
        errors: [{ ...(line === undefined ? {} : { line }), message: missingFileMessage(file) }],
        warnings: parsed.warnings,
        cacheMissing: true,
      });
    }
    // No TeX run at all, or a TeX run that stopped on a file the cache does not have.
    const missing =
      onlyCached &&
      !/Running TeX/.test(r.stderr) &&
      /only cached|failed to open input file|cache/i.test(r.stderr);
    if (missing)
      return done({
        ok: false,
        log: log || r.stderr,
        errors: [{ message: CACHE_MISSING_MESSAGE }],
        cacheMissing: true,
      });
    const errors = parsed.errors.length > 0 ? parsed.errors : stderrErrors(r.stderr);
    return done({ ok: false, log: log || r.stderr, errors, warnings: parsed.warnings });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Fallback when there is no log: tectonic prints `error: main.tex:4: message`. */
function stderrErrors(stderr: string): CompileError[] {
  const out: CompileError[] = [];
  for (const l of stderr.split('\n')) {
    const m = /^error: (?:main\.tex:(\d+): )?(.+)$/.exec(l);
    if (m?.[2]) out.push(m[1] ? { line: Number(m[1]), message: m[2] } : { message: m[2] });
  }
  return out.length > 0 ? out : [{ message: 'LaTeX compile failed' }];
}

/** A tiny document using the packages the format 1 seed templates use: compiles only if the cache is warm. */
const PROBE = String.raw`\documentclass{article}
\usepackage[a4paper]{geometry}\usepackage[T1]{fontenc}\usepackage{charter}\usepackage[hidelinks]{hyperref}
\usepackage{xcolor,titlesec,enumitem,tabularx}
\begin{document}ok\end{document}
`;

const SIZES =
  String.raw`\tiny \scriptsize \footnotesize \small \normalsize \large \Large \LARGE \huge \Huge`.split(' ');
const STYLES = [
  '',
  String.raw`\bfseries`,
  String.raw`\itshape`,
  String.raw`\scshape`,
  String.raw`\bfseries\itshape`,
  String.raw`\slshape`,
  String.raw`\ttfamily`,
  String.raw`\sffamily`,
  String.raw`\sffamily\bfseries`,
];

/**
 * A page with the template's preamble and every standard size in every common style, for each font family the
 * template selects (`\fontfamily{..}`): compiling it once online puts all those font files in the cache, so an
 * edit to another size or weight still compiles offline. Null when the text has no document body.
 */
export function fontSampleTex(tex: string): string | null {
  const at = tex.indexOf(String.raw`\begin{document}`);
  if (at < 0) return null;
  const families = [
    '',
    ...[...new Set([...tex.matchAll(/\\fontfamily\{(\w+)\}/g)].map((m) => m[1]))].map(
      (f) => String.raw`\fontfamily{${f ?? ''}}\selectfont`,
    ),
  ];
  const lines = families.flatMap((f) =>
    SIZES.flatMap((size) => STYLES.map((st) => `{${f}${size}${st} Aa1}`)),
  );
  return `${tex.slice(0, at)}\\begin{document}\n${lines.join('\n')}\n\\end{document}\n`;
}

/** Engine paths whose offline compile worked: a different engine has to prove it again. */
const warmEngines = new Set<string>();
/**
 * True when an offline compile of the template packages works: the probe, then the given templates (the seeds),
 * so a cache warmed for older templates is reported cold once and the warm-up fetches the rest. Only a positive
 * answer is memoized.
 */
export async function isCacheWarm(engine: Engine, texes: string[] = []): Promise<boolean> {
  if (warmEngines.has(engine.path)) return true;
  for (const tex of [PROBE, ...texes])
    if (!(await compileTex({ engine, tex, timeoutMs: 30_000 })).ok) return false;
  warmEngines.add(engine.path);
  return true;
}

/**
 * Compiles the given template (the seed template, ideally every one) once WITH network access so the
 * package cache is filled. A cold run downloads about 43 MB and takes up to about 2 minutes.
 */
export async function warmUp(
  engine: Engine,
  texes: string[] = [],
  signal?: AbortSignal,
  /** The resume photo: a resume that shows it reads photo.jpg, as in a normal compile. */
  photo?: Uint8Array,
): Promise<CompileResult> {
  let last: CompileResult | undefined;
  for (const tex of [PROBE, ...texes]) {
    last = await compileTex({
      engine,
      tex,
      onlyCached: false,
      timeoutMs: 5 * 60_000,
      signal,
      ...(photo ? { photo } : {}),
    });
    if (!last.ok) return last;
  }
  warmEngines.add(engine.path);
  return last as CompileResult;
}
