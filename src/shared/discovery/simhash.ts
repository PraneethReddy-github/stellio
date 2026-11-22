/** 64-bit SimHash over word 3-shingles (FNV-1a per shingle). Near-duplicate = Hamming distance <= 3. */

const MASK = (1n << 64n) - 1n;
const PRIME = 0x100000001b3n;
const MIN_TOKENS = 40;

function fnv64(s: string): bigint {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < s.length; i++) h = ((h ^ BigInt(s.charCodeAt(i))) * PRIME) & MASK;
  return h;
}

/** Hex SimHash, or null when the text is too short for the hash to mean anything. */
export function simhash(text: string): string | null {
  const tokens = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1);
  if (tokens.length < MIN_TOKENS) return null;
  const v = new Array<number>(64).fill(0);
  for (let i = 0; i + 2 < tokens.length; i++) {
    const h = fnv64(`${tokens[i] ?? ''} ${tokens[i + 1] ?? ''} ${tokens[i + 2] ?? ''}`);
    for (let b = 0; b < 64; b++) v[b] = (v[b] ?? 0) + ((h >> BigInt(b)) & 1n ? 1 : -1);
  }
  let out = 0n;
  for (let b = 0; b < 64; b++) if ((v[b] ?? 0) > 0) out |= 1n << BigInt(b);
  return out.toString(16).padStart(16, '0');
}

export function hamming(a: string, b: string): number {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let n = 0;
  while (x) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}

export const NEAR_DUPLICATE_DISTANCE = 3;
export const isNearDuplicate = (a: string | null, b: string | null): boolean =>
  a !== null && b !== null && hamming(a, b) <= NEAR_DUPLICATE_DISTANCE;
