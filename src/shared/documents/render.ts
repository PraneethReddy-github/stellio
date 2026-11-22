import { DENY_GROUP, norm } from '../latex/deny';
import { checkHeaderArg, escapeLatex, fillTemplate } from '../latex/template';
import { matchesSkill, type Entry, type Profile } from '../profile';
import type { ResumeRules, SkillsPolicy } from '../rules';
import type { ResumeContent } from './schemas';

export const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** "2022-03" / "2022" / "present" in the rules' date format. Anything else is returned as written. */
export function formatDate(raw: string, format: ResumeRules['date_format']): string {
  const s = raw.trim();
  if (/^(present|now|current|today)$/i.test(s)) return 'Present';
  const m = /^(\d{4})(?:[-/.](\d{1,2}))?/.exec(s);
  if (!m) return s;
  const year = m[1] ?? '';
  const month = Number(m[2]);
  if (!m[2] || month < 1 || month > 12) return year;
  const mm = String(month).padStart(2, '0');
  const name = MONTHS[month - 1] ?? '';
  switch (format) {
    case 'MMM YYYY':
      return `${name.slice(0, 3)} ${year}`;
    case 'MMMM YYYY':
      return `${name} ${year}`;
    case 'MM/YYYY':
      return `${mm}/${year}`;
    case 'YYYY-MM':
      return `${year}-${mm}`;
  }
}

/** Start/end of an entry from `start`/`end`, `dates: a – b`, or a single `date`. */
export function entryRange(e: Entry): { start: string; end: string } {
  const { start, end, dates, date } = e.meta;
  if (start || end) return { start: start ?? '', end: end ?? '' };
  if (dates) {
    const [a = '', b = ''] = dates.split(/\s+(?:[–—-]|to)\s+|\s*[–—]\s*/);
    return { start: a.trim(), end: b.trim() };
  }
  return { start: date ?? '', end: '' };
}

/** "Jan 2024 – Present", "May 2024" or "" (escaped later: – becomes --). */
export function entryDates(e: Entry, format: ResumeRules['date_format']): string {
  const { start, end } = entryRange(e);
  const parts = [start, end].filter((p) => p.trim() !== '').map((p) => formatDate(p, format));
  return parts.join(' – ');
}

/** Sort key: later end first (present = latest), then later start. */
function recency(e: Entry): string {
  const { start, end } = entryRange(e);
  const key = (s: string): string => {
    if (/^(present|now|current|today)$/i.test(s.trim())) return '9999-99';
    const m = /^(\d{4})(?:[-/.](\d{1,2}))?/.exec(s.trim());
    return m ? `${m[1] ?? ''}-${(m[2] ?? '00').padStart(2, '0')}` : '0000-00';
  };
  return `${key(end || start)}|${key(start)}`;
}

/** "Data Engineer — Globex" → ["Data Engineer", "Globex"]; no separator → [title, meta fallback]. */
export function splitTitle(e: Entry, fallbackKey: string): [string, string] {
  const parts = e.title.split(/\s+[—–]\s+/);
  if (parts.length >= 2) return [parts.slice(0, -1).join(' — '), parts.at(-1) ?? ''];
  return [e.title, e.meta[fallbackKey] ?? ''];
}

