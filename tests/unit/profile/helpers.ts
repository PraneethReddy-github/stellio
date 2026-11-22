import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseProfile } from '../../../src/shared/profile';

const dir = fileURLToPath(new URL('../../fixtures/profiles/', import.meta.url));

export const fixtureNames = readdirSync(dir)
  .filter((f) => f.endsWith('.md'))
  .map((f) => f.slice(0, -3));

export const fixture = (name: string): string => readFileSync(`${dir}${name}.md`, 'utf8');

export const seedTemplate = (): string =>
  readFileSync(fileURLToPath(new URL('../../../seed/profile/praneethreddy.md', import.meta.url)), 'utf8');

/** Lines that differ between two texts once the common prefix and suffix lines are removed. */
export function changedLines(before: string, after: string): { removed: string[]; added: string[] } {
  const a = before.split(/(?<=\n)/);
  const b = after.split(/(?<=\n)/);
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  return { removed: a.slice(p, a.length - s), added: b.slice(p, b.length - s) };
}

export const modelOf = (text: string) => parseProfile(text).model;
