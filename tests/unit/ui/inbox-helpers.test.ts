import { describe, expect, it } from 'vitest';
import type { InboxItem, ScanRun } from '../../../src/shared/discovery/schemas';
import {
  NO_FILTERS,
  applyLocalFilters,
  dismissReason,
  inboxQuery,
  isFiltered,
  lastScanLine,
  matchesProfile,
  neighbour,
  scoreTone,
  sourceErrors,
} from '../../../src/renderer/src/features/inbox/helpers';
import {
  buildDiscovery,
  formToProfile,
  isCareersUrl,
  parseList,
  profileToForm,
  toDiscoveryForm,
} from '../../../src/renderer/src/features/settings/discoveryHelpers';
import { DEFAULT_DISCOVERY_SETTINGS } from '../../../src/shared/discovery/schemas';

const item = (jobId: string, title: string, firstSeenAt = '2026-11-21T08:00:00.000Z'): InboxItem => ({
  jobId,
  company: 'Acme',
  title,
  locationText: null,
  remote: 'remote',
  salaryText: null,
  url: null,
  postedAt: null,
  firstSeenAt,
  score: 80,
  scoreKind: 'triage',
  reason: null,
  rank: 1,
  sources: ['arbeitnow'],
});

describe('inbox helpers', () => {
  it('maps filters to the inbox query and back to "no filters"', () => {
    expect(inboxQuery(NO_FILTERS)).toEqual({ filters: {}, sort: 'rank', limit: 500 });
    expect(
      inboxQuery({ ...NO_FILTERS, band: '75', remote: 'remote', source: 'ba', text: ' dbt ' }).filters,
    ).toEqual({ minScore: 75, remote: 'remote', source: 'ba', text: 'dbt' });
    expect(isFiltered(NO_FILTERS)).toBe(false);
    expect(isFiltered({ ...NO_FILTERS, newOnly: true })).toBe(true);
    expect(isFiltered({ ...NO_FILTERS, text: '  ' })).toBe(false);
  });

  it('colours scores like the fit meter', () => {
    expect([null, 90, 75, 60, 49].map(scoreTone)).toEqual(['neutral', 'ok', 'ok', 'warn', 'bad']);
  });

  it('matches a search profile on roles and keywords in the title, accents ignored', () => {
    const p = { roles: ['Data Engineer'], keywords: ['Analytik'] };
    expect(matchesProfile(item('1', 'Senior Data Engineer (m/w/d)'), p)).toBe(true);
    expect(matchesProfile(item('2', 'Analytik-Spezialist'), p)).toBe(true);
    expect(matchesProfile(item('3', 'Marketing Manager'), p)).toBe(false);
    expect(matchesProfile(item('4', 'Anything'), { roles: [], keywords: [] })).toBe(true);
  });

  it('keeps only jobs first seen at or after the last scan started', () => {
    const rows = [item('old', 'A', '2026-11-20T08:00:00.000Z'), item('new', 'B', '2026-11-21T08:00:01.000Z')];
    const scan = { startedAt: '2026-11-21T08:00:00.000Z' };
    expect(
      applyLocalFilters(rows, { profileId: 'any', newOnly: true }, [], scan).map((r) => r.jobId),
    ).toEqual(['new']);
    expect(applyLocalFilters(rows, { profileId: 'any', newOnly: true }, [], null)).toEqual([]);
    expect(applyLocalFilters(rows, { profileId: 'any', newOnly: false }, [], null)).toHaveLength(2);
  });

  it('joins the dismissal reason and note, capped at 200 characters', () => {
    expect(dismissReason('salary', '')).toBe('Salary');
    expect(dismissReason('other', ' too far ')).toBe('Other: too far');
    expect(dismissReason('bogus', '')).toBe('Other');
    expect(dismissReason('company', 'x'.repeat(300))).toHaveLength(200);
  });

  it('picks the next row, else the previous, after one leaves', () => {
    const rows = [{ jobId: 'a' }, { jobId: 'b' }, { jobId: 'c' }];
    expect([neighbour(rows, 'a'), neighbour(rows, 'b'), neighbour(rows, 'c')]).toEqual(['b', 'c', 'b']);
    expect(neighbour([{ jobId: 'a' }], 'a')).toBeNull();
    expect(neighbour(rows, 'zzz')).toBeNull();
  });

  const run = (perSource: ScanRun['perSource']): ScanRun => ({
    id: 'r',
    startedAt: '2026-11-21T08:00:00.000Z',
    finishedAt: null,
    trigger: 'manual',
    status: 'partial',
    newJobs: 3,
    perSource,
    error: null,
  });

  it('lists sources with errors and summarises the last scan', () => {
    const r = run({
      ba: { fetched: 0, new: 0, errors: ['timed out', 'again'] },
      remotive: { fetched: 4, new: 3, errors: [] },
      pipeline: { fetched: 0, new: 0, errors: [] },
    });
    expect(sourceErrors(r)).toEqual([{ source: 'ba', message: 'timed out', more: 1 }]);
    expect(sourceErrors(null)).toEqual([]);
    expect(lastScanLine(r, (x) => x.slice(0, 10))).toBe('Last scan 2026-11-21 · partial · 3 new · 2 sources');
    expect(lastScanLine(null, String)).toBe('No scan yet.');
  });
});

