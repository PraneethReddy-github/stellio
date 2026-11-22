/** Duplicate detection key shared by manual intake (Phase 4) and the scan pipeline (Phase 8). */

const COMPANY_SUFFIX =
  /(?:\s(?:gmbh|mbh|ag|se|kg|ug|inc|incorporated|llc|ltd|limited|plc|corp|corporation|co|company|sa|bv|nv|oy|ab|srl|spa|pty|sarl))+$/;
// "(m/w/d)", "(f/m/x)", "m/w/d" and similar German/EU gender markers
const GENDER_MARKER = /\(?\b[mwfdx]\s*[/|]\s*[mwfdx](?:\s*[/|]\s*[mwfdx])?\b\)?/g;

const fold = (s: string): string =>
  s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replaceAll('ß', 'ss').replaceAll('&', ' and ');
const words = (s: string): string =>
  s
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');

export function normalizeCompany(name: string): string {
  const base = words(fold(name));
  return base.replace(COMPANY_SUFFIX, '') || base;
}

export function normalizeTitle(title: string): string {
  return words(fold(title).replace(GENDER_MARKER, ' '));
}

/** `remote` for remote roles, else the city. */
export function normalizeLocation(
  city: string | null | undefined,
  remote: string | null | undefined,
): string {
  return remote === 'remote' ? 'remote' : words(fold(city ?? ''));
}

export interface DedupeInput {
  company: string;
  title: string;
  city?: string | null;
  remote?: string | null;
}

export function dedupeKey({ company, title, city, remote }: DedupeInput): string {
  return [normalizeCompany(company), normalizeTitle(title), normalizeLocation(city, remote)].join('|');
}
