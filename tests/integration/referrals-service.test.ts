import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createClaudeRunner } from '../../src/main/ai/runner';
import { allContacts, countPeople } from '../../src/main/db/repos/referrals';
import { listEvents } from '../../src/main/db/repos/applications';
import { createJobsService } from '../../src/main/services/jobs/service';
import { createProfileService } from '../../src/main/services/profile/service';
import { createReferralsService } from '../../src/main/services/referrals/service';
import { createTrackerService } from '../../src/main/services/tracker/service';
import { computeToday } from '../../src/main/services/tracker/today';
import { createRulesService } from '../../src/main/services/rules/service';
import { createAiSettings } from '../../src/main/services/settings/ai';
import { createDbRecorder } from '../../src/main/services/ai/recorder';
import { aiRuns, people, referralRequests } from '../../src/main/db/schema';
import type { MessageOutput, RawCandidate } from '../../src/shared/referrals';
import { coverPosting } from '../fixtures/cover';
import { COMPANY, JOB_URL, MEETUP_PAGE, TEAM_PAGE, goodMessage, jane, john } from '../fixtures/referrals';
import { sampleAnalysis, sampleJd } from '../fixtures/jobs';
import { freshDb, tempDir } from '../unit/db/helpers';

const FAKE = resolve('tests/fixtures/fake-claude/claude.mjs');
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

/** A mixed bag: two good people and one of each thing validation must drop or clean. */
const candidates = (): RawCandidate[] => [
  jane({
    public_contact: [
      { kind: 'email', value: 'jane@janedoe.test', source_url: TEAM_PAGE },
      { kind: 'email', value: 'jane.doe@nimbusanalytics.test', source_url: TEAM_PAGE },
      { kind: 'phone', value: '+49 30 1234567', source_url: TEAM_PAGE },
    ],
    facts: [
      ...jane().facts,
      { text: 'Reach me at jane@janedoe.test, +49 30 1234567', source_url: TEAM_PAGE },
    ],
  }),
  john(),
  jane({ full_name: 'Bruno Broker', profile_urls: ['https://www.rocketreach.co/bruno-broker'] }),
  jane({ full_name: 'Una Unsourced', facts: [{ text: 'Works at Nimbus Analytics', source_url: '' }] }),
  jane({ full_name: 'Wanda Wrong', company: 'Initech', profile_urls: ['https://github.com/wanda'] }),
  jane({ full_name: 'JANE DOE', profile_urls: ['https://github.com/dup'] }),
];

const BAD_MESSAGE: MessageOutput = {
  ...goodMessage(JOB_URL),
  subject: 'S'.repeat(80),
  body: goodMessage(JOB_URL).body.replace('At Globex', 'At Hooli'),
};

