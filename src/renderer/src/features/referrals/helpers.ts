// Pure helpers for the Referrals tab and screen. No React, no IPC: unit-tested.
import { normCompany, type DropReason, type ReferralStatus } from '@shared/referrals';
import { lintRules } from '@shared/rules';
import type { Tone } from '../../ui/StatusDot';
import type { ReferralItem, SearchOutcome, SearchStage } from '../../lib/referrals';

export const REFERRALS = '/referrals';
export const DEFAULT_NOTE_LIMIT = 300;
export const BOUNDARY_LINE =
  'Public sources only. Stellio never guesses emails or sends messages. You send them yourself.';

export const STATUS_LABEL: Record<ReferralStatus, string> = {
  not_contacted: 'Not contacted',
  contacted: 'Contacted',
  replied: 'Replied',
  referred: 'Referred',
  declined: 'Declined',
  no_response: 'No response',
};
export const STATUS_TONE: Record<ReferralStatus, Tone> = {
  not_contacted: 'neutral',
  contacted: 'info',
  replied: 'signal',
  referred: 'ok',
  declined: 'bad',
  no_response: 'warn',
};
export const STATUS_OPTIONS = (Object.keys(STATUS_LABEL) as ReferralStatus[]).map((value) => ({
  value,
  label: STATUS_LABEL[value],
}));

export const PROFILE_KIND_LABEL: Record<string, string> = {
  linkedin: 'LinkedIn',
  github: 'GitHub',
  company: 'Company page',
  personal: 'Personal site',
  other: 'Profile',
};

export const STAGE_LABEL: Record<SearchStage, string> = {
  searching: 'Searching public pages',
  validating: 'Checking sources',
  saving: 'Saving people',
};

const DROP_LABEL: Record<DropReason, string> = {
  no_name: 'no usable name',
  wrong_company: 'other company',
  company_not_in_facts: 'company not on a source page',
  no_profile_url: 'no public profile link',
  no_sourced_fact: 'no sourced fact',
  duplicate: 'already found',
  over_limit: 'over the limit',
};

/** "2 people", "1 person". */
export const peopleCount = (n: number): string => `${String(n)} ${n === 1 ? 'person' : 'people'}`;

/** One line about a finished search; the "Search more" hint comes from the caller. */
export function outcomeLine(o: SearchOutcome): string {
  const kept = o.kept === 0 ? 'No new people found.' : `Found ${peopleCount(o.kept)}.`;
  const dropped = o.dropped.filter((d) => d.reason !== 'duplicate').reduce((n, d) => n + d.count, 0);
  if (dropped === 0) return kept;
  const why = o.dropped
    .filter((d) => d.reason !== 'duplicate')
    .map((d) => `${String(d.count)} ${DROP_LABEL[d.reason]}`)
    .join(', ');
  return `${kept} ${String(dropped)} dropped by the checks: ${why}.`;
}

/** Names and profile links of people already stored for this company: "Search more" asks for different ones. */
export function excludeFor(
  all: readonly ReferralItem[],
  company: string,
): { names: string[]; profileUrls: string[] } {
  const target = normCompany(company);
  const seen = new Map<string, ReferralItem['person']>();
  for (const i of all) if (normCompany(i.person.company) === target) seen.set(i.person.id, i.person);
  const people = [...seen.values()];
  return {
    names: people.map((p) => p.fullName).slice(0, 200),
    profileUrls: people.flatMap((p) => p.profileUrls.map((u) => u.url)).slice(0, 600),
  };
}

/** Comma or semicolon separated input to a trimmed list without empties. */
export const splitList = (text: string): string[] =>
  text
    .split(/[,;]/)
    .map((t) => t.trim())
    .filter(Boolean);

const day = (iso: string): string => iso.slice(0, 10);
/** Follow-up column text: the day, marked "(due)" once main says it is due; empty when none is planned. */
export function followUpText(i: Pick<ReferralItem, 'nextActionAt'>, due: boolean): string {
  if (i.nextActionAt === null) return '';
  return due ? `${day(i.nextActionAt)} (due)` : day(i.nextActionAt);
}
export const contactedText = (i: Pick<ReferralItem, 'contactedAt'>): string =>
  i.contactedAt ? day(i.contactedAt) : '';

export const filterByStatus = (items: readonly ReferralItem[], status: string): ReferralItem[] =>
  status === 'any' ? [...items] : items.filter((i) => i.status === status);

/** The connection-note limit from `rules/referral-message.md`; the default when the file is unreadable. */
export function noteLimit(rulesContent: string | undefined): number {
  if (!rulesContent) return DEFAULT_NOTE_LIMIT;
  return lintRules('referral-message', rulesContent).config?.connection_note.max_chars ?? DEFAULT_NOTE_LIMIT;
}

/** "www.nimbusanalytics.test/team": a short, readable link label. */
export function linkLabel(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/$/, '');
    return `${u.host.replace(/^www\./, '')}${path.length > 40 ? `${path.slice(0, 39)}…` : path}`;
  } catch {
    return url;
  }
}

export const LANGUAGE_LABEL: Record<string, string> = { en: 'English', de: 'German' };
