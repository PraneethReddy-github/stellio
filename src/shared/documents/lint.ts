import type { Profile } from '../profile';
import { RESUME_SECTIONS, type ResumeRules } from '../rules';
import { renderedOrder } from './render';
import type { LintIssue, LintReport, ResumeContent } from './schemas';
import { readResume } from './texread';

type Section = (typeof RESUME_SECTIONS)[number];
const HEADINGS: Record<string, Section> = {
  summary: 'summary',
  experience: 'experience',
  'work experience': 'experience',
  'professional experience': 'experience',
  projects: 'projects',
  skills: 'skills',
  'technical skills': 'skills',
  education: 'education',
  certifications: 'certifications',
};
export const sectionOf = (heading: string): Section | undefined => HEADINGS[heading.trim().toLowerCase()];

/** First words that show a bullet does not start with an action verb. */
const NOT_VERBS = new Set(
  'a an the i my me we our us this that these those it its was were is are be been being has have had very various successfully also and as for in on with to of from by at responsible duties tasks'.split(
    ' ',
  ),
);
export const FIRST_PERSON =
  /(?<![\p{L}'])(I|[Mm]e|[Mm]y|[Mm]ine|[Ww]e|[Oo]ur|[Oo]urs|[Mm]yself)(?![\p{L}'])/u;

export const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const words = (s: string): number => s.split(/\s+/).filter(Boolean).length;

/**
 * Rules lint over the rendered .tex (docs/06 §6): section presence and order, role/project/bullet counts, bullet
 * length, verb-first, banned words, first person, summary length and skills limits. Works on hand-edited tex
 * that keeps the template macros. Pure.
 */
