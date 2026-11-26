import type { Jd } from '../jobs/schemas';
import { ENTRY_SECTIONS, matchesSkill, type Entry, type Profile, type SkillRow } from '../profile';
import type { SkillsPolicy } from '../rules';
import { findSkills, lookupSkill } from '../skills';
import type { CoverContent } from './cover';
import { entryRange } from './render';
import {
  CATEGORY_LABELS,
  type ResumeContent,
  type TruthReport,
  type TruthViolation,
  type DocLanguage,
  type TruthWarning,
} from './schemas';
import { hasTerm } from './text';

const NUM_WORDS: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
  hundred: 100,
  dozen: 12,
};
/** "six million", "2 billion": multiplies the number before it. */
const SCALE: Record<string, number> = { thousand: 1e3, million: 1e6, billion: 1e9, trillion: 1e12 };
/** Vague quantities are claims too: "thousands of users" needs "thousands" (or 1000) in the source. */
const VAGUE: Record<string, number> = {
  dozens: 12,
  hundreds: 100,
  thousands: 1e3,
  millions: 1e6,
  billions: 1e9,
};
const MULT_WORDS: Record<string, number> = {
  double: 2,
  doubled: 2,
  doubling: 2,
  twice: 2,
  triple: 3,
  tripled: 3,
  tripling: 3,
  thrice: 3,
  quadruple: 4,
  quadrupled: 4,
  halve: 0.5,
  halved: 0.5,
  halving: 0.5,
};
const SUFFIX: Record<string, number> = { k: 1e3, m: 1e6, mm: 1e6, bn: 1e9, b: 1e9 };
const UNIT_WORDS: Record<string, string[]> = {
  '%': ['%', 'percent', 'pct', 'pp', 'percentage'],
  x: ['x', '×', 'times', 'fold'],
  y: ['year', 'years', 'yr', 'yrs'],
  mo: ['month', 'months', 'mo', 'mos'],
  w: ['week', 'weeks', 'wk', 'wks'],
  d: ['day', 'days'],
  h: ['hour', 'hours', 'hr', 'hrs', 'h'],
  min: ['minute', 'minutes', 'min', 'mins'],
  s: ['second', 'seconds', 'sec', 'secs', 's'],
  ms: ['millisecond', 'milliseconds', 'ms'],
  cur: [
    'eur',
    'usd',
    'gbp',
    'chf',
    'dollar',
    'dollars',
    'euro',
    'euros',
    'pound',
    'pounds',
    '$',
    '€',
    '£',
    '¥',
  ],
  person: ['people', 'person', 'persons', 'staff', 'fte', 'headcount'],
  kb: ['kb'],
  mb: ['mb'],
  gb: ['gb'],
  tb: ['tb'],
  pb: ['pb'],
};
/** Counted nouns: "6 teams" and "6 users" are different claims. Singular form. */
const COUNT_NOUNS =
  'user customer client team engineer developer member employee service microservice pipeline dashboard report server node cluster country market language project product app application table job model request transaction event record row query querie stakeholder student repository repo site store location office partner vendor account ticket deployment release feature test region dataset source analyst scientist manager hire'.split(
    ' ',
  );
const UNITS = new Map<string, string>();
for (const [unit, words] of Object.entries(UNIT_WORDS)) for (const w of words) UNITS.set(w, unit);
for (const n of COUNT_NOUNS) {
  UNITS.set(n, n);
  UNITS.set(`${n}s`, n);
}
UNITS.set('queries', 'query');

/** A number claim: value, normalised unit (null when none follows) and the text it came from. */
export interface Quantity {
  value: number;
  unit: string | null;
  raw: string;
}

