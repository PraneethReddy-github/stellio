import { z } from 'zod';
import { SKILL_CATEGORIES } from '../profile/types';
import raw from './dictionary.json';
import { SKILL_FAMILIES } from './families';

export { SKILL_FAMILIES };

const EntrySchema = z.object({
  name: z.string(),
  category: z.enum(SKILL_CATEGORIES),
  aliases: z.array(z.string()).optional(),
  /** Terms that are also everyday words or letters ("Go", "R", "Spark"); see `findSkills`. */
  ambiguous: z.array(z.string()).optional(),
});

export interface DictSkill {
  name: string;
  category: (typeof SKILL_CATEGORIES)[number];
  /** Name first, then aliases. */
  terms: string[];
  ambiguous: ReadonlySet<string>;
}

export interface SkillHit {
  skill: DictSkill;
  /** The text as written. */
  text: string;
  index: number;
}

/** The built-in skill dictionary (docs/07 §1). */
export const SKILL_DICTIONARY: readonly DictSkill[] = z
  .array(EntrySchema)
  .parse(raw)
  .map((e) => ({
    name: e.name,
    category: e.category,
    terms: [e.name, ...(e.aliases ?? [])],
    ambiguous: new Set(e.ambiguous ?? []),
  }));

const key = (s: string): string => s.normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' ');
const BY_TERM = new Map<string, { skill: DictSkill; term: string }>();
for (const skill of SKILL_DICTIONARY) for (const term of skill.terms) BY_TERM.set(key(term), { skill, term });

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Longest terms first so "Spring Boot" wins over "Spring" and "C++" over "C" at the same position.
const TERMS_RE = new RegExp(
  `(?<![\\p{L}\\p{N}+#])(?:${[...BY_TERM.values()]
    .map((v) => v.term)
    .sort((a, b) => b.length - a.length)
    .map((t) => escapeRe(t).replace(/ /g, '\\s+'))
    .join('|')})(?![\\p{L}\\p{N}+#])`,
  'giu',
);

/** Words that show a nearby ambiguous term is technical ("statistical models in R", "Go services"). */
const CONTEXT =
  /(?<![\p{L}])(?:languages?|code|coding|codebase|librar(?:y|ies)|packages?|frameworks?|scripts?|scripting|programming|developers?|APIs?|SDKs?|stack|compiler|backend|back-end|frontend|front-end|services?|microservices?|clusters?|statistical|statistics|models?|queries|jobs?|apps?|applications?|modules?|tooling|engine)(?![\p{L}])/iu;

/** The dictionary entry for a skill name or alias. */
export function lookupSkill(name: string): DictSkill | undefined {
  return BY_TERM.get(key(name))?.skill;
}

/**
 * Dictionary skills mentioned in `text`: alias-aware, case-insensitive, whole words (`+` and `#` count as word
 * characters, so "Java" is not found in "JavaScript" and "C" not in "C++").
 *
 * Ambiguous terms (marked in the dictionary: Go, R, C, Swift, Rust, Spark, React, Excel…) only count when
 * 1. written with the dictionary's casing ("Go", not "go"), and
 * 2. not glued to a word by `-`, `&`, `'` or `/` ("Go-to-market", "R&D", "C-suite"), and
 * 3. for one-letter terms and for terms that start a sentence: the same sentence also names another skill or has
 *    a technical word (code, language, library, services, models, …).
 * This misses an ambiguous skill written in lower case; it never reads the verb "go" as the language.
 */
export function findSkills(input: string): SkillHit[] {
  const text = input.normalize('NFKC');
  const raw: (SkillHit & { term: string; needsContext: boolean })[] = [];
  for (const m of text.matchAll(TERMS_RE)) {
    const hit = BY_TERM.get(key(m[0]));
    if (!hit) continue;
    const index = m.index;
    let needsContext = false;
    if (hit.skill.ambiguous.has(hit.term)) {
      if (m[0].replace(/\s+/g, ' ') !== hit.term) continue;
      const before = text.slice(Math.max(0, index - 2), index);
      const after = text.slice(index + m[0].length, index + m[0].length + 2);
      if (/^[-&'’/]\p{L}/u.test(after) || /\p{L}[-&'’/]$/u.test(before)) continue;
      const prev = text.slice(0, index).trimEnd();
      needsContext = hit.term.length === 1 || prev === '' || /[.!?]$/.test(prev);
    }
    raw.push({ skill: hit.skill, text: m[0], index, term: hit.term, needsContext });
  }
  const sentenceOf = (i: number): [number, number] => {
    const start = Math.max(...[...text.slice(0, i).matchAll(/[.!?](?:\s|$)/g)].map((m) => m.index + 1), 0);
    const rest = /[.!?](?:\s|$)/.exec(text.slice(i));
    return [start, rest ? i + rest.index : text.length];
  };
  return raw
    .filter((h) => {
      if (!h.needsContext) return true;
      const [a, b] = sentenceOf(h.index);
      return (
        raw.some((o) => o !== h && !o.needsContext && o.index >= a && o.index < b) ||
        CONTEXT.test(text.slice(a, b).replace(h.text, ' '))
      );
    })
    .map(({ skill, text: t, index }) => ({ skill, text: t, index }));
}

const FAMILY_OF = new Map<string, readonly string[]>();
for (const fam of SKILL_FAMILIES) {
  const names = fam.flatMap((n) => lookupSkill(n)?.name ?? []);
  for (const n of names) FAMILY_OF.set(n, names);
}

/** Close substitutes of a skill (its family minus itself, canonical names); empty when it has none. */
export function skillFamilyMates(name: string): string[] {
  const canon = lookupSkill(name)?.name;
  return canon === undefined ? [] : (FAMILY_OF.get(canon) ?? []).filter((n) => n !== canon);
}
