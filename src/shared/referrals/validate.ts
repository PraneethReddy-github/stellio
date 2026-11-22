import {
  MAX_CANDIDATES,
  type DropReason,
  type ProfileUrl,
  type PublicContact,
  type RawCandidate,
  type ValidPerson,
} from './schemas';

// Code-side validation of `referrals.search` output (docs/14 §1, §2). The model is never trusted: every URL host,
// every contact and every fact is checked here. Pure.

/**
 * Data brokers, people-search and contact-lookup sites (docs/14 §1: never used, never stored) and platforms
 * whose accounts are private or not for professional contact. Registrable domains.
 */
export const DENIED_DOMAINS: ReadonlySet<string> = new Set(
  `apollo.io rocketreach.co hunter.io zoominfo.com lusha.com signalhire.com contactout.com clearbit.com snov.io
leadiq.com seamless.ai peopledatalabs.com spokeo.com whitepages.com beenverified.com pipl.com 192.com
truepeoplesearch.com fastpeoplesearch.com radaris.com mylife.com intelius.com peekyou.com zabasearch.com
adapt.io uplead.com kaspr.io salesintel.io wiza.co skrapp.io voilanorbert.com anymailfinder.com getprospect.com
email-format.com datanyze.com cognism.com swordfish.ai theorg.com people.ai rocketreach.com findthatlead.com
contactzilla.com emailhunter.co norbert.com aeroleads.com leadfeeder.com crunchbase.com owler.com dnb.com
peoplefinders.com ussearch.com instantcheckmate.com thatsthem.com nuwber.com clustrmaps.com cocofinder.com
facebook.com instagram.com tiktok.com snapchat.com whatsapp.com t.me telegram.org vk.com xing.com twitter.com x.com
google.com bing.com duckduckgo.com yahoo.com baidu.com yandex.com web.archive.org archive.org archive.ph`.split(
    /\s+/,
  ),
);

/** Second-level public suffixes, so "sap.co.uk" is not read as "co.uk". */
const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'ac', 'gov', 'edu', 'ltd', 'plc']);

const GITHUB_RESERVED = new Set(
  `about features topics search login join settings sponsors marketplace pricing explore notifications issues pulls
orgs organizations enterprise collections trending events apps new codespaces readme security site contact`.split(
    /\s+/,
  ),
);

/** Folds case and diacritics, turns punctuation into single spaces. */
export function fold(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const LEGAL = new Set(
  'se ag gmbh kg ohg inc incorporated ltd limited llc llp corp corporation plc co sa sas bv nv ab oy as srl spa the group holding holdings'.split(
    ' ',
  ),
);
/** "SAP SE" → "sap", "Müller & Söhne GmbH" → "muller sohne". */
export function normCompany(name: string): string {
  const words = fold(name)
    .split(' ')
    .filter((w) => w !== '');
  while (words.length > 1 && LEGAL.has(words[words.length - 1] ?? '')) words.pop();
  return words.filter((w, i) => !(w === 'the' && i === 0)).join(' ');
}

const normName = (name: string): string =>
  fold(name)
    .split(' ')
    .filter((w) => !['dr', 'prof', 'mr', 'mrs', 'ms', 'ing', 'dipl'].includes(w))
    .join(' ');

/** Identity of a person: normalised name + company. */
export const personKey = (name: string, company: string): string =>
  `${normName(name)}|${normCompany(company)}`;

/** Whole-word (sequence) containment on folded text. */
const containsPhrase = (haystack: string, phrase: string): boolean =>
  phrase !== '' && ` ${fold(haystack)} `.includes(` ${phrase} `);

export const registrable = (host: string): string => {
  const labels = host.split('.');
  if (labels.length <= 2) return host;
  const second = labels[labels.length - 2] ?? '';
  const tld = labels[labels.length - 1] ?? '';
  return SECOND_LEVEL.has(second) && tld.length === 2
    ? labels.slice(-3).join('.')
    : labels.slice(-2).join('.');
};

/** http(s) URL without credentials, a dotted non-IP host and no fragment; null otherwise. */
export function parseWebUrl(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username !== '' || u.password !== '') return null;
  const host = u.hostname.replace(/\.$/, '').toLowerCase();
  if (!host.includes('.') || /^[\d.]+$/.test(host) || host.includes(':') || host.endsWith('.local'))
    return null;
  u.hash = '';
  return u;
}

const hostOf = (u: URL): string =>
  u.hostname
    .replace(/\.$/, '')
    .toLowerCase()
    .replace(/^www\./, '');
export const isDeniedHost = (host: string): boolean => DENIED_DOMAINS.has(registrable(host));

/** Comparison key of a page URL: host + path, no scheme, "www.", query or trailing slash. */
export function urlKey(raw: string): string | null {
  const u = parseWebUrl(raw);
  return u ? `${hostOf(u)}${u.pathname.replace(/\/+$/, '').toLowerCase()}` : null;
}

