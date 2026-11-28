import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TEMPLATE_FILES, type TemplateFile } from '@shared/rules/files';
import { UserError } from '../../ipc/dispatch';
import { compileTex, fontSampleTex, isCacheWarm, warmUp, type CompileResult } from './compile';
import { detectEngine, type Engine } from './engine';
import { installSupported, installTectonic, type InstallProgress } from './install';
import { probeSandbox } from './sandbox';

/** Preview PDFs above this are not sent to the renderer. */
export const MAX_PREVIEW_BYTES = 5 * 1024 * 1024;

export interface LatexStatus {
  engine: { kind: 'tectonic'; path: string; version: string } | null;
  /** Offline compile of the template packages works. Null when there is no engine or sandbox to ask. */
  cacheWarm: boolean | null;
  installSupported: boolean;
  /** The OS sandbox every compile runs in; null = compiling is refused (install bubblewrap). */
  sandbox: 'bwrap' | null;
}

export interface TemplateCompile {
  ok: boolean;
  pages: number | null;
  errors: CompileResult['errors'];
  warnings: CompileResult['warnings'];
  cacheMissing: boolean;
  durationMs: number;
  pdfBase64?: string;
}

export interface LatexServiceDeps {
  userDataDir: string;
  dataDir: string;
  seedDir: string;
  /** Settings → LaTeX engine path override. */
  override?: () => string | undefined;
  /** The resume photo (D26); copied into resume compiles only. */
  photo?: () => Promise<Uint8Array | null>;
}

export function createLatexService(deps: LatexServiceDeps) {
  const detect = (): Promise<Engine | null> =>
    detectEngine({ override: deps.override?.(), userDataDir: deps.userDataDir });

  async function requireEngine(): Promise<Engine> {
    const engine = await detect();
    if (!engine) throw new UserError('No LaTeX engine found. Install Tectonic in Settings → LaTeX.');
    return engine;
  }

  const seeds = (): Promise<string[]> =>
    Promise.all(TEMPLATE_FILES.map((t) => readFile(join(deps.seedDir, t), 'utf8')));
  /**
   * What a warm-up downloads for: the seeds plus a font-size sample of each, so ordinary edits never need a file
   * the cache lacks. The warm check stays on the seeds alone: a sample costs 2-3 s offline, on every status read.
   */
  const warmSet = async (): Promise<string[]> => {
    const texes = await seeds();
    return [...texes, ...texes.flatMap((t) => fontSampleTex(t) ?? [])];
  };

  async function status(): Promise<LatexStatus> {
    const engine = await detect();
    const sandbox = engine && (await probeSandbox(engine.path)).ok ? 'bwrap' : null;
    return {
      engine,
      cacheWarm: engine && sandbox ? await isCacheWarm(engine, await seeds()) : null,
      installSupported: installSupported(),
      sandbox,
    };
  }

  // One install or warm-up at a time; a second call joins the first.
  let installing: Promise<LatexStatus> | undefined;
  function install(onProgress: (p: InstallProgress) => void, signal?: AbortSignal): Promise<LatexStatus> {
    installing ??= installTectonic(join(deps.userDataDir, 'bin'), { onProgress, signal })
      .then(status)
      .finally(() => {
        installing = undefined;
      });
    return installing;
  }

  let warming: Promise<LatexStatus> | undefined;
  /** `extra`: a document that stopped on a missing file (Download missing files); compiled online too. */
  async function warm(signal?: AbortSignal, extra: string[] = []): Promise<LatexStatus> {
    if (warming && extra.length > 0) await warming.catch(() => undefined); // then fetch what this one needs
    warming ??= (async () => {
      const engine = await requireEngine();
      const res = await warmUp(engine, [...(await warmSet()), ...extra], signal);
      if (!res.ok)
        throw new UserError(
          `Warm-up failed: ${res.errors[0]?.message ?? 'unknown error'}. It needs internet access once.`,
        );
      return status();
    })().finally(() => {
      warming = undefined;
    });
    return warming;
  }

  /** Compiles a template as-is (its sample content). `content` overrides the file, e.g. unsaved editor text. */
  async function compileTemplate(path: TemplateFile, content?: string): Promise<TemplateCompile> {
    const engine = await requireEngine();
    const tex = content ?? (await readFile(join(deps.dataDir, path), 'utf8'));
    const photo = path === 'templates/resume.tex' ? await deps.photo?.() : null;
    const r = await compileTex({ engine, tex, ...(photo ? { photo } : {}) });
    const warnings = [...r.warnings];
    let pdfBase64: string | undefined;
    if (r.pdf) {
      if (r.pdf.length <= MAX_PREVIEW_BYTES) pdfBase64 = r.pdf.toString('base64');
      else warnings.push({ kind: 'other', message: 'The PDF is over 5 MB, so no preview is shown.' });
    }
    return {
      ok: r.ok,
      pages: r.pages ?? null,
      errors: r.errors,
      warnings,
      cacheMissing: r.cacheMissing ?? false,
      durationMs: r.durationMs,
      ...(pdfBase64 === undefined ? {} : { pdfBase64 }),
    };
  }

  return { status, install, warm, compileTemplate };
}

export type LatexService = ReturnType<typeof createLatexService>;
