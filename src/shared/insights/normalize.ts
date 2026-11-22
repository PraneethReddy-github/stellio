// Turns free-form job fields into the labels the Insights segments use. Pure.

const FAMILIES: readonly (readonly [label: string, re: RegExp])[] = [
  ['Data science / ML', /\b(data scien|machine learning|research scien|deep learning)|\b(ml|ai|nlp)\b/i],
  ['Data engineering', /\b(data engineer|analytics engineer|dateningenieur|etl|data platform|big data)/i],
  ['Analytics / BI', /\b(data analy|datenanaly|business intelligence|reporting|analyst)|\bbi\b/i],
  [
    'DevOps / platform',
    /\b(devops|sre|site reliability|platform engineer|infrastructure|cloud engineer|cloud architect)/i,
  ],
  ['Security', /\b(security|sicherheit)/i],
  ['QA / testing', /\b(qa|quality assurance|test automation|tester|sdet)\b/i],
  ['Product / project', /\b(product (manager|owner)|project manager|produktmanager|scrum master)/i],
  ['Design', /\b(designer|ux)\b/i],
  [
    'Engineering management',
    /\b(engineering manager|head of engineering|vp engineering|director of engineering|cto)\b/i,
  ],
  [
    'Software engineering',
    /\b(software|backend|back-end|frontend|front-end|full[- ]?stack|developer|entwickler|programmer|engineer|ingenieur|mobile|ios|android)/i,
  ],
];

/** Role family of a job title ("Senior Data Engineer (m/f/d)" gives "Data engineering"). */
export function roleFamily(title: string): string {
  return FAMILIES.find(([, re]) => re.test(title))?.[0] ?? 'Other';
}

const TITLE_SENIORITY: readonly (readonly [label: string, re: RegExp])[] = [
  ['Intern', /\b(intern|internship|praktikum|werkstudent|working student)\b/i],
  ['Junior', /\b(junior|jr\.?|entry[- ]level|graduate|trainee)(?![\p{L}])/iu],
  ['Director', /\b(director|head of|vp|vice president)\b/i],
  ['Manager', /\b(manager|leiter)/i],
  ['Staff', /\b(staff|principal|architect)\b/i],
  ['Lead', /\b(lead|team ?lead)\b/i],
  ['Senior', /\b(senior|sr\.?)(?![\p{L}])/iu],
];
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** The JD's seniority when it has one, else a keyword in the title, else "Not stated". */
export function seniorityLabel(seniority: string | null, title: string): string {
  const s = seniority?.trim().toLowerCase();
  if (s) return s === 'executive' ? 'Director' : cap(s);
  return TITLE_SENIORITY.find(([, re]) => re.test(title))?.[0] ?? 'Not stated';
}

/** Fit-score band: 0-49 / 50-69 / 70-84 / 85+. */
export function fitBand(fit: number | null): string {
  if (fit === null) return 'Not scored';
  return fit >= 85 ? '85+' : fit >= 70 ? '70-84' : fit >= 50 ? '50-69' : '0-49';
}

export function remoteLabel(remote: string): string {
  return remote === 'onsite'
    ? 'On-site'
    : remote === 'hybrid'
      ? 'Hybrid'
      : remote === 'remote'
        ? 'Remote'
        : 'Not stated';
}

const DAY = 86_400_000;
/** Whole days between the posting and the application, as a band: 0-3 / 4-7 / 8-14 / 15+. */
export function daysBand(postedAt: string | null, appliedAt: string): string {
  if (postedAt === null) return 'Posting date unknown';
  const posted = Date.parse(postedAt);
  const applied = Date.parse(appliedAt);
  if (Number.isNaN(posted) || Number.isNaN(applied)) return 'Posting date unknown';
  const d = Math.max(0, Math.floor((applied - posted) / DAY));
  return d <= 3 ? '0-3 days' : d <= 7 ? '4-7 days' : d <= 14 ? '8-14 days' : '15+ days';
}