/** True when `host` belongs to the company: a known domain, or a domain whose name is the company's name. */
export function isCompanyHost(host: string, company: string, domains: readonly string[]): boolean {
  const reg = registrable(host);
  if (domains.some((d) => registrable(d.toLowerCase().replace(/^www\./, '')) === reg)) return true;
  const name = normCompany(company).replace(/ /g, '');
  const label = reg.split('.')[0] ?? '';
  return name.length >= 3 && label === name;
}

/**
 * The kind of profile URL and its cleaned form, or null when the host is not allowed: linkedin.com/in/*,
 * github.com/<user>, gitlab.com/<user>, the company's own domains, or a personal site that is not on the denylist.
 */
export function classifyProfileUrl(
  raw: string,
  company: string,
  domains: readonly string[] = [],
): ProfileUrl | null {
  const u = parseWebUrl(raw);
  if (!u) return null;
  const host = hostOf(u);
  if (isDeniedHost(host)) return null;
  const reg = registrable(host);
  const segs = u.pathname.split('/').filter(Boolean);
  if (reg === 'linkedin.com') {
    const slug = segs[0] === 'in' ? segs[1] : undefined;
    return slug ? { url: `https://www.linkedin.com/in/${slug}`, kind: 'linkedin' } : null;
  }
  if (reg === 'github.com') {
    const user = segs[0];
    if (!user || segs.length > 1 || GITHUB_RESERVED.has(user.toLowerCase())) return null;
    return { url: `https://github.com/${user}`, kind: 'github' };
  }
  if (reg === 'gitlab.com') {
    return segs.length === 1 ? { url: `https://gitlab.com/${segs[0] ?? ''}`, kind: 'other' } : null;
  }
  u.search = '';
  const clean = u.href.replace(/\/$/, '');
  return { url: clean, kind: isCompanyHost(host, company, domains) ? 'company' : 'personal' };
}

// ---- phone numbers (never stored) --------------------------------------------------------------------------

const PHONE_RES: RegExp[] = [
  /\b(?:phone|tel|telephone|mobile|mob|fax|handy|telefon)\b\s*[:.]?\s*[+(]?\d[\d\s().-]{5,}\d/gi,
  /(?<![\w@/])(?:\+|00)\d[\d\s().-]{6,}\d/g,
  /(?<![\w@/])\(\d{2,5}\)[\s.-]?\d[\d\s.-]{4,}\d/g,
  /(?<![\w@/.])\d{2,5}[-.]\d{3,}[-.]\d{3,}(?![\w])/g,
];
/** Removes phone numbers from free text. */
export function stripPhones(text: string): string {
  return PHONE_RES.reduce((t, re) => t.replace(re, ''), text)
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.;:])/g, '$1')
    .trim();
}
const looksLikePhone = (v: string): boolean =>
  /^(?:tel:|callto:|sms:)/i.test(v.trim()) ||
  (/^[+()\d\s.-]{7,}$/.test(v.trim()) && v.replace(/\D/g, '').length >= 7);

const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

export interface ValidationContext {
  /** The company the search was for. */
  company: string;
  /** The company's own web domains, when known. */
  companyDomains?: readonly string[];
  now: Date;
  /** Default 25. */
  max?: number;
  /** People already found ("search more"): a match counts as a duplicate. */
  exclude?: { names: readonly string[]; profileUrls: readonly string[] };
}

export interface ValidationResult {
  people: ValidPerson[];
  dropped: { reason: DropReason; count: number }[];
  returned: number;
}

const countryOf = (location: string): string | null => {
  const parts = location.split(',').map((p) => p.trim());
  return parts.length > 1 ? parts[parts.length - 1] || null : null;
};

/**
 * Keeps only candidates whose every field can be traced to a public page the model cited (docs/14 §2):
 * company on a source, an allowed profile host, sourced facts, contacts only when published and cited (emails
 * must appear in a cited fact's text; no guessing exists anywhere), phone numbers stripped, duplicates and
 * anything beyond 25 dropped. Pure.
 */