async function setup(env: Record<string, string> = {}, opts: { gap?: Partial<MessageOutput> } = {}) {
  const db = freshDb();
  const dir = tempDir();
  for (const d of ['profile', 'rules', 'templates']) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, 'profile/praneethreddy.md'), readFileSync('tests/fixtures/profiles/full.md'));
  for (const f of ['rules/skills-policy.md', 'rules/referral-message.md'])
    writeFileSync(join(dir, f), readFileSync(join('seed', f)));
  const cap = join(dir, 'capture.ndjson');
  const settings = createAiSettings(db);
  const runner = createClaudeRunner({
    bin: FAKE,
    cwd: join(dir, 'cwd'),
    logDir: join(dir, 'logs'),
    logger,
    recorder: createDbRecorder(db, vi.fn()),
    retryDelayMs: 1,
    env: {
      FAKE_CLAUDE_MODE: 'ok',
      FAKE_CLAUDE_OUTPUT_JD_PARSE: JSON.stringify(sampleJd),
      FAKE_CLAUDE_OUTPUT_JOB_ANALYZE: JSON.stringify(sampleAnalysis),
      FAKE_CLAUDE_OUTPUT_REFERRALS_SEARCH: JSON.stringify({ candidates: candidates() }),
      FAKE_CLAUDE_OUTPUT_REFERRALS_MESSAGE: JSON.stringify({ ...goodMessage(JOB_URL), ...opts.gap }),
      FAKE_CLAUDE_CAPTURE: cap,
      ...env,
    },
  });
  const profile = createProfileService({
    dataDir: dir,
    gitAvailable: false,
    runner,
    importConfig: () => settings.forTask('profile.import'),
  });
  const rules = createRulesService({ dataDir: dir, seedDir: resolve('seed'), gitAvailable: false });
  const jobs = createJobsService({ db, runner, settings, profile });
  let t = new Date('2026-11-20T12:00:00Z');
  const referrals = createReferralsService({
    db,
    runner,
    settings,
    profile,
    rules,
    aiLogDir: join(dir, 'logs'),
    now: () => t,
  });
  const intake = await jobs.intakeText(coverPosting, { url: JOB_URL });
  if (intake.status !== 'ok') throw new Error('intake failed');
  const calls = (task: 'search' | 'message') =>
    readFileSync(cap, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { kind: string; argv: string[]; stdin: string })
      .filter(
        (r) =>
          r.kind === 'call' &&
          (task === 'search' ? r.stdin.includes('<shared_ground>') : r.stdin.includes('<referral_rules>')),
      );
  return {
    db,
    dir,
    referrals,
    jobId: intake.jobId,
    calls,
    advance: (days: number) => void (t = new Date(t.getTime() + days * 86_400_000)),
  };
}

const SEARCH = { company: COMPANY, role: 'data engineer', location: 'Berlin, Germany', hints: {} };

