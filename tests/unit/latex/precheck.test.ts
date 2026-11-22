import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { precheckTex } from '../../../src/main/services/latex/precheck';

const file = (p: string): string => readFileSync(resolve(p), 'utf8');

describe('precheckTex', () => {
  it.each([
    'seed/templates/resume.tex',
    'seed/templates/cover-letter.tex',
    'tests/fixtures/latex/stress-resume.tex',
    'tests/fixtures/latex/stress-resume-fit.tex',
  ])('%s passes', (p) => {
    expect(precheckTex(file(p))).toEqual([]);
  });

  it.each([
    ['\\input{/etc/hostname}', '\\input'],
    ['\\newread\\r \\openin\\r=/etc/hostname', '\\openin'],
    ['\\read\\r to\\x', '\\read'],
    ['\\immediate\\openout\\o=../escaped.txt', '\\immediate'],
    ['\\immediate\\openout\\o=../escaped.txt', '\\openout'],
    ['\\write18{id}', '\\write'],
    ['\\include{chap}', '\\include'],
    ['\\makeatletter\\@@input /etc/hostname', '\\@@input'],
    ['\\InputIfFileExists{x}{}{}', '\\InputIfFileExists'],
    ['\\IfFileExists{/etc/passwd}{a}{b}', '\\IfFileExists'],
    ['\\catcode`\\Z=0', '\\catcode'],
    ['\\csname input\\endcsname{x}', '\\csname'],
    ['\\endlinechar=-1', '\\endlinechar'],
    ['\\scantokens{x}', '\\scantokens'],
    ['\\directlua{os.execute("id")}', '\\directlua'],
    ['\\special{pdf:obj @x}', '\\special'],
    ['\\pdfximage{/etc/hostname}', '\\pdfximage'],
    ['\\includegraphics{/etc/x.png}', '\\includegraphics'],
    ['\\lstinputlisting{/etc/hostname}', '\\lstinputlisting'],
    ['\\verbatiminput{/etc/hostname}', '\\verbatiminput'],
    ['\\XeTeXpicfile "/etc/x.png"', '\\XeTeXpicfile'],
    ['\\font\\x=[/etc/hostname]', '\\font'],
    ['\\begin{filecontents*}{../x.tex}', '{filecontents*}'],
    ['\\begin{input}{/etc/hostname}', '{input}'],
    ['\\let\\b\\begin \\b{openout}', '{openout}'],
    ['\\ExplSyntaxOn \\ior_open:Nn', '\\ExplSyntaxOn'],
    ['\\usepackage{../../../home/u/evil}', 'a package or class path "../../../home/u/evil"'],
    ['\\documentclass{/etc/x}', 'a package or class path "/etc/x"'],
    ['\\href{run:xterm}{click}', 'a run: link'],
    ['\\url{file:///etc/passwd}', 'a file: link'],
    ['^^5cinput', '^^ character escapes'],
  ])('rejects %s', (tex, what) => {
    const errors = precheckTex(`\\documentclass{article}\n${tex}\n`);
    expect(errors.map((e) => e.message)).toContain(
      `Stellio templates can't read or write files: ${what} on line 2`,
    );
    expect(errors[0]?.line).toBe(2);
  });

  it('allows only the exact guarded glyphtounicode input', () => {
    expect(precheckTex('\\ifdefined\\pdfgentounicode\\input{glyphtounicode}\\pdfgentounicode=1\\fi')).toEqual(
      [],
    );
    expect(precheckTex('\\input{glyphtounicode}')).toHaveLength(1);
  });

  it('ignores comments and escaped percent signs, keeps ordinary text', () => {
    expect(precheckTex('% \\input{/etc/hostname}\n50\\% faster % \\openout')).toEqual([]);
    expect(precheckTex('50\\% \\openout\\o=x')).toHaveLength(1);
    expect(precheckTex('\\\\% comment after a line break')).toEqual([]);
    expect(
      precheckTex(
        '\\usepackage[utf8]{inputenc}\\textbf{Reader}\\href{https://x.org}{x}\\href{mailto:a@b.c}{a}',
      ),
    ).toEqual([]);
  });
});