const parseNum = (raw: string): number => {
  let r = /^\d{1,3}(,\d{3})+(\.\d+)?$/.test(raw) ? raw.replace(/,/g, '') : raw.replace(',', '.');
  // "1.200.000" style thousands
  if (/^\d{1,3}(\.\d{3}){2,}$/.test(raw)) r = raw.replace(/\./g, '');
  return Number(r);
};
const numWord = (w: string): number | undefined => {
  const parts = w.split('-');
  if (parts.length === 1) return NUM_WORDS[w];
  // "twenty-five"
  if (parts.length === 2 && (NUM_WORDS[parts[0] ?? ''] ?? 0) >= 20 && (NUM_WORDS[parts[1] ?? ''] ?? 10) < 10)
    return (NUM_WORDS[parts[0] ?? ''] ?? 0) + (NUM_WORDS[parts[1] ?? ''] ?? 0);
  return undefined;
};
const NUM_RE = /^(\d+(?:[.,]\d+)*)(\p{L}*)$/u;

/**
 * Every quantity in `text`: digits ("1,200", "1.2k", "40 %"), written numbers ("six", "twenty-five"), scale and
 * vague words ("six million", "thousands"), multipliers ("doubled", "10x", "x10", "tenfold", "twice"), and
 * "a decade". A comma followed by exactly three digits is a thousands separator; otherwise a decimal comma.
 */