export function validateCandidates(raw: readonly RawCandidate[], ctx: ValidationContext): ValidationResult {
  const max = Math.min(ctx.max ?? MAX_CANDIDATES, MAX_CANDIDATES);
  const target = normCompany(ctx.company);
  const domains = ctx.companyDomains ?? [];
  const seenAt = ctx.now.toISOString();
  const counts = new Map<DropReason, number>();
  const drop = (r: DropReason): void => void counts.set(r, (counts.get(r) ?? 0) + 1);
  const people: ValidPerson[] = [];
  const keys = new Set<string>();
  for (const n of ctx.exclude?.names ?? []) keys.add(personKey(n, ctx.company));
  for (const u of ctx.exclude?.profileUrls ?? []) {
    const k = urlKey(u);
    if (k) keys.add(`url:${k}`);
  }

  for (const c of raw) {
    const fullName = oneLine(stripPhones(c.full_name));
    if (fullName.length < 3 || !/\p{L}/u.test(fullName) || fullName.includes('@')) {
      drop('no_name');
      continue;
    }
    const cc = normCompany(c.company);
    if (target === '' || cc === '' || !(cc === target || ` ${cc} `.includes(` ${target} `))) {
      drop('wrong_company');
      continue;
    }

    // Facts: each needs text and a source page on an allowed host. Grouped per source.
    const bySource = new Map<string, { url: string; facts: string[] }>();
    const factTexts = new Map<string, string[]>(); // source key → fact texts (raw, for the email check)
    let nFacts = 0;
    for (const f of c.facts) {
      const text = clip(oneLine(stripPhones(f.text)), 300);
      const su = parseWebUrl(f.source_url);
      if (text === '' || !su || isDeniedHost(hostOf(su)) || nFacts >= 8) continue;
      const key = urlKey(f.source_url) ?? '';
      const url = su.href;
      const g = bySource.get(key) ?? { url, facts: [] };
      g.facts.push(text);
      bySource.set(key, g);
      factTexts.set(key, [...(factTexts.get(key) ?? []), f.text]);
      nFacts++;
    }
    if (nFacts === 0) {
      drop('no_sourced_fact');
      continue;
    }
    if (![...bySource.values()].some((g) => g.facts.some((t) => containsPhrase(t, target)))) {
      drop('company_not_in_facts');
      continue;
    }
    const sourceHosts = new Set([...bySource.values()].map((g) => registrable(hostOf(new URL(g.url)))));

    // Profile URLs: allowed hosts only; a personal site must also be a host the facts were read from.
    const profileUrls: ProfileUrl[] = [];
    for (const raw of c.profile_urls) {
      const p = classifyProfileUrl(raw, ctx.company, domains);
      if (!p || profileUrls.some((x) => x.url === p.url)) continue;
      if (p.kind === 'personal' && !sourceHosts.has(registrable(hostOf(new URL(p.url))))) continue;
      profileUrls.push(p);
    }
    if (profileUrls.length === 0) {
      drop('no_profile_url');
      continue;
    }
    const urlKeys = profileUrls.map((p) => urlKey(p.url) ?? '');
    const nameKey = personKey(fullName, ctx.company);
    if (keys.has(nameKey) || urlKeys.some((k) => keys.has(`url:${k}`))) {
      drop('duplicate');
      continue;
    }
    if (people.length >= max) {
      drop('over_limit');
      continue;
    }

    // Contacts: only when published and cited. The cited page must be one of this candidate's sources.
    const citable = new Set([...bySource.keys(), ...urlKeys]);
    const profileHosts = new Set(profileUrls.map((p) => registrable(hostOf(new URL(p.url)))));
    const contacts: PublicContact[] = [];
    for (const pc of c.public_contact) {
      const value = pc.value
        .trim()
        .replace(/^mailto:/i, '')
        .replace(/^<|>$/g, '');
      const srcKey = urlKey(pc.source_url);
      const src = parseWebUrl(pc.source_url);
      if (!srcKey || !src || !citable.has(srcKey) || isDeniedHost(hostOf(src))) continue;
      if (/phone|tel|mobile|fax|whatsapp|address|home/i.test(pc.kind) || looksLikePhone(value)) continue;
      let contact: PublicContact | null = null;
      if (EMAIL_RE.test(value)) {
        // The address must be literally in a fact the model reported from the same page.
        const shown = (factTexts.get(srcKey) ?? []).some((t) =>
          t.toLowerCase().includes(value.toLowerCase()),
        );
        if (shown) contact = { kind: 'email', value, source_url: src.href };
      } else {
        const u = parseWebUrl(value);
        const h = u ? registrable(hostOf(u)) : '';
        if (
          u &&
          !isDeniedHost(hostOf(u)) &&
          h !== 'linkedin.com' &&
          (sourceHosts.has(h) || profileHosts.has(h))
        )
          contact = {
            kind: /form|contact/i.test(pc.kind) ? 'contact_form' : 'other',
            value: u.href,
            source_url: src.href,
          };
      }
      if (contact && !contacts.some((x) => x.value.toLowerCase() === contact.value.toLowerCase()))
        contacts.push(contact);
    }

    keys.add(nameKey);
    for (const k of urlKeys) keys.add(`url:${k}`);
    const location = clip(oneLine(stripPhones(c.location)), 120);
    people.push({
      fullName,
      title: clip(oneLine(stripPhones(c.title)), 120),
      company: oneLine(c.company),
      locationText: location,
      country: countryOf(location),
      profileUrls,
      publicContact: contacts,
      sources: [...bySource.values()].map((g) => ({ url: g.url, seen_at: seenAt, facts: g.facts })),
      why: clip(oneLine(stripPhones(c.why)), 240),
    });
  }
  return {
    people,
    dropped: [...counts].map(([reason, count]) => ({ reason, count })),
    returned: raw.length,
  };
}