describe('discovery settings helpers', () => {
  it('parses comma and line separated lists without empties or repeats', () => {
    expect(parseList(' Berlin, remote\nberlin,, Munich ')).toEqual(['Berlin', 'remote', 'Munich']);
    expect(parseList('')).toEqual([]);
  });

  it('turns the profile form into a validated profile and refuses bad values', () => {
    const form = {
      ...profileToForm({
        name: 'Main',
        roles: ['Data Engineer'],
        keywords: [],
        excludeKeywords: [],
        locations: ['Germany'],
        remoteOk: true,
        countries: [],
        seniority: ['senior'],
        salaryFloor: 60000,
        currency: 'EUR',
        languages: [],
        excludedCompanies: [],
        enabled: true,
      }),
    };
    const ok = formToProfile({ ...form, roles: 'Data Engineer, Analytics Engineer', salaryFloor: '70000' });
    expect(ok).toMatchObject({
      ok: true,
      value: { roles: ['Data Engineer', 'Analytics Engineer'], salaryFloor: 70000 },
    });
    expect(formToProfile({ ...form, salaryFloor: '' })).toMatchObject({
      ok: true,
      value: { salaryFloor: null },
    });
    expect(formToProfile({ ...form, salaryFloor: '12.5' })).toMatchObject({ ok: false });
    expect(formToProfile({ ...form, name: '  ' })).toMatchObject({ ok: false });
    expect(formToProfile({ ...form, currency: 'x'.repeat(20) })).toMatchObject({ ok: false });
  });

  it('builds discovery settings from text, keeping unedited values', () => {
    const f = toDiscoveryForm(DEFAULT_DISCOVERY_SETTINGS);
    expect(buildDiscovery(f, DEFAULT_DISCOVERY_SETTINGS)).toEqual(DEFAULT_DISCOVERY_SETTINGS);
    expect(buildDiscovery({ ...f, threshold: '80', fit: '0.5' }, DEFAULT_DISCOVERY_SETTINGS)).toMatchObject({
      analyzeThreshold: 80,
      maxParsePerScan: 40,
      weights: { fit: 0.5, recency: 0.15 },
    });
    expect(buildDiscovery({ ...f, threshold: '101' }, DEFAULT_DISCOVERY_SETTINGS)).toBeNull();
    expect(buildDiscovery({ ...f, perDay: '' }, DEFAULT_DISCOVERY_SETTINGS)).toBeNull();
    expect(buildDiscovery({ ...f, fit: '1.5' }, DEFAULT_DISCOVERY_SETTINGS)).toBeNull();
  });

  it('accepts http(s) careers URLs only', () => {
    expect(isCareersUrl('https://boards.greenhouse.io/acme')).toBe(true);
    expect(isCareersUrl(' http://127.0.0.1:4000/x ')).toBe(true);
    expect(isCareersUrl('ftp://x.com')).toBe(false);
    expect(isCareersUrl('acme.com/jobs')).toBe(false);
  });
});
