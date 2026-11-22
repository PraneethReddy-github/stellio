import { describe, expect, it } from 'vitest';
import { APPLICATION_STATUSES as DB_STATUSES } from '../../../src/main/db/schema';
import {
  APPLICATION_STATUSES,
  LANES,
  applicationFolder,
  ghostedCandidate,
  nextActionFor,
  slugify,
  statusMetaProblem,
  type History,
} from '../../../src/shared/tracker';

/** Local time, so the tests do not depend on the machine's time zone. */
const at = (m: number, d: number, h = 10): string => new Date(2026, m - 1, d, h).toISOString();
const NOW = new Date(2026, 10, 20, 12);
const hist = (over: Partial<History> = {}): History => ({
  appliedAt: null,
  followUps: [],
  interviews: [],
  offerDeadline: null,
  ...over,
});

describe('statuses and lanes', () => {
  it('mirror the DB enum and every status is in exactly one lane', () => {
    expect([...APPLICATION_STATUSES]).toEqual([...DB_STATUSES]);
    const laneStatuses = LANES.flatMap((l) => [...l.statuses]);
    expect(laneStatuses.toSorted()).toEqual([...APPLICATION_STATUSES].toSorted());
    expect(LANES.map((l) => l.label)).toEqual(['Not applied', 'Applied', 'In process', 'Waiting', 'Closed']);
  });
});

describe('statusMetaProblem', () => {
  it('rejected and ghosted need a stage', () => {
    expect(statusMetaProblem('rejected')).toMatch(/stage|before or after/);
    expect(statusMetaProblem('ghosted', {})).not.toBeNull();
    expect(statusMetaProblem('rejected', { stage: 'after_interview' })).toBeNull();
    expect(statusMetaProblem('ghosted', { stage: 'before_interview' })).toBeNull();
  });
  it('not_applying needs a reason (not blank)', () => {
    expect(statusMetaProblem('not_applying')).not.toBeNull();
    expect(statusMetaProblem('not_applying', { reason: '  ' })).not.toBeNull();
    expect(statusMetaProblem('not_applying', { reason: 'relocation' })).toBeNull();
  });
  it('force needs a reason; everything else is free', () => {
    expect(statusMetaProblem('applied', { force: true })).not.toBeNull();
    expect(statusMetaProblem('applied', { force: true, forceReason: 'applied by email' })).toBeNull();
    for (const s of [
      'saved',
      'preparing',
      'ready',
      'applied',
      'offer',
      'waiting',
      'accepted',
      'withdrawn',
    ] as const)
      expect(statusMetaProblem(s)).toBeNull();
  });
});

describe('nextActionFor (fixed clock 2026-11-20 12:00)', () => {
  it('applied: follow up 7 days after applying', () => {
    expect(nextActionFor('applied', hist({ appliedAt: at(11, 10) }), NOW)).toEqual({
      action: 'Follow up',
      at: new Date(2026, 10, 17, 10).toISOString(),
    });
  });
  it('a logged follow-up restarts the clock', () => {
    const n = nextActionFor('applied', hist({ appliedAt: at(11, 1), followUps: [at(11, 9)] }), NOW);
    expect(n?.at).toBe(new Date(2026, 10, 16, 10).toISOString());
  });
  it('acknowledged (they answered) has no follow-up', () => {
    expect(nextActionFor('acknowledged', hist({ appliedAt: at(11, 1) }), NOW)).toBeNull();
  });
  it('thank-you: 1 day after the latest interview that already happened', () => {
    const h = hist({
      interviews: [
        { scheduledAt: at(11, 5), outcome: 'passed' },
        { scheduledAt: at(11, 18), outcome: 'pending' },
        { scheduledAt: at(11, 25), outcome: 'pending' }, // not yet
        { scheduledAt: at(11, 19), outcome: 'cancelled' },
      ],
    });
    expect(nextActionFor('interviewing', h, NOW)).toEqual({
      action: 'Send a thank-you note',
      at: new Date(2026, 10, 19, 10).toISOString(),
    });
  });
  it('a follow-up logged after the interview clears the thank-you', () => {
    const h = hist({
      interviews: [{ scheduledAt: at(11, 18), outcome: 'passed' }],
      followUps: [at(11, 18, 18)],
    });
    expect(nextActionFor('interviewing', h, NOW)).toBeNull();
  });
  it('no past interview, no thank-you', () => {
    expect(
      nextActionFor(
        'interviewing',
        hist({ interviews: [{ scheduledAt: at(11, 25), outcome: 'pending' }] }),
        NOW,
      ),
    ).toBeNull();
  });
  it('offer: respond by its deadline; no deadline, nothing', () => {
    expect(nextActionFor('offer', hist({ offerDeadline: '2026-11-25' }), NOW)).toEqual({
      action: 'Respond to the offer',
      at: '2026-11-25',
    });
    expect(nextActionFor('offer', hist(), NOW)).toBeNull();
  });
  it('closed and not-yet-applied statuses suggest nothing', () => {
    for (const s of ['saved', 'preparing', 'ready', 'rejected', 'withdrawn', 'ghosted'] as const)
      expect(nextActionFor(s, hist({ appliedAt: at(10, 1) }), NOW)).toBeNull();
  });
});

describe('ghostedCandidate', () => {
  it('30 days without contact on an awaiting application', () => {
    // 2026-10-21 10:00 -> 2026-11-20 12:00 = 30 days and 2 hours
    expect(ghostedCandidate({ status: 'applied', lastContactAt: at(10, 21) }, NOW)).toEqual({
      since: at(10, 21),
      days: 30,
    });
    expect(ghostedCandidate({ status: 'applied', lastContactAt: at(10, 22) }, NOW)).toBeNull(); // 29 days
  });
  it('the day count is configurable', () => {
    expect(ghostedCandidate({ status: 'waiting', lastContactAt: at(11, 6) }, NOW, 14)?.days).toBe(14);
  });
  it('only awaiting statuses, and only with a last contact', () => {
    for (const status of ['saved', 'ready', 'offer', 'rejected', 'ghosted'] as const)
      expect(ghostedCandidate({ status, lastContactAt: at(1, 1) }, NOW)).toBeNull();
    expect(ghostedCandidate({ status: 'applied', lastContactAt: null }, NOW)).toBeNull();
  });
});

describe('slugs and folder names', () => {
  it('slugify: ascii, lowercase, dashes, never empty', () => {
    expect(slugify('Nimbus Analytics GmbH')).toBe('nimbus-analytics-gmbh');
    expect(slugify('Müller & Söhne: Data/ML Engineer (m/w/d)')).toBe('muller-sohne-data-ml-engineer-m-w-d');
    expect(slugify('日本語')).toBe('untitled');
    expect(slugify('../../etc/passwd')).toBe('etc-passwd');
    expect(slugify('a'.repeat(100))).toHaveLength(40);
  });
  it('applications/<date>_<company>_<role>', () => {
    expect(applicationFolder(NOW, 'Acme', 'Data Engineer')).toBe(
      'applications/2026-11-20_acme_data-engineer',
    );
  });
});
