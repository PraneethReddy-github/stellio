import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  checkHeaderArg,
  escapeLatex,
  fillTemplate,
  OPTIONAL_SLOTS,
  parseTemplate,
  REQUIRED_SLOTS,
} from '../../../src/shared/latex/template';

const seed = (p: string): string =>
  readFileSync(new URL(`../../../seed/templates/${p}`, import.meta.url), 'utf8');
const codes = (tex: string): string[] => parseTemplate(tex).diagnostics.map((d) => d.code);

describe('parseTemplate', () => {
  it.each(['resume', 'cover-letter'] as const)(
    'seed %s.tex has every required slot, no diagnostics',
    (kind) => {
      const p = parseTemplate(seed(`${kind}.tex`), kind);
      expect(p.diagnostics).toEqual([]);
      const names = p.slots.map((s) => s.name);
      expect(names).toEqual(expect.arrayContaining([...REQUIRED_SLOTS[kind]]));
      expect(names.filter((n) => !REQUIRED_SLOTS[kind].includes(n))).toEqual(OPTIONAL_SLOTS[kind]);
    },
  );

  it('reports slot lines and content', () => {
    const tex = 'a\n%% STELLIO:SLOT x\nfoo\nbar\n%% STELLIO:END x\nz';
    expect(parseTemplate(tex).slots).toEqual([{ name: 'x', startLine: 2, endLine: 5, content: 'foo\nbar' }]);
  });

  it('lists macros and environments', () => {
    const p = parseTemplate(seed('resume.tex'));
    expect(p.macros).toEqual(
      expect.arrayContaining([
        'resumeHeader',
        'resumeEntry',
        'resumeItem',
        'skillLine',
        'resumeSummary',
        'resumeProject',
        'resumeEduRow',
        'resumePublication',
        'resumePatent',
        'resumeCert',
        'resumeMisc',
        'resumeUpdated',
      ]),
    );
    expect(p.environments).toEqual([
      'resumeEducation',
      'resumeEntries',
      'resumeExperience',
      'resumeItems',
      'resumeSkills',
      'resumeCerts',
      'resumeMiscList',
    ]);
    expect(parseTemplate('% \\newcommand{\\nope}{}\n\\def\\yes{1}').macros).toEqual(['yes']);
  });

  it('flags unclosed, duplicate, nested and mismatched slots with lines', () => {
    expect(parseTemplate('%% STELLIO:SLOT a\nx').diagnostics).toEqual([
      expect.objectContaining({ code: 'slot_unclosed', line: 1, severity: 'error' }),
    ]);
    expect(codes('%% STELLIO:SLOT a\n%% STELLIO:END a\n%% STELLIO:SLOT a\n%% STELLIO:END a')).toEqual([
      'slot_duplicate',
    ]);
    const nested = parseTemplate('%% STELLIO:SLOT a\n%% STELLIO:SLOT b\n%% STELLIO:END b\n%% STELLIO:END a');
    expect(nested.diagnostics[0]).toMatchObject({ code: 'slot_nested', line: 2 });
    expect(codes('%% STELLIO:SLOT a\n%% STELLIO:END b')).toContain('slot_mismatch');
    expect(parseTemplate('%% STELLIO:END a').diagnostics[0]).toMatchObject({
      code: 'slot_end_without_start',
      line: 1,
    });
    expect(codes('%% STELLIO:SLOT Bad\n%% STELLIO:END Bad')).toContain('slot_name_invalid');
  });

  it('flags missing required slots and warns on unknown ones', () => {
    const p = parseTemplate(
      '%% STELLIO:SLOT header\n%% STELLIO:END header\n%% STELLIO:SLOT zzz\n%% STELLIO:END zzz',
      'cover-letter',
    );
    expect(p.diagnostics.filter((d) => d.code === 'slot_missing')).toHaveLength(3);
    expect(p.diagnostics.find((d) => d.code === 'slot_unknown')).toMatchObject({
      severity: 'warning',
      line: 3,
    });
  });
});

