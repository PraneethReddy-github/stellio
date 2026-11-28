import { describe, expect, it } from 'vitest';
import { fontSampleTex, missingCachedFile } from '../../../src/main/services/latex/compile';

describe('missingCachedFile', () => {
  it('names a font size the offline cache does not have', () => {
    const log =
      '! Font T1/clm2j/m/n/12=clmr2j8t12 at 12.0pt not loadable: Metric (TFM) file or installed font not found.\nl.194';
    expect(missingCachedFile(log, '')).toBe('clmr2j8t12');
    expect(
      missingCachedFile(
        '',
        'error: main.tex:194: Font T1/cmr/m/n/12=ecrm1200 at 12.0pt not loadable: Metric (TFM) file or installed font not found',
      ),
    ).toBe('ecrm1200');
  });
  it('names a package or file that was never downloaded', () => {
    expect(missingCachedFile("! LaTeX Error: File `fontawesome5.sty' not found.", '')).toBe(
      'fontawesome5.sty',
    );
  });
  it('is null for ordinary TeX errors', () => {
    expect(missingCachedFile('! Undefined control sequence.\nl.12 \\foo', '')).toBeNull();
    expect(missingCachedFile('', 'error: main.tex:4: Missing $ inserted')).toBeNull();
  });
});

describe('fontSampleTex', () => {
  it('keeps the preamble and samples every size and style for each font family the template selects', () => {
    const tex = String.raw`\documentclass[11pt]{article}\usepackage{cfr-lm}
\begin{document}\fontfamily{cmr}\selectfont Body \fontfamily{cmr}\selectfont again\end{document}`;
    const out = fontSampleTex(tex) ?? '';
    expect(out.startsWith(String.raw`\documentclass[11pt]{article}\usepackage{cfr-lm}`)).toBe(true);
    expect(out).toContain(String.raw`{\large Aa1}`);
    expect(out).toContain(String.raw`{\Huge\bfseries\itshape Aa1}`);
    expect(out).toContain(String.raw`{\fontfamily{cmr}\selectfont\large Aa1}`);
    expect(out).not.toContain('Body');
    // default family + cmr (named twice, sampled once): 2 x 10 sizes x 9 styles
    expect(out.match(/Aa1/g)).toHaveLength(180);
    expect(out.trimEnd().endsWith(String.raw`\end{document}`)).toBe(true);
    expect(fontSampleTex('no document here')).toBeNull();
  });
});
