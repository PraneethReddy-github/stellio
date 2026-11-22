// The numbers check for `insights.ask` (docs/08 §5): every number the answer states must be listed in
// `numbers_used`, and every listed number must exist in the data the model was given. Pure.
import type { InsightsAskOutput } from './schemas';

// A number not glued to a letter or another number ("v2", "Q3" and "2026-11" parts are not read as counts).
const NUMBER = /(?<![\p{L}\p{N}.])\d+(?:[.,]\d+)?(?![\p{L}\p{N}])/gu;
/** Markdown list numbering ("1. ", "2) ") is formatting, not a claim. */
const LIST_MARKER = /^[ \t]*\d+[.)][ \t]+/gm;

const toNumber = (token: string): number => Number(token.replace(',', '.'));

/** Every number in `text` as a value ("41%" and "41" are both 41). */
export function numbersIn(text: string): number[] {
  return [...text.replace(LIST_MARKER, '').matchAll(NUMBER)].map((m) => toNumber(m[0]));
}

export interface NumbersCheck {
  ok: boolean;
  /** One line per problem, written for the model's repair round and for the warning shown to the user. */
  issues: string[];
}

/**
 * `inputText` is the exact data text the model saw. Percentages in it are whole numbers, so "41%" in the
 * answer is the value 41 in the data. A number may be rounded only by being listed as such in `numbers_used`
 * and present in the data, so a rounded or derived figure fails the check.
 */
export function checkNumbers(out: InsightsAskOutput, inputText: string): NumbersCheck {
  const data = new Set(numbersIn(inputText));
  const listed = new Set(out.numbers_used.flatMap((n) => numbersIn(n.value)));
  const issues: string[] = [];
  for (const m of out.answer.replace(LIST_MARKER, '').matchAll(NUMBER))
    if (!listed.has(toNumber(m[0]))) issues.push(`"${m[0]}" is in the answer but not in numbers_used.`);
  for (const n of out.numbers_used) {
    const values = numbersIn(n.value);
    if (values.length === 0) issues.push(`numbers_used "${n.label}" has no number in "${n.value}".`);
    for (const v of values)
      if (!data.has(v)) issues.push(`numbers_used "${n.label}": ${String(v)} does not appear in the data.`);
  }
  return { ok: issues.length === 0, issues: [...new Set(issues)] };
}
