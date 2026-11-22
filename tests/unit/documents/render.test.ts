import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { precheckTex } from '../../../src/main/services/latex/precheck';
import {
  checkAts,
  checkTruth,
  formatDate,
  lintResume,
  readResume,
  renderResume,
  type ResumeContent,
} from '../../../src/shared/documents';
import { parseTemplate } from '../../../src/shared/latex/template';
import type { Profile } from '../../../src/shared/profile';
import {
  arbContent,
  fullProfile,
  goodContent,
  seedPolicy,
  seedRules,
  seedTemplate,
} from '../../fixtures/resume';

const render = (c: ResumeContent = goodContent, p: Profile = fullProfile, rules = seedRules): string =>
  renderResume(c, p, seedTemplate, rules, seedPolicy);

describe('formatDate', () => {
  it('formats YYYY-MM per rules and keeps Present and bare years', () => {
    expect(formatDate('2022-03', 'MMM YYYY')).toBe('Mar 2022');
    expect(formatDate('2022-03', 'MMMM YYYY')).toBe('March 2022');
    expect(formatDate('2022-3', 'MM/YYYY')).toBe('03/2022');
    expect(formatDate('2022-03', 'YYYY-MM')).toBe('2022-03');
    expect(formatDate('present', 'MMM YYYY')).toBe('Present');
    expect(formatDate('2023', 'MMM YYYY')).toBe('2023');
  });
});

describe('renderResume', () => {
  it('fills employers, titles, dates and locations from the profile, roles reverse-chronological', () => {
    const tex = render();
    expect(tex).toContain('\\resumeEntry{Data Engineer}{Mar 2022 -- Present}{Globex}{Berlin, Germany}');
    expect(tex).toContain('\\resumeEntry{Analyst}{Jun 2020 -- Feb 2022}{Initrode}{Hamburg, Germany}');
    expect(tex.indexOf('{Globex}')).toBeLessThan(tex.indexOf('{Initrode}')); // content listed Initrode first
    expect(tex).toContain('\\resumeProject{Ledger}{Python, Docker}{Mar 2024 -- Jun 2024}');
    expect(tex).toContain('\\resumeEntry{BSc Computer Science}{Sep 2016 -- Jun 2020}{Example University}{}');
    expect(tex).toContain('\\resumeEntry{Cloud Practitioner}{May 2024}{Example Cloud}{}');
    expect(tex).toContain(
      '\\resumeHeader{Alex Example}{Berlin, Germany}{alex@example.test}{+49 000 0000000}{https://linkedin.example.test/in/alex}{https://github.example.test/alex}',
    );
    expect(tex).toContain('\\skillLine{Languages}{Python, SQL}');
    expect(parseTemplate(tex, 'resume').diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(precheckTex(tex)).toEqual([]);
  });

  it('ignores model-supplied facts: unknown ids are skipped, duplicates rendered once', () => {
    const tex = render({
      ...goodContent,
      experience: [
        { entry_id: 'exp-invented', bullets: [{ text: 'Ran Mars base', source_ids: [] }] },
        { entry_id: 'exp-globex', bullets: [] },
        { entry_id: 'exp-globex', bullets: [] },
      ],
    });
    expect(tex).not.toContain('Mars');
    expect(tex.match(/\{Globex\}/g)).toHaveLength(1);
  });

  it('escapes model text and empties sections with no content', () => {
    const tex = render({
      ...goodContent,
      summary: null,
      projects: [],
      certifications: [],
      experience: [
        {
          entry_id: 'exp-globex',
          bullets: [{ text: 'Saved 50% & $10k_on \\input{x} — fast', source_ids: [] }],
        },
      ],
    });
    expect(tex).toContain('\\resumeItem{Saved 50\\% \\& \\$10k\\_on \\textbackslash{}input\\{x\\} --- fast}');
    expect(tex).not.toContain('\\section{Projects}');
    expect(tex).not.toContain('\\section{Certifications}');
    expect(tex).not.toMatch(/^\\resumeSummary/m);
    expect(precheckTex(tex)).toEqual([]);
  });

  it('omits sections the rules leave out, and the summary when disabled', () => {
    const rules = {
      ...seedRules,
      sections_order: seedRules.sections_order.filter((s) => s !== 'projects'),
      summary: { ...seedRules.summary, enabled: false },
    };
    const tex = render(goodContent, fullProfile, rules);
    expect(tex).not.toContain('\\section{Projects}');
    expect(tex).not.toMatch(/^\\resumeSummary/m);
  });

  it('labels learning skills when the policy allows them', () => {
    const tex = render({ ...goodContent, skills: [{ category_label: 'Tools', skills: ['Docker'] }] });
    expect(tex).toContain('\\skillLine{Tools}{Docker (learning)}');
  });

  it('drops unsafe header values instead of passing them to TeX', () => {
    const p: Profile = {
      ...fullProfile,
      frontMatter: {
        ...fullProfile.frontMatter,
        email: 'a\\input{/etc/passwd}@x.test',
        links: { linkedin: 'javascript:alert(1)', github: 'https://x.test/{input}', portfolio: '' },
      },
    };
    const tex = render(goodContent, p);
    expect(tex).toContain('\\resumeHeader{Alex Example}{Berlin, Germany}{}{+49 000 0000000}{}{}');
    expect(precheckTex(tex)).toEqual([]);
  });

  it('a lone word that spells a file primitive stays harmless', () => {
    const tex = render({ ...goodContent, skills: [{ category_label: 'Read', skills: ['input'] }] });
    expect(precheckTex(tex)).toEqual([]);
  });

  it('the rendered sample passes truth, lint and the format checks', () => {
    const tex = render();
    expect(checkTruth(goodContent, fullProfile, { policy: seedPolicy, jd: null })).toEqual({
      ok: true,
      violations: [],
      warnings: [],
    });
    expect(lintResume(tex, seedRules).issues.filter((i) => i.severity === 'error')).toEqual([]);
    const ats = checkAts({ tex, jd: null, profile: fullProfile, rules: seedRules });
    expect(ats.format.filter((f) => !f.ok)).toEqual([]);
    expect(readResume(tex).sections.map((s) => s.heading)).toEqual([
      'Summary',
      'Experience',
      'Projects',
      'Skills',
      'Education',
      'Certifications',
    ]);
  });
});

describe('renderResume properties', () => {
  it('any content renders to tex that passes the pre-check and keeps the slot structure', () => {
    fc.assert(
      fc.property(arbContent, (c) => {
        const tex = render(c);
        expect(precheckTex(tex)).toEqual([]);
        expect(parseTemplate(tex, 'resume').diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
        // the checks never throw on it
        lintResume(tex, seedRules);
        checkAts({ tex, jd: null, profile: fullProfile, rules: seedRules });
        checkTruth(c, fullProfile, { policy: seedPolicy, jd: null });
      }),
      { numRuns: 300 },
    );
  });

  it('employers and dates always come from the profile', () => {
    fc.assert(
      fc.property(arbContent, (c) => {
        const doc = readResume(render(c));
        const exp = doc.sections.find((s) => s.heading === 'Experience');
        for (const e of exp?.entries ?? []) expect(['Data Engineer', 'Analyst']).toContain(e.title);
        for (const e of exp?.entries ?? [])
          expect(['Mar 2022 – Present', 'Jun 2020 – Feb 2022']).toContain(e.dates);
      }),
      { numRuns: 200 },
    );
  });
});