const URL_SAFE = /^[A-Za-z0-9\-._~:/?=&+@!*,;()']*$/;
const EMAIL_SAFE = /^[A-Za-z0-9.+_-]+@[A-Za-z0-9.-]+$/;
/**
 * Header arguments are printed raw (docs/06 §7). Beyond checkHeaderArg, only plain URL/email characters pass,
 * so a profile value can never smuggle a TeX command or a non-http link into the compile; anything else is ''.
 */
export function headerArg(value: string, kind: 'url' | 'email'): string {
  const v = value.trim();
  if (v === '' || !checkHeaderArg(v).ok) return '';
  if (kind === 'email') return EMAIL_SAFE.test(v) ? v : '';
  return URL_SAFE.test(v) && /^https?:\/\//i.test(v) ? v : '';
}

/** The pre-check rejects a group that spells a file primitive (`{input}`); a leading `{}` keeps the text intact. */
export const arg = (x: string): string => {
  const word = /^\s*([A-Za-z@]+\*?)\s*$/.exec(x)?.[1];
  return `{${word !== undefined && DENY_GROUP.has(norm(word)) ? `{}${x}` : x}}`;
};
export const args = (...a: string[]): string => a.map(arg).join('');

function items(bullets: { text: string }[]): string[] {
  const lines = bullets.map((b) => b.text.trim()).filter((t) => t !== '');
  if (lines.length === 0) return [];
  return [
    '\\begin{resumeItems}',
    ...lines.map((t) => `  \\resumeItem${arg(escapeLatex(t))}`),
    '\\end{resumeItems}',
  ];
}

/** Entries the content selects, deduplicated, existing in `pool`. Unknown ids are skipped (truth flags them). */
function pick<T extends { entry_id: string }>(
  list: T[],
  pool: Entry[],
): { item: T; entry: Entry; index: number }[] {
  const seen = new Set<string>();
  const out: { item: T; entry: Entry; index: number }[] = [];
  list.forEach((item, index) => {
    const entry = pool.find((e) => e.id === item.entry_id);
    if (!entry || seen.has(entry.id)) return;
    seen.add(entry.id);
    out.push({ item, entry, index });
  });
  return out;
}

const byRecency = (a: { entry: Entry }, b: { entry: Entry }): number =>
  recency(b.entry).localeCompare(recency(a.entry));

/**
 * The entries of each section in printed order, with their index in `content`: roles and education sorted
 * reverse-chronologically, projects as given; unknown and repeated ids dropped.
 */
export function renderedOrder(content: ResumeContent, profile: Profile) {
  return {
    experience: pick(content.experience, profile.experience).sort(byRecency),
    projects: pick(content.projects, profile.projects),
    education: pick(content.education, profile.education).sort(byRecency),
  };
}

/**
 * Builds the resume .tex from structured content (D21). Pure. Every model-written string is escaped; facts
 * (employers, titles, dates, locations, degrees, institutions, contact details) come from the profile.
 */
export function renderResume(
  content: ResumeContent,
  profile: Profile,
  template: string,
  rules: ResumeRules,
  policy?: Pick<SkillsPolicy, 'learning_label'>,
): string {
  const fmt = rules.date_format;
  const on = (s: ResumeRules['sections_order'][number]): boolean => rules.sections_order.includes(s);
  const esc = escapeLatex;
  const f = profile.frontMatter;
  const slots: Record<string, string> = {};

  slots.header = `\\resumeHeader${args(
    esc(f.name),
    esc(f.location),
    headerArg(f.email, 'email'),
    esc(f.phone),
    headerArg(f.links.linkedin, 'url'),
    headerArg(f.links.github || f.links.portfolio, 'url'),
  )}`;

  const summary = content.summary?.trim() ?? '';
  slots.summary =
    on('summary') && rules.summary.enabled && summary !== '' ? `\\resumeSummary${arg(esc(summary))}` : '';

  const order = renderedOrder(content, profile);
  const roles = order.experience;
  slots.experience =
    on('experience') && roles.length > 0
      ? [
          '\\section{Experience}',
          ...roles.flatMap(({ item, entry }) => {
            const [title, org] = splitTitle(entry, 'company');
            return [
              `\\resumeEntry${args(esc(title), esc(entryDates(entry, fmt)), esc(org), esc(entry.meta.location ?? ''))}`,
              ...items(item.bullets),
            ];
          }),
        ].join('\n')
      : '';

  const projects = order.projects;
  slots.projects =
    on('projects') && projects.length > 0
      ? [
          '\\section{Projects}',
          ...projects.flatMap(({ item, entry }) => [
            `\\resumeProject${args(esc(entry.title), esc(entry.meta.stack ?? ''), esc(entryDates(entry, fmt)))}`,
            ...items(item.bullets),
          ]),
        ].join('\n')
      : '';

  const schools = order.education;
  slots.education =
    on('education') && schools.length > 0
      ? [
          '\\section{Education}',
          ...schools.flatMap(({ item, entry }) => {
            const [degree, school] = splitTitle(entry, 'institution');
            return [
              `\\resumeEntry${args(esc(degree), esc(entryDates(entry, fmt)), esc(school), esc(entry.meta.location ?? ''))}`,
              ...items(item.bullets),
            ];
          }),
        ].join('\n')
      : '';

  const certs = pick(content.certifications, profile.certifications);
  slots.certifications =
    on('certifications') && certs.length > 0
      ? [
          '\\section{Certifications}',
          ...certs.map(({ entry }) => {
            const [name, issuer] = splitTitle(entry, 'issuer');
            return `\\resumeEntry${args(esc(name), esc(entryDates(entry, fmt)), esc(issuer), '')}`;
          }),
        ].join('\n')
      : '';

  const label = policy?.learning_label ?? '(learning)';
  const skillLines = content.skills
    .map((line) => ({
      label: line.category_label.trim(),
      skills: line.skills
        .map((s) => s.trim())
        .filter((s) => s !== '')
        .map((s) => {
          const row = profile.skills.find((r) => matchesSkill(r, s));
          return row?.status === 'learning' ? `${s} ${label}` : s;
        }),
    }))
    .filter((l) => l.skills.length > 0);
  slots.skills =
    on('skills') && skillLines.length > 0
      ? [
          '\\section{Skills}',
          ...skillLines.map((l) => `\\skillLine${args(esc(l.label), esc(l.skills.join(', ')))}`),
        ].join('\n')
      : '';

  return fillTemplate(template, slots);
}