describe('fillTemplate', () => {
  const tex = seed('resume.tex');

  it('replaces only the named slot body and keeps the markers', () => {
    const out = fillTemplate(tex, { summary: '\\resumeSummary{Hello.}' });
    const p = parseTemplate(out, 'resume');
    expect(p.diagnostics).toEqual([]);
    expect(p.slots.find((s) => s.name === 'summary')?.content).toBe('\\resumeSummary{Hello.}');
    expect(p.slots.find((s) => s.name === 'skills')?.content).toBe(
      parseTemplate(tex).slots.find((s) => s.name === 'skills')?.content,
    );
  });

  it('empty string omits the section', () => {
    const out = fillTemplate(tex, { projects: '' });
    expect(out).not.toContain('\\section{Projects}');
    expect(out).toContain('\\section{Experience}');
    expect(parseTemplate(out, 'resume').diagnostics).toEqual([]);
  });

  it('drops marker-like lines from content so structure survives', () => {
    const out = fillTemplate(tex, { summary: 'a\n%% STELLIO:END summary\nb' });
    expect(parseTemplate(out, 'resume').diagnostics).toEqual([]);
  });

  it('keeps CRLF line endings', () => {
    const out = fillTemplate(tex.replace(/\n/g, '\r\n'), { summary: 'x' });
    expect(out.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('filling with the current contents is the identity', () => {
    for (const f of ['resume.tex', 'cover-letter.tex']) {
      const t = seed(f);
      const own = Object.fromEntries(parseTemplate(t).slots.map((s) => [s.name, s.content]));
      expect(fillTemplate(t, own)).toBe(t);
    }
  });

  it('property: text outside the slots is preserved for any contents', () => {
    const outside = (t: string): string => {
      const lines = t.split('\n');
      const drop = new Set<number>();
      for (const s of parseTemplate(t).slots) for (let i = s.startLine; i < s.endLine - 1; i++) drop.add(i);
      return lines.filter((_, i) => !drop.has(i)).join('\n');
    };
    fc.assert(
      fc.property(fc.dictionary(fc.constantFrom(...REQUIRED_SLOTS.resume), fc.string()), (contents) => {
        const out = fillTemplate(tex, contents);
        expect(outside(out)).toBe(outside(tex));
        expect(parseTemplate(out, 'resume').diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
      }),
    );
  });
});

describe('escapeLatex', () => {
  it('escapes the special characters', () => {
    expect(escapeLatex('& % $ # _ { } ~ ^ \\')).toBe(
      '\\& \\% \\$ \\# \\_ \\{ \\} \\textasciitilde{} \\textasciicircum{} \\textbackslash{}',
    );
  });

  it('keeps Latin text, maps typographic characters to engine-neutral ASCII, drops what no engine can set', () => {
    expect(escapeLatex('C++ Zoë München')).toBe('C++ Zoë München');
    // Letters Tectonic's T1 fonts cannot place by code point become LaTeX commands (both engines know them).
    expect(escapeLatex('Straße, Grüßen, Dvořák, Łódź, Kőbánya, ÿ')).toBe(
      String.raw`Stra\ss{}e, Grü\ss{}en, Dvo\v{r}ák, \L{}ód\'{z}, K\H{o}bánya, \"{y}`,
    );
    expect(escapeLatex('a — b – c')).toBe('a --- b -- c');
    expect(escapeLatex('ﬁle ﬂow oﬀer eﬃcient baﬄe ﬅﬆ')).toBe('file flow offer efficient baffle stst');
    expect(escapeLatex('“q” it’s …')).toBe("``q'' it's ...");
    expect(escapeLatex('a\u200Bb\u0007c')).toBe('abc');
    expect(escapeLatex('5\u22123 你')).toBe('5-3 ');
  });

  it('property: no special character survives unescaped', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (s) => {
        const rest = escapeLatex(s)
          .replace(/\\(?:textbackslash|textasciitilde|textasciicircum|ss|DJ|dj|i|L|l|NG|ng|OE|oe)\{\}/g, '')
          .replace(/\\[`'^~=u."rHvck]\{[A-Za-z]\}/g, '')
          .replace(/\\[&%$#_{}]/g, '');
        expect(rest).not.toMatch(/[\\&%$#_{}^]/);
      }),
    );
  });
});

describe('checkHeaderArg', () => {
  it('passes real emails and URLs raw', () => {
    for (const v of [
      'alex_example@example.com',
      'https://github.com/alex_example/my_portfolio?ref=a_b&x=1',
      'https://x.org/~alex_e/a_b',
    ])
      expect(checkHeaderArg(v)).toEqual({ ok: true, value: v });
  });

  it('rejects % and #, newlines and unbalanced braces', () => {
    for (const v of ['https://a.b/#frag', 'a%20b', 'a\nb', 'a{b', 'a}b'])
      expect(checkHeaderArg(v).ok).toBe(false);
  });
});

describe('optional slots', () => {
  it('a format 2 slot in a resume template is known; an unknown slot is still a warning', () => {
    const tex = (extra: string) =>
      [...REQUIRED_SLOTS.resume, extra].map((n) => `%% STELLIO:SLOT ${n}\n%% STELLIO:END ${n}`).join('\n');
    expect(parseTemplate(tex('patents'), 'resume').diagnostics).toEqual([]);
    expect(parseTemplate(tex('hobbies'), 'resume').diagnostics.map((d) => d.code)).toEqual(['slot_unknown']);
  });
});
