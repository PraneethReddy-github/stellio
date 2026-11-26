import type { CoverContent } from './cover';
import type { ResumeContent, TruthViolation } from './schemas';

/**
 * German versions (D27): the model translates only the text of a drafted version. These helpers list the texts
 * with stable keys, put translated texts back without touching ids or structure, and check that a translation
 * adds no number and no technical term its English source does not have. Pure.
 */

export interface TextItem {
  key: string;
  text: string;
}

const BULLET_SECTIONS = ['experience', 'projects', 'education', 'publications', 'patents'] as const;

/** Every text a resume version prints that the model wrote: summary and bullets. Empty texts are skipped. */
export function resumeTexts(c: ResumeContent): TextItem[] {
  const out: TextItem[] = [];
  if (c.summary?.trim()) out.push({ key: 'summary', text: c.summary });
  for (const s of BULLET_SECTIONS)
    c[s].forEach((e, i) => {
      e.bullets.forEach((b, j) => {
        if (b.text.trim()) out.push({ key: `${s}[${String(i)}].bullets[${String(j)}]`, text: b.text });
      });
    });
  return out;
}

/** `c` with the texts in `t` (by key) swapped in; keys not in `t` keep their text. */
export function withResumeTexts(c: ResumeContent, t: ReadonlyMap<string, string>): ResumeContent {
  const out: ResumeContent = structuredClone(c);
  if (out.summary !== null) out.summary = t.get('summary') ?? out.summary;
  for (const s of BULLET_SECTIONS)
    out[s].forEach((e, i) => {
      e.bullets.forEach((b, j) => {
        b.text = t.get(`${s}[${String(i)}].bullets[${String(j)}]`) ?? b.text;
      });
    });
  return out;
}

/** The letter's texts: salutation, paragraphs and closing. */
export function coverTexts(c: CoverContent): TextItem[] {
  const out: TextItem[] = [];
  if (c.salutation?.trim()) out.push({ key: 'salutation', text: c.salutation });
  c.paragraphs.forEach((p, i) => {
    if (p.text.trim()) out.push({ key: `paragraphs[${String(i)}]`, text: p.text });
  });
  if (c.closing?.trim()) out.push({ key: 'closing', text: c.closing });
  return out;
}

export function withCoverTexts(c: CoverContent, t: ReadonlyMap<string, string>): CoverContent {
  return {
    salutation: c.salutation === null ? null : (t.get('salutation') ?? c.salutation),
    paragraphs: c.paragraphs.map((p, i) => ({ ...p, text: t.get(`paragraphs[${String(i)}]`) ?? p.text })),
    closing: c.closing === null ? null : (t.get('closing') ?? c.closing),
  };
}

/** Both readings of a digit group: "1.200" is 1.2 or 1200, "8,01" is 8.01 or 801. */
function readings(tok: string): number[] {
  const dec = Number(tok.replace(/,(?=\d{1,2}$)/, '.').replace(/,/g, ''));
  const grouped = Number(tok.replace(/[.,](?=\d{3}(?:\D|$))/g, '').replace(',', '.'));
  const plain = Number(tok.replace(',', '.'));
  return [dec, grouped, plain].filter((n) => Number.isFinite(n));
}
const numbersIn = (s: string): string[] => s.normalize('NFKC').match(/\d+(?:[.,]\d+)*/g) ?? [];

/**
 * Technical terms: words with a digit, or with a capital letter after the first character ("AWS", "PostgreSQL",
 * "GitHub", "5G"). German capitalises every noun, so plain capitalised words are not terms. Hyphens and slashes
 * split words, so German compounds ("Docker-Container", "CI/CD-Pipelines") are checked part by part.
 */
const termsIn = (s: string): string[] =>
  (s.normalize('NFKC').match(/[\p{L}\p{N}][\p{L}\p{N}+#.]*[\p{L}\p{N}+#]|[\p{L}\p{N}]/gu) ?? []).filter(
    (w) => /\p{N}/u.test(w) || /^.+\p{Lu}/u.test(w),
  );

/**
 * Organisation names in German text: a capitalised word after "bei" ("bei Siemens"), or before a legal suffix
 * ("Bosch GmbH"). German capitalises every noun, so plain capitalised words cannot be told from names.
 */
const ORG_DE = new RegExp(
  "(?<![\\p{L}])[Bb]ei\\s+(\\p{Lu}[\\p{L}\\p{N}&.'-]*)|(\\p{Lu}[\\p{L}\\p{N}&.'-]*)\\s+(?:GmbH|AG|SE|KG|Inc|Ltd|LLC|Corp)\\b",
  'gu',
);

/** Violations for numbers and terms in `target` that `source` does not contain. `path` is the content path. */
export function checkTranslation(items: { key: string; source: string; target: string }[]): TruthViolation[] {
  const out: TruthViolation[] = [];
  for (const { key, source, target } of items) {
    const have = new Set(numbersIn(source).flatMap(readings));
    for (const tok of numbersIn(target))
      if (!readings(tok).some((n) => have.has(n)))
        out.push({
          kind: 'number_not_in_source',
          text: tok,
          detail: `${tok} is not in the English text this was translated from`,
          path: key,
        });
    const src = source.normalize('NFKC').toLowerCase();
    for (const m of target.normalize('NFKC').matchAll(ORG_DE)) {
      const name = m[1] ?? m[2] ?? '';
      if (name !== '' && !src.includes(name.toLowerCase()))
        out.push({
          kind: 'unknown_organisation',
          text: name,
          detail: `"${name}" is not in the English text this was translated from`,
          path: key,
        });
    }
    for (const term of new Set(termsIn(target)))
      if (!/^\d+(?:[.,]\d+)*$/.test(term) && !src.includes(term.toLowerCase()))
        out.push({
          kind: 'term_not_in_source',
          text: term,
          detail: `"${term}" is not in the English text this was translated from`,
          path: key,
        });
  }
  return out;
}
