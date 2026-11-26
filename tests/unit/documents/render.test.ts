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
  templateFormat,
  type RenderOptions,
  type ResumeContent,
} from '../../../src/shared/documents';
import { parseTemplate } from '../../../src/shared/latex/template';
import type { Profile } from '../../../src/shared/profile';
import {
  arbContent,
  fullContent,
  fullProfile,
  goodContent,
  seedPolicy,
  seedRules,
  seedTemplate,
  v1Rules,
  v1Template,
} from '../../fixtures/resume';

/** Template format 1 (the original seed): users who kept it get exactly the output they got before. */
const render = (c: ResumeContent = goodContent, p: Profile = fullProfile, rules = v1Rules): string =>
  renderResume(c, p, v1Template, rules, seedPolicy);
const TODAY = new Date(2026, 10, 26);
/** Template format 2 (the seed since 1.1.0). */
const render2 = (
  c: ResumeContent = fullContent,
  opts: RenderOptions = {},
  p: Profile = fullProfile,
  rules = seedRules,
): string => renderResume(c, p, seedTemplate, rules, seedPolicy, { today: TODAY, ...opts });

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

describe('renderResume (template format 1)', () => {
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
      ...v1Rules,
      sections_order: v1Rules.sections_order.filter((s) => s !== 'projects'),
      summary: { ...v1Rules.summary, enabled: false },
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
    expect(lintResume(tex, v1Rules).issues.filter((i) => i.severity === 'error')).toEqual([]);
    const ats = checkAts({ tex, jd: null, profile: fullProfile, rules: v1Rules });
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

describe('renderResume (template format 2)', () => {
  it('detects the format from the template', () => {
    expect(templateFormat(seedTemplate)).toBe(2);
    expect(templateFormat(v1Template)).toBe(1);
  });

  it('fills the header from the profile: current degree, university, location and three links', () => {
    expect(render2()).toContain(
      '\\resumeHeader{Alex Example}{BSc Computer Science}{Example University}{Berlin, Germany}{+49 000 0000000}{alex@example.test}{https://github.example.test/alex}{}{https://linkedin.example.test/in/alex}',
    );
    const p: Profile = {
      ...fullProfile,
      education: [
        {
          id: 'edu-old',
          title: 'B.Tech, CSE — Old University',
          meta: { start: '2016', end: '2020' },
          bullets: [],
        },
        {
          id: 'edu-now',
          title: 'M.Sc., Cybersecurity — Saarland University',
          meta: { start: '2026-10', end: 'present' },
          bullets: [],
        },
      ],
    };
    expect(render2(fullContent, {}, p)).toContain('{M.Sc. in Cybersecurity}{Saarland University}');
  });

  it('turns the photo on only when a photo exists and the rules allow it', () => {
    expect(render2(fullContent, { photo: true })).toMatch(/^\\resumephototrue\n\\resumeHeader/m);
    expect(render2(fullContent, { photo: false })).not.toMatch(/^\\resumephototrue$/m);
    expect(render2(fullContent, { photo: true }, fullProfile, { ...seedRules, photo: false })).not.toMatch(
      /^\\resumephototrue$/m,
    );
  });

  it('renders every section with the template macros, links and the education table', () => {
    const tex = render2();
    expect(tex).toContain('\\begin{resumeEducation}{Degree}{Institute}{CGPA/Percentage}{Year}');
    expect(tex).toContain('\\resumeEduRow{BSc Computer Science}{Example University}{1.7}{2016 -- 2020}');
    expect(tex).toContain('\\resumeEntry{Data Engineer}{Mar 2022 -- Present}{Globex}{Berlin, Germany}');
    expect(tex).toMatch(/\\end\{resumeItems\}\n\\resumeGap\n\\resumeEntry\{Analyst\}/);
    expect(tex).toContain(
      '\\resumeProject{Ledger}{Python, Docker}{Mar 2024 -- Jun 2024}{https://github.example.test/alex/ledger}',
    );
    expect(tex).toContain('\\resumePublication{Columnar storage notes}{}{2021}{https://example.test/notes}');
    expect(tex).toContain(
      '\\resumePatent{Streaming join operator}{Application No.}{DE 102023000001}{Published}{Sep 2023}',
    );
    expect(tex).toContain('\\resumeCert{Cloud Practitioner}{Example Cloud}{}');
    expect(tex).toContain('\\resumeMisc{Hackathon winner}{}{2023}');
    expect(tex).toContain('\\resumeMisc{Languages}{English (C1), German (B2)}{}');
    expect(tex).toContain('\\resumeUpdated{Last updated}{November 26, 2026}');
    expect(readResume(tex).sections.map((s) => s.heading)).toEqual([
      'Summary',
      'Education',
      'Experience',
      'Projects',
      'Publications',
      'Patents',
      'Technical Skills',
      'Certifications',
      'Miscellaneous',
    ]);
    expect(parseTemplate(tex, 'resume').diagnostics).toEqual([]);
    expect(precheckTex(tex)).toEqual([]);
  });

  it('passes truth and lint; the ATS check names the design choices honestly', () => {
    const tex = render2(fullContent, { photo: true });
    expect(checkTruth(fullContent, fullProfile, { policy: seedPolicy, jd: null }).violations).toEqual([]);
    expect(lintResume(tex, seedRules).issues.filter((i) => i.severity === 'error')).toEqual([]);
    const ats = checkAts({ tex, jd: null, profile: fullProfile, rules: seedRules });
    expect(ats.format.filter((f) => !f.ok).map((f) => f.check)).toEqual([
      'no_images',
      'no_layout_tables',
      'no_icons',
    ]);
    const summary = readResume(tex).sections.find((s) => s.heading === 'Summary');
    expect(summary?.summary).toBe(fullContent.summary);
  });

  it('a missing link, publication venue or patent number leaves no stray separator', () => {
    const p: Profile = {
      ...fullProfile,
      projects: fullProfile.projects.map((e) => ({ ...e, meta: { ...e.meta, link: '' } })),
      patents: fullProfile.patents.map((e) => ({ ...e, meta: { date: '2023-09' } })),
    };
    const tex = render2(fullContent, {}, p);
    expect(tex).toContain('\\resumeProject{Ledger}{Python, Docker}{Mar 2024 -- Jun 2024}{}');
    expect(tex).toContain('\\resumePatent{Streaming join operator}{}{}{Published}{Sep 2023}');
  });

  it('German: headings, table head, month names, "heute", skill labels and the date line', () => {
    const tex = render2(fullContent, { language: 'de' });
    expect(readResume(tex).sections.map((s) => s.heading)).toEqual([
      'Kurzprofil',
      'Ausbildung',
      'Berufserfahrung',
      'Projekte',
      'Publikationen',
      'Patente',
      'Technische Kenntnisse',
      'Zertifikate',
      'Sonstiges',
    ]);
    expect(tex).toContain('\\begin{resumeEducation}{Abschluss}{Institution}{Note}{Jahr}');
    expect(tex).toContain('{Mär 2022 -- heute}');
    expect(tex).toContain('\\skillLine{Programmiersprachen}{Python, SQL}');
    expect(tex).toContain(
      '\\resumePatent{Streaming join operator}{Anmeldenr.}{DE 102023000001}{Veröffentlicht}{Sep 2023}',
    );
    expect(tex).toContain('\\resumeMisc{Sprachen}{English (C1), German (B2)}{}');
    expect(tex).toContain('\\resumeUpdated{Stand}{26. November 2026}');
    const ats = checkAts({ tex, jd: null, profile: fullProfile, rules: seedRules, language: 'de' });
    expect(ats.format.find((f) => f.check === 'date_format')?.ok).toBe(true);
    expect(ats.format.find((f) => f.check === 'standard_headings')?.ok).toBe(true);
    expect(lintResume(tex, seedRules, 'de').issues.filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('formats German dates', () => {
    expect(formatDate('2024-03', 'MMM YYYY', 'de')).toBe('Mär 2024');
    expect(formatDate('2024-12', 'MMMM YYYY', 'de')).toBe('Dezember 2024');
    expect(formatDate('present', 'MM/YYYY', 'de')).toBe('heute');
  });

  it('any content renders to tex that passes the pre-check and keeps the slot structure', () => {
    fc.assert(
      fc.property(
        arbContent,
        fc.constantFrom<'en' | 'de'>('en', 'de'),
        fc.boolean(),
        (c, language, photo) => {
          const tex = render2(c, { language, photo });
          expect(precheckTex(tex)).toEqual([]);
          expect(parseTemplate(tex, 'resume').diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
          lintResume(tex, seedRules, language);
          checkAts({ tex, jd: null, profile: fullProfile, rules: seedRules, language });
        },
      ),
      { numRuns: 200 },
    );
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
