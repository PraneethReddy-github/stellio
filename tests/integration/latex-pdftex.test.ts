import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pdfText } from '../../src/main/services/latex/compile';
import { escapeLatex, fillTemplate } from '../../src/shared/latex/template';
import { pdfPageCount } from '../../src/main/ai/extract';

/**
 * Overleaf compiles with pdfTeX. Runs when `pdflatex` (TeX Live) is on PATH, or STELLIO_PDFLATEX_BIN points at one
 * (a wrapper script is fine). Skipped otherwise: CI installs texlive-latex-recommended + texlive-fonts-recommended.
 */
function findPdflatex(): string | null {
  const bin = process.env.STELLIO_PDFLATEX_BIN || 'pdflatex';
  try {
    execFileSync(bin, ['--version'], { stdio: 'ignore', timeout: 20_000 });
    return bin;
  } catch {
    return null;
  }
}
const bin = findPdflatex();
const seed = (f: string): string => readFileSync(resolve('seed/templates', f), 'utf8');

async function compile(tex: string): Promise<{ pdf: Buffer; log: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'stellio-pdftex-'));
  try {
    writeFileSync(join(dir, 'main.tex'), tex);
    execFileSync(
      bin as string,
      ['-interaction=nonstopmode', '-halt-on-error', '-no-shell-escape', 'main.tex'],
      {
        cwd: dir,
        stdio: 'ignore',
        timeout: 120_000,
      },
    );
    return { pdf: await readFile(join(dir, 'main.pdf')), log: await readFile(join(dir, 'main.log'), 'utf8') };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe.skipIf(!bin)('pdfLaTeX (Overleaf engine)', () => {
  it.each(['resume.tex', 'cover-letter.tex'])(
    'seed %s compiles to one page without box warnings',
    async (f) => {
      const { pdf, log } = await compile(seed(f));
      expect(await pdfPageCount(pdf)).toBe(1);
      expect(log).not.toMatch(/Overfull|Underfull|Missing character/);
    },
  );

  it('escaped nasty text compiles and reads back from the text layer', async () => {
    const latin1 = '& % $ # _ { } ~ ^ \\ C++ C# \u00FC \u2014 Zo\u00EB M\u00FCnchen';
    // Latin Extended-A compiles, but pdfTeX builds some of those glyphs from accent + letter, so they may
    // extract in a different order (docs/06 §7): only the compile is checked for them.
    const nasty = `${latin1} \u0141\u00F3d\u017A \u201Cq\u201D it\u2019s \u2026`;
    const tex = fillTemplate(seed('resume.tex'), {
      summary: `\\resumeSummary{${escapeLatex(nasty)} first workflow profiling}`,
    });
    const { pdf, log } = await compile(tex);
    expect(log).not.toMatch(/Missing character/);
    const squash = (s: string): string => s.normalize('NFKC').replace(/\s+/g, '');
    const text = squash(await pdfText(pdf));
    expect(text).toContain(squash(latin1));
    expect(text).toContain('firstworkflowprofiling');
  });
});
