/** Below this many characters a posting is almost certainly a snippet (Adzuna sends about 500). */
export const SHORT_POSTING_CHARS = 600;

/**
 * True when the stored posting text looks cut off by its source: it ends in an ellipsis, or is very short.
 * Scores only ever see this text, so such a job is worth giving its full text.
 */
export function looksCutOff(md: string): boolean {
  const t = md.trim();
  return t.length < SHORT_POSTING_CHARS || /(…|\.\.\.)$/.test(t);
}
