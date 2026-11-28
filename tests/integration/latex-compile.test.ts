import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileTex, isCacheWarm, parseLog, pdfText } from '../../src/main/services/latex/compile';
import { detectEngine, type Engine } from '../../src/main/services/latex/engine';
import { escapeLatex, fillTemplate } from '../../src/shared/latex/template';

/** STELLIO_TECTONIC_BIN, else the spike binary. Tests skip only when neither exists. */
const BIN = process.env.STELLIO_TECTONIC_BIN || resolve('spikes/latex/bin/tectonic');
const have = existsSync(BIN);
const engine: Engine | null = have ? await detectEngine({ override: BIN, env: { PATH: '' } }) : null;
const seed = (f: string): string => readFileSync(resolve('seed/templates', f), 'utf8');

describe('parseLog', () => {
  it('reads ! errors with their l.<n> line, and box warnings', () => {
    const log = [
      'Overfull \\hbox (3.0pt too wide) in paragraph at lines 9--9',
      'LaTeX Warning: Reference `x` undefined.',
      '! Undefined control sequence.',
      'l.4 Hi \\foo',
      '            bar',
      '! Missing $ inserted.',
      '<inserted text>',
      'l.12 a_b',
    ].join('\n');
    const { errors, warnings } = parseLog(log);
    expect(errors).toEqual([
      { line: 4, message: 'Undefined control sequence' },
      { line: 12, message: 'Missing $ inserted' },
    ]);
    expect(warnings.map((w) => w.kind)).toEqual(['overfull', 'other']);
  });
});

describe.skipIf(!engine)('compileTex (tectonic)', { timeout: 60_000 }, () => {
  const e = engine as Engine;

  it.each(['resume.tex', 'cover-letter.tex'])('seed %s compiles to one page, no errors', async (f) => {
    const r = await compileTex({ engine: e, tex: seed(f) });
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.pages).toBe(1);
    expect(r.pdf?.subarray(0, 5).toString()).toBe('%PDF-');
    expect(r.warnings.filter((w) => w.kind !== 'other')).toEqual([]);
  });

  it('a file the offline cache does not have is "cache missing", naming the file, not a plain TeX error', async () => {
    const tex = seed('resume.tex').replace(
      '\\begin{document}',
      '\\usepackage{stellio-not-cached}\n\\begin{document}',
    );
    const r = await compileTex({ engine: e, tex });
    expect(r.ok).toBe(false);
    expect(r.cacheMissing).toBe(true);
    expect(r.errors[0]?.message).toContain('stellio-not-cached.sty');
    expect(r.errors[0]?.message).toContain('Download missing files');
  });

  it('a broken macro gives a line-numbered error', async () => {
    const tex = seed('resume.tex').replace('\\resumeSummary{Data', '\\resumeSummry{Data');
    const r = await compileTex({ engine: e, tex });
    expect(r.ok).toBe(false);
    expect(r.pdf).toBeUndefined();
    const line = tex.split('\n').findIndex((l) => l.includes('\\resumeSummry')) + 1;
    expect(r.errors[0]).toEqual({ line, message: 'Undefined control sequence' });
  });

  it('a filled template with an empty section still compiles', async () => {
    const tex = fillTemplate(seed('resume.tex'), { projects: '', certifications: '' });
    const r = await compileTex({ engine: e, tex });
    expect(r.ok).toBe(true);
    expect(await pdfText(r.pdf as Buffer)).not.toContain('Project Name');
  });

  it('escaped nasty text compiles and reads back from the PDF text layer', async () => {
    const nasty = '& % $ # _ { } ~ ^ \\ C++ C# ü — Zoë München';
    const tex = fillTemplate(seed('resume.tex'), {
      summary: `\\resumeSummary{${escapeLatex(nasty)} first workflow profiling}`,
    });
    const r = await compileTex({ engine: e, tex });
    expect(r.errors).toEqual([]);
    const text = await pdfText(r.pdf as Buffer);
    // pdfjs may split glyph runs with spaces around some symbols; compare without whitespace.
    const squash = (s: string): string => s.normalize('NFKC').replace(/\s+/g, '');
    expect(squash(text)).toContain(squash(nasty));
    expect(squash(text)).toContain('firstworkflowprofiling');
  });

  it('times out and kills a runaway compile', async () => {
    const tex = '\\documentclass{article}\\begin{document}\\def\\a{\\a\\a}\\a\\end{document}';
    const r = await compileTex({ engine: e, tex, timeoutMs: 1500 });
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.message).toMatch(/timed out|Capacity|TeX capacity|exceeded/i);
  });

  it('can be cancelled', async () => {
    const ac = new AbortController();
    const p = compileTex({ engine: e, tex: seed('resume.tex'), signal: ac.signal });
    ac.abort();
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.message).toBe('Compile cancelled');
  });

  it('a cold package cache says so clearly and offers warm-up', async () => {
    const cache = await mkdtemp(resolve(tmpdir(), 'stellio-emptycache-'));
    const prev = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = cache;
    try {
      const r = await compileTex({ engine: e, tex: seed('resume.tex') });
      expect(r.ok).toBe(false);
      expect(r.cacheMissing).toBe(true);
      expect(r.errors).toEqual([{ message: 'LaTeX packages not downloaded yet — run warm-up' }]);
    } finally {
      if (prev === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = prev;
      await rm(cache, { recursive: true, force: true });
    }
  });

  it('remembers a warm cache per engine path, not globally', async () => {
    expect(await isCacheWarm(e)).toBe(true);
    expect(await isCacheWarm({ ...e, path: '/nonexistent/tectonic' })).toBe(false);
  });

  it('leaves no temp directories behind', async () => {
    // A private TMPDIR makes the count immune to other test workers compiling at the same time.
    const priv = await mkdtemp(resolve(tmpdir(), 'stellio-privtmp-'));
    const prev = process.env.TMPDIR;
    process.env.TMPDIR = priv;
    try {
      await compileTex({ engine: e, tex: seed('cover-letter.tex') });
      await compileTex({ engine: e, tex: '\\bad' });
      expect(await readdir(priv)).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = prev;
      await rm(priv, { recursive: true, force: true });
    }
  });
});

describe('detectEngine', () => {
  it('returns null when nothing usable is found', async () => {
    expect(await detectEngine({ env: { PATH: '/nonexistent', STELLIO_TECTONIC_BIN: '/nope' } })).toBeNull();
  });

  it.skipIf(!have)('env override wins and reports the version', async () => {
    const found = await detectEngine({ env: { PATH: '', STELLIO_TECTONIC_BIN: BIN } });
    expect([found?.kind, found?.path]).toEqual(['tectonic', BIN]);
    expect(found?.version).toMatch(/^\d+\.\d+/);
  });
});