export function extractQuantities(text: string): Quantity[] {
  const toks = [...text.normalize('NFKC').matchAll(/[\p{L}\p{N}]+(?:[.,'’-][\p{L}\p{N}]+)*|\S/gu)].map(
    (m) => m[0],
  );
  const low = toks.map((t) => t.toLowerCase());
  const out: Quantity[] = [];
  /** Unit after token i (skipping "+", "of" and "per"), or null. Returns the index after the unit. */
  const unitAfter = (i: number): string | null => {
    let j = i;
    if (low[j] === '+') j++;
    if (low[j] === 'per' && low[j + 1] === 'cent') return '%';
    if (low[j] === 'of') j++;
    return UNITS.get(low[j] ?? '') ?? null;
  };
  const push = (value: number, unit: string | null, raw: string): void => {
    if (Number.isFinite(value)) out.push({ value, unit, raw });
  };

  for (let i = 0; i < toks.length; i++) {
    const t = low[i] ?? '';
    const prev = low[i - 1] ?? '';
    const cur = /^[$€£¥]$/.test(prev) || ['eur', 'usd', 'gbp'].includes(prev) ? 'cur' : null;
    const num = NUM_RE.exec(t);
    if (num) {
      let value = parseNum(num[1] ?? '');
      const suffix = num[2] ?? '';
      let unit: string | null = null;
      let j = i + 1;
      if (SUFFIX[suffix] !== undefined) value *= SUFFIX[suffix];
      else if (SCALE[suffix] !== undefined) value *= SCALE[suffix];
      else if (suffix !== '' && !/^(st|nd|rd|th)$/.test(suffix)) unit = UNITS.get(suffix) ?? null;
      if (suffix === '' && SUFFIX[low[j] ?? ''] !== undefined) value *= SUFFIX[low[j++] ?? ''] ?? 1;
      if (SCALE[low[j] ?? ''] !== undefined) value *= SCALE[low[j++] ?? ''] ?? 1;
      unit ??= cur ?? unitAfter(j);
      push(value, unit, toks[i] ?? '');
      continue;
    }
    const xn = /^[x×](\d+(?:[.,]\d+)*)$/.exec(t);
    if (xn) {
      push(parseNum(xn[1] ?? ''), 'x', toks[i] ?? '');
      continue;
    }
    const fold = /^(.+?)-?fold$/.exec(t);
    if (fold) {
      const base = fold[1] ?? '';
      const v = /^\d/.test(base) ? parseNum(base) : numWord(base);
      if (v !== undefined) push(v, 'x', toks[i] ?? '');
      continue;
    }
    const w = numWord(t);
    if (w !== undefined) {
      // "one of the", "no one", "any one" are not counts.
      if (t === 'one' && (low[i + 1] === 'of' || ['no', 'any', 'every', 'each', 'the'].includes(prev)))
        continue;
      let value = w;
      let j = i + 1;
      if (SCALE[low[j] ?? ''] !== undefined) value *= SCALE[low[j++] ?? ''] ?? 1;
      push(value, cur ?? unitAfter(j), toks.slice(i, j).join(' '));
      continue;
    }
    if (t.includes('-')) {
      // "three-person", "24-hour", "five-year", "2020-2022"
      const [first = '', ...rest] = t.split('-');
      const v = /^\d+(?:[.,]\d+)*$/.test(first) ? parseNum(first) : numWord(first);
      if (v !== undefined && rest.length === 1) {
        const r = rest[0] ?? '';
        push(v, UNITS.get(r) ?? null, toks[i] ?? '');
        if (/^\d+(?:[.,]\d+)*$/.test(r)) push(parseNum(r), null, r);
      }
      continue;
    }
    if (VAGUE[t] !== undefined) push(VAGUE[t], unitAfter(i + 1), toks[i] ?? '');
    else if (MULT_WORDS[t] !== undefined) push(MULT_WORDS[t], 'x', toks[i] ?? '');
    else if ((t === 'decade' && ['a', 'one'].includes(prev)) || t === 'decades') push(10, 'y', toks[i] ?? '');
  }
  return out;
}

/** Every number in `text`, normalised: "1,200" = "1200", "1.2k" = "1200", "40 %" = "40", "six" = "6". */
export function extractNumbers(text: string): string[] {
  return extractQuantities(text).map((q) => String(q.value));
}

const sameValue = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a));
const hasWord = (text: string, word: string): boolean =>
  new RegExp(
    `(?<![\\p{L}\\p{N}])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`,
    'iu',
  ).test(text.normalize('NFKC'));

/**
 * True when a source supports the claim: the same value with the same unit (a missing unit on either side
 * matches any unit, so "6" ↔ "six teams", but "10%" ≠ "10 min"), or, for word claims ("thousands", "doubled"),
 * the same word.
 */
function supported(c: Quantity, sources: Quantity[], sourceText: string): boolean {
  if (
    sources.some(
      (s) => sameValue(s.value, c.value) && (c.unit === null || s.unit === null || s.unit === c.unit),
    )
  )
    return true;
  // Word claims ("thousands", "doubled", "decade") also match by the word; written numbers only by value.
  return /^\p{L}+$/u.test(c.raw) && numWord(c.raw.toLowerCase()) === undefined && hasWord(sourceText, c.raw);
}

// Month numbers in meta dates ("2016-09") are not claims a bullet can make; only the year counts.
const entryText = (e: Entry): string =>
  [e.title, ...Object.values(e.meta).map((v) => v.replace(/\b(\d{4})-\d{1,2}\b/g, '$1')), ...e.bullets].join(
    '\n',
  );

/** The profile marks an entry as never-to-show with `- exclude: true` (docs/03 §1). */
export const isExcluded = (e: Entry): boolean => /^(true|yes)$/i.test((e.meta.exclude ?? '').trim());

/**
 * Whole years of work experience, counted conservatively: experience entries merged where they overlap, a
 * year-only start counts from December and a year-only end until January, "present" = today; floor(months / 12).
 */
export function experienceYears(profile: Profile, today = new Date()): number {
  const month = (s: string, end: boolean): number | null => {
    const v = s.trim();
    if (/^(present|now|current|today)$/i.test(v)) return today.getFullYear() * 12 + today.getMonth();
    const m = /^(\d{4})(?:[-/.](\d{1,2}))?/.exec(v);
    if (!m) return null;
    const mo = m[2] ? Number(m[2]) - 1 : end ? 0 : 11;
    return Number(m[1]) * 12 + mo;
  };
  const spans = profile.experience
    .filter((e) => !isExcluded(e))
    .map((e) => {
      const { start, end } = entryRange(e);
      return [month(start, false), month(end, true)] as const;
    })
    .filter((s): s is readonly [number, number] => s[0] !== null && s[1] !== null && s[1] > s[0])
    .sort((a, b) => a[0] - b[0]);
  let total = 0;
  let cur: [number, number] | null = null;
  for (const [a, b] of spans) {
    if (cur && a <= cur[1]) cur[1] = Math.max(cur[1], b);
    else {
      if (cur) total += cur[1] - cur[0];
      cur = [a, b];
    }
  }
  if (cur) total += cur[1] - cur[0];
  return Math.floor(total / 12);
}

/** Capitalised words that are not names: sentence glue, months, departments, places of the generic kind. */
const COMMON_CAPS = new Set(
  `I A An The And Or Of In On At For With To By From Via Per Across Over Under Into Led Built
January February March April May June July August September October November December
Jan Feb Mar Apr Jun Jul Aug Sep Sept Oct Nov Dec Monday Tuesday Wednesday Thursday Friday Saturday Sunday
Q1 Q2 Q3 Q4 EU US USA UK EMEA APAC DACH Europe European America American Asia Global
English German French Spanish
Finance Sales Marketing Product Engineering Operations Ops HR Legal Support Customer Success Research Design
Security IT Management Leadership Executive Executives Board Data Analytics Platform Infrastructure Growth
CEO CTO CFO COO CIO VP SVP Head Director Lead Senior Junior Staff Principal Manager Engineer Analyst Scientist
API APIs KPI KPIs ROI SLA SLAs SLO MVP POC PoC QA UI UX B2B B2C SaaS PaaS IaaS OKR OKRs PR PRs ID IDs
BSc MSc BA MA MBA PhD`.split(/\s+/),
);
/** Organisation suffixes: "Acme Corp", "Initech GmbH". */
const ORG_SUFFIX = 'Inc|Ltd|LLC|LLP|GmbH|AG|Corp|Corporation|plc|PLC|SE|SA|BV|NV|Co|Group|Holdings';
const CAP = "\\p{Lu}[\\p{L}\\p{N}&'’.]*[\\p{L}\\p{N}]|\\p{Lu}";

export interface TruthOptions {
  policy: SkillsPolicy;
  /** Structured JD of this job: its skills the profile does not allow must not appear in the text. */
  jd: Jd | null;
  /** Skills the user approved for this job in the skill audit. */
  approvedSkills?: readonly string[];
  /** For the recency cut-off and "present" in experience dates; default now. */
  today?: Date;
  /**
   * German versions: no capitalised-term warnings (every German noun is capitalised). Their terms are checked
   * against the English source instead (`checkTranslation`).
   */
  language?: DocLanguage;
}

/** Why a profile skill may not be listed, or null when it may (skills-policy.md). */
export function skillBlocker(
  row: SkillRow,
  policy: SkillsPolicy,
  jdSkills: readonly string[],
  today = new Date(),
): string | null {
  if (policy.never_show.some((n) => matchesSkill(row, n))) return 'is in never_show';
  if (policy.always_pin.some((n) => matchesSkill(row, n))) return null;
  if (row.status === 'want') return 'has status "want"';
  if (row.status === 'learning' && !policy.allow_learning_skills)
    return 'has status "learning" and learning skills are not allowed';
  if (row.status !== 'have' && row.status !== 'learning') return `has status "${row.status}"`;
  if (row.level !== null && row.level < policy.min_level_to_list)
    return `level ${String(row.level)} is below min_level_to_list ${String(policy.min_level_to_list)}`;
  const year = /^\d{4}$/.exec(row.last_used.trim())?.[0];
  const jdWants = jdSkills.some((s) => matchesSkill(row, s));
  if (year && Number(year) < today.getFullYear() - policy.recency_cutoff_years && !jdWants)
    return `last used ${year}, beyond recency_cutoff_years`;
  return null;
}

interface Sources {
  text: string;
  /** Entry ids the claim cites; null for the summary (any allowed profile skill may be named there). */
  ids: string[] | null;
  /**
   * Summary only: entry texts whose number+unit pairs may also back a number ("six teams" from an entry).
   * Years claims never come from here (only the summary, the headline or the computed experience years).
   */
  entryText?: string;
  /**
   * Cover letters: the posting text and the profile notes. Company facts (numbers other than years,
   * organisation and place names) may come from here; skills and years never do.
   */
  company?: string;
}

/**
 * Deterministic truth check (docs/06 §4). Violations: unknown or excluded ids, numbers not in the cited sources,
 * skills (skill dictionary, profile skills, JD skills) the policy does not allow or the cited entries do not
 * show, organisations not in the profile, skill-line labels off the fixed list. Warnings: other capitalised
 * terms the sources do not contain. Pure.
 */
export function checkTruth(content: ResumeContent, profile: Profile, opts: TruthOptions): TruthReport {
  const { violations, warnings, add, checkProse, byId, jdSkills, isApproved, today, summarySources } =
    truthContext(profile, opts);
  // Summary: skills only from the profile summary, the headline and the skills this job may show (blocked skills
  // are not sources). Numbers also from unit-matched entry facts; years only from the summary/headline or up to
  // the whole years of experience in the dates.
  if (content.summary)
    checkProse(
      content.summary,
      {
        text: summarySources(),
        ids: null,
        entryText: ENTRY_SECTIONS.flatMap((sec) =>
          profile[sec].filter((e) => !isExcluded(e)).map(entryText),
        ).join('\n'),
      },
      'summary',
    );
  const sectionEntries = (
    section:
      'experience' | 'projects' | 'education' | 'certifications' | 'publications' | 'patents' | 'awards',
    list: { entry_id: string; bullets?: ResumeContent['experience'][number]['bullets'] }[],
  ): void => {
    list.forEach((item, i) => {
      const path = `${section}[${String(i)}]`;
      const found = byId.get(item.entry_id);
      if (!found) {
        add('unknown_id', item.entry_id, `"${item.entry_id}" is not an entry id in the profile`, path);
        return;
      }
      if (found.section !== section) {
        add(
          'entry_not_in_profile',
          item.entry_id,
          `"${item.entry_id}" is a ${found.section} entry, not ${section}`,
          path,
        );
        return;
      }
      if (isExcluded(found.entry)) {
        add(
          'entry_not_in_profile',
          item.entry_id,
          `"${item.entry_id}" is marked exclude in the profile`,
          path,
        );
        return;
      }
      (item.bullets ?? []).forEach((b, j) => {
        const bpath = `${path}.bullets[${String(j)}]`;
        const sources = [found.entry];
        for (const id of b.source_ids) {
          if (id === item.entry_id) continue;
          const src = byId.get(id);
          if (!src) add('unknown_id', id, `source id "${id}" is not an entry id in the profile`, bpath);
          else if (isExcluded(src.entry))
            add('entry_not_in_profile', id, `source "${id}" is marked exclude in the profile`, bpath);
          else sources.push(src.entry);
        }
        checkProse(b.text, { text: sources.map(entryText).join('\n'), ids: sources.map((e) => e.id) }, bpath);
      });
    });
  };
  sectionEntries('experience', content.experience);
  sectionEntries('projects', content.projects);
  sectionEntries('education', content.education);
  sectionEntries('certifications', content.certifications);
  sectionEntries('publications', content.publications);
  sectionEntries('patents', content.patents);
  sectionEntries('awards', content.awards);

  content.skills.forEach((line, i) => {
    if (!CATEGORY_LABELS.includes(line.category_label))
      add(
        'label_not_allowed',
        line.category_label,
        `"${line.category_label}" is not one of the allowed skill-line labels`,
        `skills[${String(i)}].category_label`,
      );
    line.skills.forEach((name, j) => {
      const path = `skills[${String(i)}].skills[${String(j)}]`;
      const row = profile.skills.find((r) => matchesSkill(r, name));
      if (!row) {
        if (!isApproved([name])) add('skill_not_allowed', name, `${name} is not in the profile`, path);
        return;
      }
      const why = skillBlocker(row, opts.policy, jdSkills, today);
      if (why && !isApproved([name, row.skill, ...row.aliases]))
        add('skill_not_allowed', name, `${row.skill} ${why}`, path);
    });
  });

  return { ok: violations.length === 0, violations, warnings: opts.language === 'de' ? [] : warnings };
}

export interface CoverTruthOptions extends TruthOptions {
  /** Posting text plus the profile notes: the only places company facts may come from. */
  company: string;
  /** Referral messages: the person's cited public facts. Skills and numbers named there are supported too. */
  extraSources?: string;
}

/** Words in a salutation that are not names. */
const SALUTATION_GLUE = new Set(
  'dear hello hi good morning afternoon evening mr mrs ms mx dr prof professor sir madam hiring team manager managers committee recruitment recruiting recruiter talent acquisition people department and or the to of sehr geehrte geehrter geehrtes liebe lieber hallo guten tag damen herren frau herr personalabteilung personalteam recruiting-team einstellungsteam und'.split(
    ' ',
  ),
);

/**
 * Truth check of a cover letter (docs/06 §9): the prose check of `checkTruth` on every paragraph (facts from
 * the cited profile entries and the allowed summary/skills; company facts only from `opts.company`, years and
 * skills never), organisations other than the target company or the profile's are violations, and a name in
 * the salutation must be in the posting or the notes. Pure.
 */
export function checkCoverTruth(
  content: CoverContent,
  profile: Profile,
  opts: CoverTruthOptions,
): TruthReport {
  const { violations, warnings, add, checkProse, byId, summarySources } = truthContext(
    profile,
    opts,
    'at|for|with|by|from|like|join|joining',
  );
  // Logistics the rules ask for (location, work authorisation, notice period, languages) are profile facts too.
  const f = profile.frontMatter;
  const base = [
    summarySources(),
    f.location,
    f.work_authorization,
    f.notice_period,
    f.languages_spoken.map((l) => `${l.language} ${l.level}`).join(', '),
    opts.extraSources ?? '',
  ].join('\n');
  const prose = (text: string, cited: string[], path: string): void => {
    checkProse(text, { text: [base, ...cited].join('\n'), ids: null, company: opts.company }, path);
  };
  content.paragraphs.forEach((p, i) => {
    const path = `paragraphs[${String(i)}]`;
    const cited: string[] = [];
    for (const id of p.source_ids) {
      const found = byId.get(id);
      if (!found) add('unknown_id', id, `source id "${id}" is not an entry id in the profile`, path);
      else if (isExcluded(found.entry))
        add('entry_not_in_profile', id, `source "${id}" is marked exclude in the profile`, path);
      else cited.push(entryText(found.entry));
    }
    prose(p.text, cited, path);
  });
  if (content.closing) prose(content.closing, [], 'closing');
  const salutation = content.salutation ?? '';
  for (const w of salutation.split(/[^\p{L}\p{N}'’-]+/u)) {
    if (w.length < 2 || SALUTATION_GLUE.has(w.toLowerCase()) || w[0] !== w[0]?.toUpperCase()) continue;
    if (!hasWord(opts.company, w) && !hasWord(opts.jd?.company ?? '', w))
      add('name_not_in_source', salutation, `"${w}" is not in the posting or your notes`, 'salutation');
  }
  return { ok: violations.length === 0, violations, warnings: opts.language === 'de' ? [] : warnings };
}

function truthContext(profile: Profile, opts: TruthOptions, preps = 'at|for|with') {
  // "At Acme" at the start of a sentence counts too (the name after it stays case-sensitive).
  const prepRe = preps
    .split('|')
    .map((w) => `[${w[0]?.toUpperCase() ?? ''}${w[0] ?? ''}]${w.slice(1)}`)
    .join('|');
  const violations: TruthViolation[] = [];
  const warnings: TruthWarning[] = [];
  const add = (kind: TruthViolation['kind'], text: string, detail: string, path: string): void => {
    violations.push({ kind, text, detail, path });
  };
  const today = opts.today ?? new Date();
  const byId = new Map<string, { entry: Entry; section: string }>();
  for (const section of ENTRY_SECTIONS)
    for (const entry of profile[section]) byId.set(entry.id, { entry, section });

  const jdSkills = opts.jd?.requirements.flatMap((r) => r.skills) ?? [];
  const approved = opts.approvedSkills ?? [];
  const isApproved = (terms: readonly string[]): boolean =>
    approved.some((a) => terms.some((t) => t.trim().toLowerCase() === a.trim().toLowerCase()));
  const rowFor = (terms: readonly string[]): SkillRow | undefined =>
    profile.skills.find((r) => terms.some((t) => matchesSkill(r, t)));
  const termsOf = (name: string, row?: SkillRow): string[] => [
    ...new Set([name, ...(row ? [row.skill, ...row.aliases] : []), ...(lookupSkill(name)?.terms ?? [])]),
  ];
  const expYears = experienceYears(profile, today);
  const jdNames = [opts.jd?.company ?? '', opts.jd?.title ?? ''].filter((s) => s.trim() !== '');

  // Everything the profile says about the candidate, for organisation names (notes excluded: never quoted).
  const profileText = [
    profile.frontMatter.name,
    profile.frontMatter.headline,
    profile.frontMatter.location,
    profile.frontMatter.work_authorization,
    profile.summary,
    ...ENTRY_SECTIONS.flatMap((s) => profile[s].filter((e) => !isExcluded(e)).map(entryText)),
  ].join('\n');

  const checkProse = (text: string, src: Sources, path: string): void => {
    // Numbers
    const have = [
      ...extractQuantities(src.text),
      ...extractQuantities(src.company ?? '').filter((q) => q.unit !== 'y'),
    ];
    const fromEntries = src.entryText === undefined ? [] : extractQuantities(src.entryText);
    const missing = extractQuantities(text).filter((q) => {
      if (supported(q, have, src.text)) return false;
      if (src.ids === null && q.unit === 'y') return q.value > expYears;
      return !(src.entryText !== undefined && q.unit !== null && supported(q, fromEntries, ''));
    });
    if (missing.length > 0)
      add(
        'number_not_in_source',
        text,
        `${[...new Set(missing.map((q) => q.raw))].join(', ')} not found in the cited profile entries`,
        path,
      );

    // Skills: dictionary hits, profile skills and JD skills named in the text.
    const found = new Map<string, { name: string; terms: string[]; row?: SkillRow }>();
    const note = (name: string): void => {
      const row = rowFor(termsOf(name));
      const terms = termsOf(name, row);
      const k = (row?.skill ?? lookupSkill(name)?.name ?? name).toLowerCase();
      if (!found.has(k)) found.set(k, { name: row?.skill ?? lookupSkill(name)?.name ?? name, terms, row });
    };
    const hits = findSkills(text);
    for (const h of hits) note(h.text);
    for (const r of profile.skills) if ([r.skill, ...r.aliases].some((t) => hasTerm(text, t))) note(r.skill);
    for (const s of jdSkills) if (hasTerm(text, s)) note(s);
    for (const { name, terms, row } of found.values()) {
      if (terms.some((t) => hasTerm(src.text, t))) continue;
      const ok = isApproved(terms);
      if (!row) {
        if (!ok) add('skill_not_allowed', text, `${name} is not in the profile`, path);
        continue;
      }
      const why = skillBlocker(row, opts.policy, jdSkills, today);
      if (why) {
        if (!ok) add('skill_not_allowed', text, `${row.skill} ${why}`, path);
      } else if (src.ids !== null && !ok && !row.evidence.some((id) => src.ids?.includes(id)))
        add(
          'skill_not_allowed',
          text,
          `${row.skill} is not shown in the cited entries (${src.ids.join(', ')}); its evidence is ${row.evidence.join(', ') || 'empty'}`,
          path,
        );
    }

    // Organisations: "at X", "for X", "with X", "X Inc".
    const known = (phrase: string): boolean =>
      hasWord(profileText, phrase) ||
      (src.company !== undefined &&
        (hasWord(src.company, phrase) || phrase.split(/\s+/).every((w) => hasWord(src.company ?? '', w)))) ||
      (src.ids === null && jdNames.some((j) => hasWord(j, phrase) || hasWord(phrase, j))) ||
      phrase
        .split(/\s+/)
        .every((w) => COMMON_CAPS.has(w) || hasWord(profileText, w) || lookupSkill(w) !== undefined);
    const norm = text.normalize('NFKC');
    const inSkill = (i: number): boolean =>
      hits.some((h) => i >= h.index && i < h.index + h.text.length) ||
      [...found.values()].some((f) =>
        f.terms.some((t) => norm.slice(i, i + t.length).toLowerCase() === t.toLowerCase()),
      );
    const orgs = new Map<string, number>();
    for (const m of norm.matchAll(
      new RegExp(`(?<![\\p{L}])(?:${prepRe})\\s+((?:${CAP})(?:\\s+(?:and|&|of)?\\s*(?:${CAP}))*)`, 'gu'),
    )) {
      const start = m.index + m[0].length - (m[1] ?? '').length;
      let offset = start;
      for (const part of (m[1] ?? '').split(/(\s+(?:and|&)\s+)/)) {
        if (!/^\s+(?:and|&)\s+$/.test(part)) orgs.set(part.trim().replace(/['’]s$/, ''), offset);
        offset += part.length;
      }
    }
    for (const m of norm.matchAll(
      new RegExp(`((?:(?:${CAP})\\s+){1,4})(?:${ORG_SUFFIX})\\.?(?![\\p{L}])`, 'gu'),
    ))
      orgs.set(m[0].replace(/\.$/, '').trim(), m.index);
    const flagged = new Set<string>();
    for (const [org, at] of orgs) {
      if (org === '' || inSkill(at) || known(org)) continue;
      flagged.add(org);
      add('unknown_organisation', text, `"${org}" is not an organisation in the profile`, path);
    }

    // Other capitalised terms: a warning when the sources do not have them.
    const seen = new Set<string>();
    for (const m of norm.matchAll(new RegExp(`(?<![\\p{L}\\p{N}])(?:${CAP})`, 'gu'))) {
      const w = m[0].replace(/[.'’]+$/, '');
      const before = norm.slice(0, m.index).trimEnd();
      if (w.length < 2 || before === '' || /[.!?:;]$/.test(before)) continue;
      if (seen.has(w) || COMMON_CAPS.has(w) || inSkill(m.index)) continue;
      if ([...flagged].some((o) => o.split(/\s+/).includes(w))) continue;
      if (
        hasWord(src.ids === null ? profileText : src.text, w) ||
        (src.company !== undefined && hasWord(src.company, w)) ||
        jdNames.some((j) => hasWord(j, w)) ||
        lookupSkill(w)
      )
        continue;
      seen.add(w);
      warnings.push({
        kind: 'unverified_term',
        text: w,
        detail: `"${w}" is not in the cited profile entries`,
        path,
      });
    }
  };

  return {
    violations,
    warnings,
    add,
    checkProse,
    byId,
    jdSkills,
    isApproved,
    today,
    /** Text the summary (and a cover letter) may draw skills from: headline, profile summary, skills the job may show. */
    summarySources: (): string => {
      const allowedNames = profile.skills
        .filter(
          (r) =>
            skillBlocker(r, opts.policy, jdSkills, today) === null || isApproved([r.skill, ...r.aliases]),
        )
        .flatMap((r) => [r.skill, ...r.aliases]);
      return [profile.frontMatter.headline, profile.summary, allowedNames.join(', ')].join('\n');
    },
  };
}
