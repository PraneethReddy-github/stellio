import { DENY_GROUP, norm } from '../latex/deny';
import { checkHeaderArg, escapeLatex, fillTemplate } from '../latex/template';
import { matchesSkill, type Entry, type Profile } from '../profile';
import type { ResumeRules, SkillsPolicy } from '../rules';
import { RESUME_LABELS, categoryLabel } from './labels';
import type { DocLanguage, ResumeContent } from './schemas';

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

export const MONTHS_DE = [
  'Januar',
  'Februar',
  'März',
  'April',
  'Mai',
  'Juni',
  'Juli',
  'August',
  'September',
  'Oktober',
  'November',
  'Dezember',
];
/** Three-letter German month names as used in German CVs ("Mär 2024"). */
export const MONTHS_DE_SHORT = [
  'Jan',
  'Feb',
  'Mär',
  'Apr',
  'Mai',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Okt',
  'Nov',
  'Dez',
];
export const PRESENT: Record<DocLanguage, string> = { en: 'Present', de: 'heute' };

/** "2022-03" / "2022" / "present" in the rules' date format. Anything else is returned as written. */
export function formatDate(
  raw: string,
  format: ResumeRules['date_format'],
  lang: DocLanguage = 'en',
): string {
  const s = raw.trim();
  if (/^(present|now|current|today)$/i.test(s)) return PRESENT[lang];
  const m = /^(\d{4})(?:[-/.](\d{1,2}))?/.exec(s);
  if (!m) return s;
  const year = m[1] ?? '';
  const month = Number(m[2]);
  if (!m[2] || month < 1 || month > 12) return year;
  const mm = String(month).padStart(2, '0');
  const name = (lang === 'de' ? MONTHS_DE : MONTHS)[month - 1] ?? '';
  switch (format) {
    case 'MMM YYYY':
      return `${lang === 'de' ? (MONTHS_DE_SHORT[month - 1] ?? '') : name.slice(0, 3)} ${year}`;
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
export function entryDates(e: Entry, format: ResumeRules['date_format'], lang: DocLanguage = 'en'): string {
  const { start, end } = entryRange(e);
  const parts = [start, end].filter((p) => p.trim() !== '').map((p) => formatDate(p, format, lang));
  return parts.join(' – ');
}

/** Years only: "2021 – 2025", "2026 – Present", "2019". */
export function entryYears(e: Entry, lang: DocLanguage = 'en'): string {
  const { start, end } = entryRange(e);
  const year = (s: string): string => {
    if (/^(present|now|current|today)$/i.test(s.trim())) return PRESENT[lang];
    return /^(\d{4})/.exec(s.trim())?.[1] ?? s.trim();
  };
  return [start, end]
    .filter((p) => p.trim() !== '')
    .map(year)
    .join(' – ');
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
 * reverse-chronologically, projects, publications and patents as given; unknown and repeated ids dropped.
 */
export function renderedOrder(content: ResumeContent, profile: Profile) {
  return {
    experience: pick(content.experience, profile.experience).sort(byRecency),
    projects: pick(content.projects, profile.projects),
    education: pick(content.education, profile.education).sort(byRecency),
    publications: pick(content.publications, profile.publications),
    patents: pick(content.patents, profile.patents),
  };
}

/** Template format: 2 when the template says `%% STELLIO:FORMAT 2`, else 1 (the original seed's macros). */
export const templateFormat = (template: string): 1 | 2 =>
  /^%%\s*STELLIO:FORMAT\s+2\s*$/m.test(template) ? 2 : 1;

export interface RenderOptions {
  language?: DocLanguage;
  /** A photo file exists (templates/photo.jpg); shown when the rules also say `photo: true`. */
  photo?: boolean;
  /** Date printed as "Last updated"; default now. */
  today?: Date;
}

const excluded = (e: Entry): boolean => /^(true|yes)$/i.test((e.meta.exclude ?? '').trim());

/** The education entry the header names: the current one, else the most recent. */
export function headerEducation(profile: Profile): Entry | undefined {
  const pool = profile.education.filter((e) => !excluded(e));
  const current = pool.find((e) => /^(present|now|current|today)$/i.test(entryRange(e).end.trim()));
  return current ?? [...pool].sort((a, b) => recency(b).localeCompare(recency(a)))[0];
}

/** "M.Sc., Cybersecurity" → "M.Sc. in Cybersecurity"; other titles unchanged. */
export const courseName = (degree: string): string => degree.replace(/^([^,]+),\s*(.+)$/, '$1 in $2');

/**
 * A link for a format 2 macro. Those print inside table rows, where `&` is a column separator even inside \href,
 * so a link with `&` loses its query string (the page itself still opens).
 */
const tableUrl = (value: string): string => {
  const url = headerArg(value, 'url');
  return url.includes('&') ? (url.split('?')[0] ?? '') : url;
};

/** First http(s) link among the given meta keys, made safe for a raw macro argument ('' if none). */
const metaUrl = (e: Entry, ...keys: string[]): string => {
  for (const k of keys) {
    const raw = (e.meta[k] ?? '').trim();
    if (raw === '') continue;
    const ok = tableUrl(k === 'doi' && !/^https?:/i.test(raw) ? `https://doi.org/${raw}` : raw);
    if (ok !== '') return ok;
  }
  return '';
};

/** "Jan 2026" style date of a single-date entry (patents, publications). */
const singleDate = (e: Entry, fmt: ResumeRules['date_format'], lang: DocLanguage): string => {
  const raw = e.meta.published ?? entryRange(e).start;
  return raw.trim() === '' ? '' : formatDate(raw, fmt, lang);
};

/**
 * Builds the resume .tex from structured content (D21). Pure. Every model-written string is escaped; facts
 * (employers, titles, dates, locations, degrees, institutions, contact details) come from the profile.
 * A format 2 template (D25) gets its own macros; any other template gets the original seed's.
 */
export function renderResume(
  content: ResumeContent,
  profile: Profile,
  template: string,
  rules: ResumeRules,
  policy?: Pick<SkillsPolicy, 'learning_label'>,
  opts: RenderOptions = {},
): string {
  const lang = opts.language ?? 'en';
  const fmt = rules.date_format;
  const L = RESUME_LABELS[lang];
  const on = (s: ResumeRules['sections_order'][number]): boolean => rules.sections_order.includes(s);
  const esc = escapeLatex;
  const f = profile.frontMatter;
  const v2 = templateFormat(template) === 2;
  const slots: Record<string, string> = {};
  const order = renderedOrder(content, profile);
  const dates = (e: Entry): string => esc(entryDates(e, fmt, lang));
  /** Entries with their bullets, `\resumeGap` between two entries (format 2). */
  const entries = <T extends { item: { bullets?: { text: string }[] } }>(
    list: T[],
    line: (x: T) => string,
  ): string[] =>
    list.flatMap((x, i) => [
      ...(v2 && i > 0 ? ['\\resumeGap'] : []),
      line(x),
      ...items(x.item.bullets ?? []),
    ]);
  /** A section in its slot: heading, then the body, wrapped in an environment when the template has one. */
  const section = (
    name: string,
    show: boolean,
    heading: string,
    body: string[],
    wrap?: [string, string],
  ): void => {
    slots[name] =
      show && body.length > 0
        ? [`\\section${arg(heading)}`, ...(wrap ? [wrap[0], ...body, wrap[1]] : body)].join('\n')
        : '';
  };
  const env = (name: string): [string, string] | undefined =>
    v2 ? [`\\begin{${name}}`, `\\end{${name}}`] : undefined;

  if (v2) {
    const edu = headerEducation(profile);
    const [degree, school] = edu ? splitTitle(edu, 'institution') : ['', ''];
    slots.header = [
      ...(opts.photo && rules.photo ? ['\\resumephototrue'] : []),
      `\\resumeHeader${args(
        esc(f.name),
        esc(courseName(degree)),
        esc(school),
        esc(f.location),
        esc(f.phone),
        headerArg(f.email, 'email'),
        tableUrl(f.links.github),
        tableUrl(f.links.portfolio),
        tableUrl(f.links.linkedin),
      )}`,
    ].join('\n');
  } else
    slots.header = `\\resumeHeader${args(
      esc(f.name),
      esc(f.location),
      headerArg(f.email, 'email'),
      esc(f.phone),
      headerArg(f.links.linkedin, 'url'),
      headerArg(f.links.github || f.links.portfolio, 'url'),
    )}`;

  const summary = content.summary?.trim() ?? '';
  const showSummary = on('summary') && rules.summary.enabled && summary !== '';
  slots.summary = !showSummary
    ? ''
    : v2
      ? `\\section${arg(L.summary ?? '')}\n\\resumeSummary${arg(esc(summary))}`
      : `\\resumeSummary${arg(esc(summary))}`;

  section(
    'experience',
    on('experience'),
    L.experience ?? '',
    entries(order.experience, ({ entry }) => {
      const [title, org] = splitTitle(entry, 'company');
      return `\\resumeEntry${args(esc(title), dates(entry), esc(org), esc(entry.meta.location ?? ''))}`;
    }),
    env('resumeExperience'),
  );

  section(
    'projects',
    on('projects'),
    L.projects ?? '',
    entries(order.projects, ({ entry }) =>
      v2
        ? `\\resumeProject${args(esc(entry.title), esc(entry.meta.stack ?? ''), dates(entry), metaUrl(entry, 'link', 'site', 'url'))}`
        : `\\resumeProject${args(esc(entry.title), esc(entry.meta.stack ?? ''), dates(entry))}`,
    ),
    env('resumeEntries'),
  );

  section(
    'education',
    on('education'),
    L.education ?? '',
    v2
      ? order.education.map(({ entry }) => {
          const [deg, inst] = splitTitle(entry, 'institution');
          return `\\resumeEduRow${args(
            esc(deg.split(',')[0]?.trim() ?? deg),
            esc(inst),
            esc(entry.meta.grade ?? ''),
            esc(entryYears(entry, lang)),
          )}`;
        })
      : entries(order.education, ({ entry }) => {
          const [deg, school] = splitTitle(entry, 'institution');
          return `\\resumeEntry${args(esc(deg), dates(entry), esc(school), esc(entry.meta.location ?? ''))}`;
        }),
    v2
      ? [
          `\\begin{resumeEducation}${args(L.degree ?? '', L.institute ?? '', L.grade ?? '', L.year ?? '')}`,
          '\\end{resumeEducation}',
        ]
      : undefined,
  );

  const certs = pick(content.certifications, profile.certifications);
  section(
    'certifications',
    on('certifications'),
    L.certifications ?? '',
    certs.map(({ entry }) => {
      const [name, issuer] = splitTitle(entry, 'issuer');
      return v2
        ? `\\resumeCert${args(esc(name), esc(issuer), metaUrl(entry, 'credential_url', 'link', 'url'))}`
        : `\\resumeEntry${args(esc(name), dates(entry), esc(issuer), '')}`;
    }),
    env('resumeCerts'),
  );

  const label = policy?.learning_label ?? '(learning)';
  const skillLines = content.skills
    .map((line) => ({
      label: categoryLabel(line.category_label.trim(), lang),
      skills: line.skills
        .map((s) => s.trim())
        .filter((s) => s !== '')
        .map((s) => {
          const row = profile.skills.find((r) => matchesSkill(r, s));
          return row?.status === 'learning' ? `${s} ${label}` : s;
        }),
    }))
    .filter((l) => l.skills.length > 0);
  section(
    'skills',
    on('skills'),
    (v2 ? L.skills : L.skillsV1) ?? '',
    skillLines.map((l) => `\\skillLine${args(esc(l.label), esc(l.skills.join(', ')))}`),
    env('resumeSkills'),
  );

  if (v2) {
    section(
      'publications',
      on('publications'),
      L.publications ?? '',
      entries(order.publications, ({ entry }) => {
        const [title, venue] = splitTitle(entry, 'venue');
        const year = /^\d{4}/.exec(entryRange(entry).start.trim())?.[0] ?? '';
        return `\\resumePublication${args(esc(title), esc(venue), year, metaUrl(entry, 'link', 'doi', 'url'))}`;
      }),
      env('resumeEntries'),
    );
    section(
      'patents',
      on('patents'),
      L.patents ?? '',
      entries(order.patents, ({ entry }) => {
        const number = (entry.meta.number ?? entry.meta.application_no ?? '').trim();
        const date = singleDate(entry, fmt, lang);
        return `\\resumePatent${args(
          esc(entry.title),
          number ? esc(L.patentNumber ?? '') : '',
          esc(number),
          date ? esc(L.published ?? '') : '',
          esc(date),
        )}`;
      }),
      env('resumeEntries'),
    );
    const spoken = f.languages_spoken
      .filter((l) => l.language.trim() !== '')
      .map((l) => (l.level.trim() ? `${l.language.trim()} (${l.level.trim()})` : l.language.trim()));
    section(
      'misc',
      on('misc'),
      L.misc ?? '',
      [
        ...pick(content.awards, profile.awards).map(({ entry }) => {
          const [what, where] = splitTitle(entry, 'organisation');
          return `\\resumeMisc${args(esc(what), esc(where), dates(entry))}`;
        }),
        ...(spoken.length > 0
          ? [`\\resumeMisc${args(esc(L.languages ?? ''), esc(spoken.join(', ')), '')}`]
          : []),
      ],
      env('resumeMiscList'),
    );
    const d = opts.today ?? new Date();
    const when =
      lang === 'de'
        ? `${String(d.getDate())}. ${MONTHS_DE[d.getMonth()] ?? ''} ${String(d.getFullYear())}`
        : `${MONTHS[d.getMonth()] ?? ''} ${String(d.getDate())}, ${String(d.getFullYear())}`;
    slots.updated = `\\resumeUpdated${args(esc(L.updated ?? ''), esc(when))}`;
  }

  return fillTemplate(template, slots);
}