describe('referrals.search (fake CLI)', { timeout: 30_000 }, () => {
  it('stores only validated people, ranked, with a request per job; contacts are sourced; no phone', async () => {
    const { referrals, jobId, calls, db } = await setup();
    const stages: string[] = [];
    const out = await referrals.search({ ...SEARCH, jobId }, { onProgress: (s) => stages.push(s) });
    expect(stages).toEqual(['searching', 'validating', 'saving']);
    expect(out.returned).toBe(6);
    expect(out.kept).toBe(2);
    expect(Object.fromEntries(out.dropped.map((d) => [d.reason, d.count]))).toEqual({
      no_profile_url: 1,
      no_sourced_fact: 1,
      wrong_company: 1,
      duplicate: 1,
    });
    expect(out.items.map((i) => i.person.fullName)).toEqual(['Jane Doe', 'John Roe']);
    expect(out.items[0]).toMatchObject({ status: 'not_contacted', jobId });
    expect(out.items[0]?.score).toBeGreaterThan(out.items[1]?.score ?? 100);
    expect(out.items[0]?.person.sharedGround).toContain('Example University');
    expect(countPeople(db)).toBe(2);

    // every stored contact has a source, the guessed-looking one and the phone are gone
    const contacts = allContacts(db);
    expect(contacts).toEqual([{ kind: 'email', value: 'jane@janedoe.test', source_url: TEAM_PAGE }]);
    expect(contacts.every((c) => /^https:\/\//.test(c.source_url))).toBe(true);
    const stored = JSON.stringify(db.orm.select().from(people).all());
    expect(stored).not.toMatch(/1234567|nimbusanalytics\.test\/?"?,?"?value|jane\.doe@/);

    // the CLI call: web tools only, isolated settings, shared ground but no contact data of the user
    const [call] = calls('search');
    expect(calls('search')).toHaveLength(1);
    const argv = call?.argv.join(' ') ?? '';
    expect(argv).toContain('--tools WebSearch,WebFetch');
    expect(argv).toContain('--allowedTools WebSearch,WebFetch');
    expect(argv).toContain('--setting-sources');
    expect(call?.stdin).toContain('education: Example University');
    expect(call?.stdin).toContain('company: Nimbus Analytics GmbH');
    // city and project titles are only used for local ranking
    expect(call?.stdin).not.toMatch(/^(city|project): /m);
    expect(call?.stdin).not.toMatch(/alex@example\.test|\+49 000|linkedin\.example/);
  });

  it('searching again merges into the same people instead of duplicating them', async () => {
    const { referrals, jobId, db, advance } = await setup();
    await referrals.search({ ...SEARCH, jobId });
    advance(3);
    const again = await referrals.search({ ...SEARCH, jobId });
    expect(countPeople(db)).toBe(2);
    expect(db.orm.select().from(referralRequests).all()).toHaveLength(2);
    expect(again.items[0]?.person.lastSeenAt).toBe('2026-11-23T12:00:00.000Z');
    expect(again.items[0]?.person.firstSeenAt).toBe('2026-11-20T12:00:00.000Z');
  });

  it('a search without a job stores people with no job, listed separately', async () => {
    const { referrals, jobId } = await setup();
    await referrals.search(SEARCH);
    expect(referrals.list(jobId)).toEqual([]);
    expect(referrals.list()).toHaveLength(2);
    expect(referrals.list()[0]?.jobId).toBeNull();
  });

  it('search more: sends the exclude block and drops the people already found', async () => {
    const { referrals, jobId, calls, db } = await setup();
    const first = await referrals.search({ ...SEARCH, jobId });
    const found = first.items.map((i) => i.person);
    const more = await referrals.search({
      ...SEARCH,
      jobId,
      exclude: {
        names: found.map((p) => p.fullName),
        profileUrls: found.flatMap((p) => p.profileUrls.map((u) => u.url)),
      },
    });
    expect(more.kept).toBe(0);
    expect(countPeople(db)).toBe(2);
    const [, second] = calls('search');
    expect(second?.stdin).toContain('<exclude>');
    expect(second?.stdin).toContain('name: Jane Doe');
    expect(calls('search')[0]?.stdin).not.toContain('<exclude>');
  });

  it('turns a failed run into a readable error and stores nothing', async () => {
    const { referrals, db } = await setup({ FAKE_CLAUDE_MODE_REFERRALS_SEARCH: 'usage_limit' });
    await expect(referrals.search(SEARCH)).rejects.toThrow(/usage limit/);
    expect(countPeople(db)).toBe(0);
    await expect(referrals.search({ ...SEARCH, company: ' ' })).rejects.toThrow(/company and a role/);
    await expect(referrals.search({ ...SEARCH, jobId: 'nope' })).rejects.toThrow(/no longer exists/);
  });
});

describe('referrals.message (fake CLI)', { timeout: 30_000 }, () => {
  it('drafts a message that passes lint and truth and records rules hash, model and prompt version', async () => {
    const { referrals, jobId, calls } = await setup();
    const { items } = await referrals.search({ ...SEARCH, jobId });
    const jane = items[0];
    if (!jane) throw new Error('no person');
    const item = await referrals.draft(jane.personId, jobId);
    expect(item.checks).toMatchObject({ ok: true, lint: [], truth: [] });
    expect(item.noteText).toContain('Nimbus Analytics');
    expect(item.messageBody).toContain(JOB_URL);
    expect(item).toMatchObject({ language: 'en', promptVersion: 'referrals.message@v1' });
    expect(item.rulesHash).toMatch(/^[0-9a-f]{64}$/);
    expect(item.model).toBeTruthy();
    expect(calls('message')).toHaveLength(1);
    const stdin = calls('message')[0]?.stdin ?? '';
    expect(stdin).toContain('max_chars: 300'); // the rules file verbatim
    expect(stdin).toContain('Spoke at the Berlin Data Meetup'); // cited facts
    expect(stdin).toContain(`[${MEETUP_PAGE}]`);
    expect(stdin).toContain(`link or id to include: ${JOB_URL}`);
    expect(stdin).not.toMatch(/alex@example\.test|\+49 000|Do not mention the 2019 internship/);
  });

  it('runs one repair round with the exact issues and keeps the repaired draft', async () => {
    const { referrals, jobId, calls } = await setup({
      FAKE_CLAUDE_OUTPUT_REFERRALS_MESSAGE: JSON.stringify(BAD_MESSAGE),
      FAKE_CLAUDE_OUTPUT_REFERRALS_MESSAGE_REPAIR: JSON.stringify(goodMessage(JOB_URL)),
    });
    const { items } = await referrals.search({ ...SEARCH, jobId });
    const item = await referrals.draft(items[0]?.personId ?? '', jobId);
    expect(item.checks?.ok).toBe(true);
    expect(item.messageSubject).toBe('Data Engineer role at Nimbus Analytics');
    const all = calls('message');
    expect(all).toHaveLength(2);
    expect(all[1]?.stdin).toContain('<repair_issues>');
    expect(all[1]?.stdin).toMatch(/Rules \(subject\)/);
    expect(all[1]?.stdin).toMatch(/Truth \(unknown_organisation\)/);
  });

  it('keeps the draft with its failing checks when the repair does not fix it', async () => {
    const { referrals, jobId, calls } = await setup({
      FAKE_CLAUDE_OUTPUT_REFERRALS_MESSAGE: JSON.stringify(BAD_MESSAGE),
    });
    const { items } = await referrals.search({ ...SEARCH, jobId });
    const item = await referrals.draft(items[0]?.personId ?? '', jobId);
    expect(calls('message')).toHaveLength(2); // never a third
    expect(item.checks?.ok).toBe(false);
    expect(item.checks?.lint.map((l) => l.rule)).toContain('subject');
    expect(item.checks?.truth.map((v) => v.kind)).toContain('unknown_organisation');
  });

  it('refuses a rules file with errors and an unknown person', async () => {
    const { referrals, jobId, dir } = await setup();
    const { items } = await referrals.search({ ...SEARCH, jobId });
    await expect(referrals.draft('missing', jobId)).rejects.toThrow(/no longer exists/);
    writeFileSync(
      join(dir, 'rules/referral-message.md'),
      '---\nversion: 1\nconnection_note: { max_chars: 5 }\n---\n',
    );
    await expect(referrals.draft(items[0]?.personId ?? '', jobId)).rejects.toThrow(
      /referral-message.md has errors/,
    );
  });
});

describe('placeholder profile', { timeout: 30_000 }, () => {
  it('search and draft refuse example content and name what to replace', async () => {
    const { referrals, jobId, dir } = await setup();
    const { items } = await referrals.search({ ...SEARCH, jobId });
    const file = join(dir, 'profile/praneethreddy.md');
    const full = readFileSync(file, 'utf8');
    writeFileSync(
      file,
      full.replace('## Awards', '### Job Title — Company {#exp-example}\n- x\n\n## Awards'),
    );
    await expect(referrals.search({ ...SEARCH, jobId })).rejects.toThrow(
      'Your profile still has the example entry "Job Title — Company". Replace it in Profile first.',
    );
    await expect(referrals.draft(items[0]?.personId ?? '', jobId)).rejects.toThrow(/example entry/);
    writeFileSync(file, full.replace('email: alex@example.test', 'email: ""'));
    await expect(referrals.search({ ...SEARCH, jobId })).rejects.toThrow(/no email/);
  });
});

describe('outreach status and the application timeline', { timeout: 30_000 }, () => {
  it('contacted creates the application, adds the event and a 7-day reminder; later statuses add events', async () => {
    const { referrals, jobId, db, advance } = await setup();
    const { items } = await referrals.search({ ...SEARCH, jobId });
    const id = items[0]?.id ?? '';
    const personId = items[0]?.personId ?? '';

    const contacted = referrals.setStatus(id, 'contacted', 'Sent on LinkedIn');
    expect(contacted).toMatchObject({
      status: 'contacted',
      contactedAt: '2026-11-20T12:00:00.000Z',
      nextActionAt: '2026-11-27T12:00:00.000Z',
    });
    expect(contacted.applicationId).toBeTruthy();
    expect(contacted.person.purgeAfter).toBeNull();
    expect(contacted.notesMd).toContain('2026-11-20: Sent on LinkedIn');

    const appId = contacted.applicationId ?? '';
    const events = () => listEvents(db, appId).filter((e) => e.type === 'referral');
    expect(events().map((e) => (e.payloadJson as { text: string }).text)).toEqual([
      'Asked Jane D. (Nimbus Analytics GmbH) for a referral',
    ]);
    expect(db.sqlite.prepare('SELECT status FROM applications WHERE id = ?').get(appId)).toEqual({
      status: 'saved',
    });

    advance(8);
    expect(referrals.setStatus(id, 'replied').nextActionAt).toBeNull();
    const referred = referrals.setStatus(id, 'referred');
    expect(referred.contactedAt).toBe('2026-11-20T12:00:00.000Z');
    expect(referrals.setStatus(id, 'declined').status).toBe('declined');
    expect(referrals.setStatus(id, 'no_response').status).toBe('no_response');
    expect(events().map((e) => (e.payloadJson as { text: string }).text)).toEqual([
      'Asked Jane D. (Nimbus Analytics GmbH) for a referral',
      'Jane D. (Nimbus Analytics GmbH) replied',
      'Jane D. (Nimbus Analytics GmbH) referred you',
      'Jane D. (Nimbus Analytics GmbH) declined to refer you',
      'No response from Jane D. (Nimbus Analytics GmbH)',
    ]);
    // the same status again is a no-op; a second request for the job reuses the application
    expect(referrals.setStatus(id, 'no_response').id).toBe(id);
    expect(events()).toHaveLength(5);
    const second = referrals.setStatus(items[1]?.id ?? '', 'contacted');
    expect(second.applicationId).toBe(appId);
    expect(db.sqlite.prepare('SELECT count(*) AS n FROM applications').get()).toEqual({ n: 1 });

    // resetting gives the person a retention date again (90 days from when they were last seen)
    const reset = referrals.setStatus(id, 'not_contacted');
    expect(reset).toMatchObject({ contactedAt: null, nextActionAt: null });
    expect(referrals.person(personId).person.purgeAfter).toBe('2027-02-18T12:00:00.000Z');
  });

  it('due lists contacted requests past their follow-up, and Today and the digest include them', async () => {
    const { referrals, jobId, db, advance } = await setup();
    const { items } = await referrals.search({ ...SEARCH, jobId });
    const t0 = new Date('2026-11-20T12:00:00Z');
    referrals.setStatus(items[0]?.id ?? '', 'contacted');
    referrals.setStatus(items[1]?.id ?? '', 'replied');
    expect(referrals.due()).toEqual([]);
    const tracker = createTrackerService({
      db,
      dataDir: tempDir(),
      gitAvailable: false,
      now: () => new Date(t0.getTime() + 8 * 86_400_000),
    });
    expect(computeToday(db, t0, []).needsYou.followUps).toEqual([]);
    advance(8);
    expect(referrals.due().map((i) => i.person.fullName)).toEqual(['Jane Doe']);
    const f = computeToday(db, new Date(t0.getTime() + 8 * 86_400_000), []).needsYou.followUps;
    expect(f).toMatchObject([{ action: 'Follow up with Jane D. about the referral', overdueDays: 1 }]);
    expect(f[0]?.company).toBe('Nimbus Analytics GmbH');
    expect(tracker.dueFollowUps().map((d) => d.action)).toContain(
      'Follow up with Jane D. about the referral',
    );
    referrals.setStatus(items[0]?.id ?? '', 'no_response');
    expect(referrals.due()).toEqual([]);
  });

  it('a request without a job keeps its status but writes no timeline event', async () => {
    const { referrals, db } = await setup();
    const { items } = await referrals.search(SEARCH);
    const item = referrals.setStatus(items[0]?.id ?? '', 'contacted');
    expect(item.applicationId).toBeNull();
    expect(
      db.sqlite.prepare("SELECT count(*) AS n FROM application_events WHERE type = 'referral'").get(),
    ).toEqual({ n: 0 });
  });

  it('rejects an unknown request', async () => {
    const { referrals } = await setup();
    expect(() => referrals.setStatus('nope', 'contacted')).toThrow(/no longer exists/);
  });
});

describe('retention, purge and deletion', { timeout: 30_000 }, () => {
  it('purges never-contacted people after the retention (default 90 days), keeps contacted ones', async () => {
    const { referrals, jobId, db, advance } = await setup();
    const { items } = await referrals.search({ ...SEARCH, jobId });
    expect(items[0]?.person.purgeAfter).toBe('2027-02-18T12:00:00.000Z');
    referrals.setStatus(items[1]?.id ?? '', 'contacted'); // John is contacted
    advance(89);
    expect(referrals.purge()).toBe(0);
    advance(2);
    expect(referrals.purge()).toBe(1);
    expect(referrals.list(jobId).map((i) => i.person.fullName)).toEqual(['John Roe']);
    expect(countPeople(db)).toBe(1);
    advance(1000);
    expect(referrals.purge()).toBe(0);
  });

  it('the retention setting is validated, persisted and applied to people already stored', async () => {
    const { referrals, jobId, advance } = await setup();
    expect(referrals.settings()).toEqual({ retentionDays: 90 });
    await referrals.search({ ...SEARCH, jobId });
    expect(referrals.setSettings({ retentionDays: 10 })).toEqual({ retentionDays: 10 });
    expect(referrals.settings().retentionDays).toBe(10);
    expect(() => referrals.setSettings({ retentionDays: 0 })).toThrow();
    expect(referrals.list(jobId)[0]?.person.purgeAfter).toBe('2026-11-30T12:00:00.000Z');
    advance(11);
    expect(referrals.purge()).toBe(2);
  });

  it('deletes one person with their requests, then everyone', async () => {
    const { referrals, jobId, db } = await setup();
    const { items } = await referrals.search({ ...SEARCH, jobId });
    expect(await referrals.deletePerson(items[0]?.personId ?? '')).toBe(true);
    expect(await referrals.deletePerson(items[0]?.personId ?? '')).toBe(false);
    expect(db.orm.select().from(referralRequests).all()).toHaveLength(1);
    expect(await referrals.deleteAll()).toBe(1);
    expect(countPeople(db)).toBe(0);
    expect(db.orm.select().from(referralRequests).all()).toHaveLength(0);
    expect(referrals.list()).toEqual([]);
  });

  it('deletes several people at once and ignores unknown ids', async () => {
    const { referrals, jobId, db } = await setup();
    const { items } = await referrals.search({ ...SEARCH, jobId });
    expect(await referrals.deletePeople(['nope'])).toBe(0);
    expect(countPeople(db)).toBe(2);
    expect(await referrals.deletePeople([...items.map((i) => i.personId), 'nope'])).toBe(2);
    expect(countPeople(db)).toBe(0);
  });

  it('deleting people also deletes the referrals run logs that name them', async () => {
    const { referrals, jobId, db, dir } = await setup();
    const { items } = await referrals.search({ ...SEARCH, jobId });
    await referrals.draft(items[0]?.personId ?? '', jobId);
    const logs = (): string[] => readdirSync(join(dir, 'logs')).filter((f) => f.endsWith('.json'));
    const referralRuns = db.orm
      .select()
      .from(aiRuns)
      .all()
      .filter((r) => r.task.startsWith('referrals.'));
    expect(referralRuns.length).toBeGreaterThanOrEqual(2);
    const text = (f: string): string => readFileSync(join(dir, 'logs', f), 'utf8');
    expect(logs().some((f) => text(f).includes('Jane Doe'))).toBe(true);
    // John is not in the message run, but is in the search run that also names Jane: that log goes with Jane.
    await referrals.deletePerson(items[0]?.personId ?? '');
    expect(logs().some((f) => text(f).includes('Jane Doe'))).toBe(false);
    await referrals.deleteAll();
    const ids = new Set(referralRuns.map((r) => `${r.id}.json`));
    expect(logs().filter((f) => ids.has(f))).toEqual([]);
    expect(logs().length).toBeGreaterThan(0); // the job analysis log is not a referrals log and stays
  });

  it('deleting the job removes its requests but keeps the people', async () => {
    const { referrals, jobId, db } = await setup();
    await referrals.search({ ...SEARCH, jobId });
    db.sqlite.prepare('DELETE FROM jobs WHERE id = ?').run(jobId);
    expect(db.orm.select().from(referralRequests).all()).toHaveLength(0);
    expect(countPeople(db)).toBe(2);
  });
});
