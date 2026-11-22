import { describe, expect, it } from 'vitest';
import {
  contactedText,
  excludeFor,
  filterByStatus,
  followUpText,
  linkLabel,
  noteLimit,
  outcomeLine,
  splitList,
} from '../../../src/renderer/src/features/referrals/helpers';
import type { ReferralItem, SearchOutcome } from '../../../src/renderer/src/lib/referrals';

const item = (over: Partial<ReferralItem> & { name?: string; company?: string } = {}): ReferralItem =>
  ({
    id: `r-${over.name ?? 'a'}`,
    personId: `p-${over.name ?? 'a'}`,
    status: 'not_contacted',
    nextActionAt: null,
    contactedAt: null,
    person: {
      id: `p-${over.name ?? 'a'}`,
      fullName: over.name ?? 'Jane Doe',
      company: over.company ?? 'Nimbus Analytics GmbH',
      profileUrls: [{ url: `https://github.com/${over.name ?? 'jane'}`, kind: 'github' }],
    },
    ...over,
  }) as unknown as ReferralItem;

describe('excludeFor', () => {
  it('lists names and profile links of people stored for the same company, once each', () => {
    const all = [
      item({ name: 'Jane Doe' }),
      item({ name: 'Jane Doe', id: 'second-request' }),
      item({ name: 'John Roe', company: 'Nimbus Analytics' }),
      item({ name: 'Una Other', company: 'Initech' }),
    ];
    expect(excludeFor(all, 'Nimbus Analytics GmbH')).toEqual({
      names: ['Jane Doe', 'John Roe'],
      profileUrls: ['https://github.com/Jane Doe', 'https://github.com/John Roe'],
    });
    expect(excludeFor([], 'Nimbus')).toEqual({ names: [], profileUrls: [] });
  });
});

describe('follow-up helpers', () => {
  const planned = item({
    status: 'contacted',
    nextActionAt: '2026-11-27T12:00:00.000Z',
    contactedAt: '2026-11-20T12:00:00.000Z',
  });
  it('shows the day, marks it when main says it is due, and is empty without a plan', () => {
    expect(followUpText(planned, true)).toBe('2026-11-27 (due)');
    expect(followUpText(planned, false)).toBe('2026-11-27');
    expect(followUpText(item(), true)).toBe('');
    expect(contactedText(planned)).toBe('2026-11-20');
    expect(contactedText(item())).toBe('');
  });
});

describe('small helpers', () => {
  it('filters by status', () => {
    const rows = [item({ name: 'a' }), item({ name: 'b', status: 'replied' })];
    expect(filterByStatus(rows, 'any')).toHaveLength(2);
    expect(filterByStatus(rows, 'replied').map((r) => r.id)).toEqual(['r-b']);
  });
  it('splits comma lists', () => {
    expect(splitList(' Example University, ; Globex ,')).toEqual(['Example University', 'Globex']);
    expect(splitList('')).toEqual([]);
  });
  it('reads the note limit from the rules file, with a default', () => {
    expect(noteLimit(undefined)).toBe(300);
    expect(noteLimit('not a rules file')).toBe(300);
    expect(
      noteLimit(
        '---\nversion: 1\nconnection_note:\n  max_chars: 200\nmessage:\n  words: { min: 60, max: 140 }\n  subject_max_chars: 70\nmatch_language: true\nmust_include: [role_title]\nbanned_phrases: []\nfirst_person: true\n---\n',
      ),
    ).toBe(200);
  });
  it('shortens links', () => {
    expect(linkLabel('https://www.nimbusanalytics.test/team')).toBe('nimbusanalytics.test/team');
    expect(linkLabel('nope')).toBe('nope');
  });
  it('describes a search outcome, without counting duplicates as dropped', () => {
    const o = (kept: number, dropped: SearchOutcome['dropped']) =>
      ({ returned: 5, kept, dropped, items: [] }) as SearchOutcome;
    expect(outcomeLine(o(3, []))).toBe('Found 3 people.');
    expect(outcomeLine(o(1, []))).toBe('Found 1 person.');
    expect(outcomeLine(o(0, [{ reason: 'duplicate', count: 2 }]))).toBe('No new people found.');
    expect(outcomeLine(o(2, [{ reason: 'no_profile_url', count: 1 }]))).toBe(
      'Found 2 people. 1 dropped by the checks: 1 no public profile link.',
    );
  });
});
