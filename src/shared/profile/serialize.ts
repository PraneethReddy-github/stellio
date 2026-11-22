import type { ProfileDoc } from './types';

/** Exact inverse of `parseProfile(x).doc` for any string x. */
export function serializeProfile(doc: ProfileDoc): string {
  return doc.lines.join('');
}