export function lintResume(tex: string, rules: ResumeRules): LintReport {
  const issues: LintIssue[] = [];
  const add = (rule: string, severity: LintIssue['severity'], message: string, path: string | null): void => {
    issues.push({ rule, severity, message, path });
  };
  const doc = readResume(tex);
  const present = new Map<Section, (typeof doc.sections)[number]>();
  if (doc.hasHeader) present.set('header', { heading: '', entries: [], summary: null, skillLines: [] });
  for (const s of doc.sections) {
    const known = sectionOf(s.heading);
    if (known) present.set(known, s);
    else if (s.heading !== '')
      add('section_heading', 'warning', `"${s.heading}" is not a standard section heading`, null);
  }

  for (const req of rules.sections_required)
    if (!present.has(req)) add('sections_required', 'error', `Required section "${req}" is missing`, req);
  const order = [...present.keys()];
  const expected = rules.sections_order.filter((s) => present.has(s));
  if (order.some((s, i) => s !== expected[i]))
    add(
      'sections_order',
      'warning',
      `Sections are in the order ${order.join(', ')}; the rules ask for ${expected.join(', ')}`,
      null,
    );

  const banned = rules.banned_words.map((w) => ({
    w,
    re: new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(w)}(?![\\p{L}\\p{N}])`, 'iu'),
  }));
  const prose = (text: string, path: string): void => {
    for (const b of banned)
      if (b.re.test(text)) add('banned_words', 'error', `Uses the banned word "${b.w}"`, path);
    if (!rules.first_person) {
      const m = FIRST_PERSON.exec(text);
      if (m) add('first_person', 'error', `Uses first person ("${m[1] ?? ''}")`, path);
    }
  };
  const bullet = (text: string, path: string): void => {
    const len = text.length;
    if (len > rules.bullet.max_chars)
      add(
        'bullet_length',
        'error',
        `Bullet is ${String(len)} characters; the maximum is ${String(rules.bullet.max_chars)}`,
        path,
      );
    else if (len < rules.bullet.min_chars)
      add(
        'bullet_length',
        'warning',
        `Bullet is ${String(len)} characters; the minimum is ${String(rules.bullet.min_chars)}`,
        path,
      );
    if (rules.bullet.must_start_with_verb) {
      const first = /^[\p{L}][\p{L}'-]*/u.exec(text)?.[0] ?? '';
      if (first === '' || NOT_VERBS.has(first.toLowerCase()) || first[0] !== first[0]?.toUpperCase())
        add(
          'verb_first',
          'warning',
          `Bullet should start with an action verb ("${text.slice(0, 30)}")`,
          path,
        );
    }
    prose(text, path);
  };
  const counts = (
    section: 'experience' | 'projects',
    range: { min: number; max: number },
    maxEntries: number,
    firstMax?: number,
  ): void => {
    const s = present.get(section);
    if (!s) return;
    if (s.entries.length > maxEntries)
      add(
        section === 'experience' ? 'max_roles' : 'max_projects',
        'error',
        `${String(s.entries.length)} ${section} entries; the maximum is ${String(maxEntries)}`,
        section,
      );
    s.entries.forEach((e, i) => {
      const path = `${section}[${String(i)}]`;
      const max = i === 0 && firstMax !== undefined ? firstMax : range.max;
      const n = e.bullets.length;
      if (n > max)
        add(
          'bullets_per_entry',
          'error',
          `"${e.title}" has ${String(n)} bullets; the maximum is ${String(max)}`,
          path,
        );
      // A role kept as a one-line entry (no bullets) is allowed by the rules.
      else if (n > 0 && n < range.min)
        add(
          'bullets_per_entry',
          'warning',
          `"${e.title}" has ${String(n)} bullets; the minimum is ${String(range.min)}`,
          path,
        );
      e.bullets.forEach((b, j) => {
        bullet(b, `${path}.bullets[${String(j)}]`);
      });
    });
  };
  counts(
    'experience',
    rules.experience.bullets_per_role,
    rules.experience.max_roles,
    rules.experience.most_recent_role_bullets_max,
  );
  counts('projects', rules.projects.bullets_per_project, rules.projects.max);
  present.get('education')?.entries.forEach((e, i) => {
    e.bullets.forEach((b, j) => {
      prose(b, `education[${String(i)}].bullets[${String(j)}]`);
    });
  });

  const summary = present.get('summary')?.summary ?? null;
  if (summary !== null) {
    if (!rules.summary.enabled) add('summary', 'error', 'The rules turn the summary off', 'summary');
    else if (words(summary) > rules.summary.max_words)
      add(
        'summary_words',
        'error',
        `Summary has ${String(words(summary))} words; the maximum is ${String(rules.summary.max_words)}`,
        'summary',
      );
    prose(summary, 'summary');
  }

  const skills = present.get('skills');
  if (skills) {
    if (skills.skillLines.length > rules.skills_section.max_lines)
      add(
        'skills_lines',
        'error',
        `${String(skills.skillLines.length)} skill lines; the maximum is ${String(rules.skills_section.max_lines)}`,
        'skills',
      );
    const total = skills.skillLines.reduce((n, l) => n + l.skills.length, 0);
    if (total > rules.skills_section.max_skills)
      add(
        'skills_count',
        'error',
        `${String(total)} skills listed; the maximum is ${String(rules.skills_section.max_skills)}`,
        'skills',
      );
    skills.skillLines.forEach((l, i) => {
      prose(`${l.label} ${l.skills.join(' ')}`, `skills[${String(i)}]`);
    });
  }

  return { ok: !issues.some((i) => i.severity === 'error'), issues };
}

/**
 * Lint of a drafted version: `lintResume` over its rendered tex with every path mapped back to `content` (the
 * renderer sorts roles by date and drops empty bullets and skill lines) and the entry id and title in entry
 * messages, so a repair round edits the right bullet. Adds content-only warnings: an entry selected twice (only
 * the first is shown) and an entry both selected and listed in `omitted`.
 */
export function lintContent(
  tex: string,
  rules: ResumeRules,
  content: ResumeContent,
  profile: Profile,
): LintReport {
  const report = lintResume(tex, rules);
  const order = renderedOrder(content, profile);
  const lines = content.skills.flatMap((l, i) => (l.skills.some((x) => x.trim() !== '') ? [i] : []));
  const issues = report.issues.map((issue) => {
    const m = /^(experience|projects|education)\[(\d+)\](?:\.bullets\[(\d+)\])?$/.exec(issue.path ?? '');
    if (!m) {
      const sk = /^skills\[(\d+)\]$/.exec(issue.path ?? '');
      const line = sk ? lines[Number(sk[1])] : undefined;
      return line === undefined ? issue : { ...issue, path: `skills[${String(line)}]` };
    }
    const section = m[1] as 'experience' | 'projects' | 'education';
    const hit = order[section][Number(m[2])];
    if (!hit) return issue;
    let path = `${section}[${String(hit.index)}]`;
    if (m[3] !== undefined) {
      const kept = hit.item.bullets.flatMap((b, j) => (b.text.trim() !== '' ? [j] : []));
      path += `.bullets[${String(kept[Number(m[3])] ?? Number(m[3]))}]`;
    }
    return { ...issue, path, message: `${hit.entry.id} ("${hit.entry.title}"): ${issue.message}` };
  });

  const used = new Set<string>();
  for (const section of ['experience', 'projects', 'education', 'certifications'] as const) {
    const seen = new Set<string>();
    content[section].forEach((item, i) => {
      used.add(item.entry_id);
      if (seen.has(item.entry_id))
        issues.push({
          rule: 'duplicate_entry',
          severity: 'warning',
          message: `"${item.entry_id}" is selected more than once; only the first is shown`,
          path: `${section}[${String(i)}]`,
        });
      seen.add(item.entry_id);
    });
  }
  content.omitted.forEach((o, i) => {
    if (used.has(o.id))
      issues.push({
        rule: 'omitted_but_used',
        severity: 'warning',
        message: `"${o.id}" is listed as omitted but is on the resume`,
        path: `omitted[${String(i)}]`,
      });
  });
  return { ok: !issues.some((i) => i.severity === 'error'), issues };
}
