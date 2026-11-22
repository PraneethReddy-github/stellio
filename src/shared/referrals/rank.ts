import { isExcluded } from '../documents/truth';
import type { Profile } from '../profile';
import type { ValidPerson } from './schemas';
import { fold } from './validate';

// Ranking of validated people and the shared-ground list taken from the profile (docs/14 §2 step 3). Pure.

export interface GroundItem {
  kind: 'education' | 'employer' | 'language' | 'city' | 'project';
  label: string;
}

const afterDash = (title: string): string => {
  const parts = title.split(/\s+[—–-]\s+|\s+@\s+|\s+at\s+/);
  return (parts.length > 1 ? parts[parts.length - 1] : title)?.trim() ?? title;
};

/**
 * What the user can share with a person: institutions, past employers, spoken languages, city and project names.
 * Never contact data (docs/14 §1). Excluded entries are left out.
 */
export function sharedGroundFrom(profile: Profile): GroundItem[] {
  const out: GroundItem[] = [];
  const add = (kind: GroundItem['kind'], label: string): void => {
    const l = label.trim();
    if (l.length >= 2 && !out.some((o) => o.kind === kind && fold(o.label) === fold(l)))
      out.push({ kind, label: l });
  };
  for (const e of profile.education.filter((x) => !isExcluded(x))) add('education', afterDash(e.title));
  for (const e of profile.experience.filter((x) => !isExcluded(x))) add('employer', afterDash(e.title));
  for (const l of profile.frontMatter.languages_spoken) add('language', l.language);
  const city = profile.frontMatter.location.split(',')[0] ?? '';
  add('city', city);
  for (const e of profile.projects.filter((x) => !isExcluded(x))) add('project', e.title);
  return out;
}

/** The part of the ground a tool-enabled model run may see: city and project titles stay local (docs/14 §1). */
export const groundForSearch = (ground: readonly GroundItem[]): GroundItem[] =>
  ground.filter((g) => g.kind === 'education' || g.kind === 'employer' || g.kind === 'language');

export interface RankTarget {
  /** "software engineer", "backend": a keyword matches when all its words are in the title. */
  roleKeywords: readonly string[];
  team?: string;
  seniority?: string;
  location?: string;
  /** Institutions or employers to favour ("alumni of ..."). */
  alumni?: readonly string[];
}

export interface Ranked {
  person: ValidPerson;
  /** 0-100. */
  score: number;
  /** The model's one-liner, or one built from the signals when it sent none. */
  why: string;
  /** Profile ground items that also appear in the person's public facts. */
  sharedGround: string[];
  signals: string[];
}

type Level = 'executive' | 'manager' | 'senior' | 'mid' | 'junior';
const LEVELS: [Level, RegExp][] = [
  [
    'executive',
    /\b(chief|cto|ceo|cfo|coo|cio|ciso|vp|vice president|svp|evp|president|managing director|general manager|head of|founder|co founder|partner|director|vorstand|geschaftsfuhrer)\b/,
  ],
  ['manager', /\b(manager|team lead|teamleiter|engineering lead)\b/],
  ['junior', /\b(junior|jr|intern|working student|werkstudent|trainee|graduate|apprentice)\b/],
  ['senior', /\b(senior|sr|staff|principal|lead|expert|architect|distinguished|fellow)\b/],
];
export const levelOf = (title: string): Level => {
  const t = fold(title);
  return LEVELS.find(([, re]) => re.test(t))?.[0] ?? 'mid';
};
const LEVEL_POINTS: Record<Level, number> = { senior: 18, mid: 14, manager: 8, junior: 6, executive: -12 };

const ACTIVITY =
  /\b(talk|speaker|keynote|conference|meetup|podcast|blog|article|author|maintainer|open source|published|panel|workshop|webinar)\b/;

const hasAll = (hay: string, phrase: string): boolean => {
  const h = new Set(hay.split(' '));
  const words = phrase.split(' ').filter(Boolean);
  return words.length > 0 && words.every((w) => h.has(w));
};

export function rankPeople(
  people: readonly ValidPerson[],
  target: RankTarget,
  ground: readonly GroundItem[],
  now: Date,
): Ranked[] {
  const keywords = target.roleKeywords.map(fold).filter(Boolean);
  const team = target.team ? fold(target.team) : '';
  const seniority = target.seniority ? fold(target.seniority) : '';
  const place = target.location ? fold(target.location.split(',')[0] ?? '') : '';
  const alumni = (target.alumni ?? []).map(fold).filter(Boolean);
  const years = [String(now.getFullYear()), String(now.getFullYear() - 1)];

  const ranked = people.map((person): Ranked => {
    const title = fold(person.title);
    const facts = person.sources.flatMap((s) => s.facts).join(' ');
    const all = fold(`${person.title} ${person.locationText} ${facts}`);
    const signals: string[] = [];
    let score = 0;

    if (keywords.length === 0) score += 20;
    else {
      const inTitle = keywords.filter((k) => hasAll(title, k)).length;
      const inFacts = keywords.filter((k) => !hasAll(title, k) && hasAll(all, k)).length;
      score += (40 * inTitle) / keywords.length + (15 * inFacts) / keywords.length;
      if (inTitle > 0) signals.push(`${person.title || 'works'} matches the role`);
    }
    if (team !== '' && hasAll(all, team)) {
      score += 10;
      signals.push(`team: ${target.team ?? ''}`);
    }
    const level = levelOf(person.title);
    score += LEVEL_POINTS[level];
    if (seniority !== '' && hasAll(title, seniority)) score += 10;
    if (level === 'senior' || level === 'mid') signals.push('a peer or senior IC');
    if (level === 'executive') signals.push('an executive (less likely to refer)');
    if (place !== '' && hasAll(fold(person.locationText), place)) {
      score += 8;
      signals.push(`based in ${target.location?.split(',')[0] ?? ''}`);
    }

    const shared: string[] = [];
    for (const g of ground) {
      const label = fold(g.label);
      if (label !== '' && hasAll(all, label) && !shared.includes(g.label)) shared.push(g.label);
    }
    for (const a of alumni) {
      const hit = ground.find((g) => fold(g.label) === a)?.label ?? target.alumni?.find((x) => fold(x) === a);
      if (hit && hasAll(all, a) && !shared.includes(hit)) shared.push(hit);
    }
    const alumniHit = shared.filter((s) => alumni.includes(fold(s))).length;
    score += Math.min(36, shared.length * 12) + alumniHit * 4;
    if (shared.length > 0) signals.unshift(`shares ${shared.join(', ')}`);

    const recent = fold(facts);
    if (ACTIVITY.test(recent) || years.some((y) => recent.includes(y))) {
      score += ACTIVITY.test(recent) && years.some((y) => recent.includes(y)) ? 12 : 6;
      signals.push('recent public activity');
    }

    const why = person.why.trim() || signals.slice(0, 3).join('; ') || 'Works at the company';
    return {
      person,
      score: Math.max(0, Math.min(100, Math.round(score))),
      why: why.charAt(0).toUpperCase() + why.slice(1),
      sharedGround: shared,
      signals,
    };
  });
  return ranked.sort((a, b) => b.score - a.score || a.person.fullName.localeCompare(b.person.fullName));
}
