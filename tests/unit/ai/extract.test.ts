import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractResumeText, texToText } from '../../../src/main/ai/extract';

const fx = (n: string) => resolve('tests/fixtures/resumes', n);
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stellio-extract-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('extractResumeText', () => {
  it('reads .txt and .md as is', async () => {
    const t = await extractResumeText(fx('jordan-vale.txt'));
    expect(t).toContain('Brightwater Analytics GmbH');
    const md = join(dir, 'r.md');
    writeFileSync(md, '# Hi\n- x');
    expect(await extractResumeText(md)).toBe('# Hi\n- x');
  });

  it('extracts text from a PDF, one line per visual line', async () => {
    const t = await extractResumeText(fx('jordan-vale.pdf'));
    const lines = t.split('\n').map((l) => l.trim());
    expect(lines).toContain('Jordan Vale');
    expect(lines).toContain('Python, SQL, dbt, Airflow, PostgreSQL');
    expect(t).toContain('Senior Data Engineer, Brightwater Analytics GmbH (2022 - Present)');
  });

  it('extracts text from .tex without comments or preamble', async () => {
    const t = await extractResumeText(fx('jordan-vale.tex'));
    expect(t).toContain('Jordan Vale');
    expect(t).toContain('Senior Data Engineer, Brightwater Analytics GmbH');
    expect(t).toContain('- Designed a PostgreSQL star schema used by 12 analysts & managers.');
    expect(t).toContain('20%');
    expect(t).not.toContain('private note');
    expect(t).not.toContain('documentclass');
    expect(t).not.toContain('\\');
  });

  it('rejects other types and files over 10 MB', async () => {
    const docx = join(dir, 'r.docx');
    writeFileSync(docx, 'x');
    await expect(extractResumeText(docx)).rejects.toThrow(/unsupported/i);
    const big = join(dir, 'big.txt');
    writeFileSync(big, Buffer.alloc(10 * 1024 * 1024 + 1, 97));
    await expect(extractResumeText(big)).rejects.toThrow(/10 MB/);
  });

  it('rejects a corrupt PDF with a readable error', async () => {
    const bad = join(dir, 'bad.pdf');
    writeFileSync(bad, 'not a pdf');
    await expect(extractResumeText(bad)).rejects.toThrow();
  });
});

describe('texToText', () => {
  it('keeps macro arguments, drops comments, unescapes specials', () => {
    expect(texToText('\\textbf{Bold} and \\href{http://x}{link} 50\\% % gone\nnext')).toBe(
      'Bold and link 50%\nnext',
    );
  });
  it('turns items into dashes and \\\\ into newlines', () => {
    expect(texToText('\\begin{document}\\item One\\\\Two\\end{document}')).toBe('- One\nTwo');
  });
});
