import { canonicalSkillKey } from '../profile';

/** Lower-cased, NFKC, whitespace-collapsed text for keyword matching. */
export function normText(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ');
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * True when `term` occurs in `text` as a whole word. Alphanumerics, `+` and `#` count as word characters, so
 * "Java" does not match "JavaScript" and "C" does not match "C++". Terms of 1-2 characters ("Go", "R") match
 * case-sensitively so the verb "go" is not the language.
 */
export function hasTerm(text: string, term: string): boolean {
  const key = canonicalSkillKey(term);
  if (key === '') return false;
  const re = new RegExp(`(?<![\\p{L}\\p{N}+#])${escapeRe(key)}(?![\\p{L}\\p{N}+#])`, 'u');
  if (key.length <= 2) {
    const exact = new RegExp(
      `(?<![\\p{L}\\p{N}+#])${escapeRe(term.normalize('NFKC').trim())}(?![\\p{L}\\p{N}+#])`,
      'u',
    );
    return exact.test(text.normalize('NFKC'));
  }
  return re.test(normText(text));
}
