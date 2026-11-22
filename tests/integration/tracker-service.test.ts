import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { insertDocumentVersion, setFinalVersion, updateDocument } from '../../src/main/db/repos/documents';
import { createJob, deleteJob, insertAnalysis } from '../../src/main/db/repos/jobs';
import { applicationEvents, applications, interviews } from '../../src/main/db/schema';
import { initDataFolder } from '../../src/main/services/datafolder/init';
import { log } from '../../src/main/services/datafolder/git';
import { createDigest } from '../../src/main/services/tracker/digest';
import { createTrackerService } from '../../src/main/services/tracker/service';
import { freshDb, tempDir } from '../unit/db/helpers';

/** Local time, so the tests do not depend on the machine's time zone. */
const at = (m: number, d: number, h = 10): Date => new Date(2026, m - 1, d, h);

beforeAll(() => {
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_NOSYSTEM = '1';
});

async function setup(start = at(11, 20, 12)) {
  const db = freshDb();
  const dataDir = tempDir();
  const init = await initDataFolder(dataDir, resolve('seed'));
  expect(init.gitAvailable).toBe(true);
  const clock = { now: start };
  const tracker = createTrackerService({ db, dataDir, gitAvailable: true, now: () => clock.now });
  let seq = 0;
  const addJob = (
    company = 'Acme GmbH',
    title = 'Data Engineer',
    extra: Partial<Parameters<typeof createJob>[2]> = {},
  ) =>
    createJob(db, company, {
      title,
      dedupeKey: `k${String(seq++)}`,
      descriptionMd: `We need a ${title}.`,
      url: 'https://example.test/job',
      state: 'shortlisted',
      ...extra,
    });
  /** A resume (and optionally a cover letter) version, with a PDF on disk. */
  const addDoc = (jobId: string, kind: 'resume' | 'cover_letter', final: boolean) => {
    const row = insertDocumentVersion(db, {
      jobId,
      kind,
      tex: `\\documentclass{article}% ${kind} #${String(seq++)}`,
      profileHash: 'ph',
      rulesHash: 'rh',
      templateHash: 'th',
      model: 'claude-sonnet-5-5',
      promptVersion: `${kind}.generate@v1`,
    });
    mkdirSync(join(dataDir, '.stellio/documents'), { recursive: true });
    writeFileSync(
      join(dataDir, `.stellio/documents/${row.id}.pdf`),
      Buffer.from([0x25, 0x50, 0x44, 0x46, 0xff, 0x00, 0xfe]),
    );
    updateDocument(db, row.id, { pdfPath: `.stellio/documents/${row.id}.pdf` });
    if (final) setFinalVersion(db, jobId, kind, row.version);
    return row;
  };
  return { db, dataDir, clock, tracker, addJob, addDoc };
}
const folderOf = (dir: string, rel: string): string[] => readdirSync(join(dir, rel)).sort();

describe('application lifecycle with real git', { timeout: 60_000 }, () => {
  it('drafting starts the application as preparing; applying freezes the final documents', async () => {
    const { db, dataDir, tracker, addJob, addDoc, clock } = await setup();
    const job = addJob();
    insertAnalysis(db, {
      jobId: job.id,
      profileHash: 'ph',
      model: 'claude-sonnet-5-5',
      promptVersion: 'v1',
      fitScore: 88,
      verdict: 'apply',
      summary: 'Strong.',
      resultJson: null,
    });
    const r1 = addDoc(job.id, 'resume', false);
    const r2 = addDoc(job.id, 'resume', true);
    addDoc(job.id, 'cover_letter', true);

    let app = tracker.forJob(job.id);
    expect(app).toMatchObject({
      status: 'preparing',
      company: 'Acme GmbH',
      role: 'Data Engineer',
      appliedAt: null,
    });
    expect(db.orm.select().from(applications).all()).toHaveLength(1); // not one per document
    expect((await tracker.get(app?.id ?? '')).events.map((e) => [e.type, e.fromStatus, e.toStatus])).toEqual([
      ['status_change', null, 'preparing'],
    ]);

    app = await tracker.setStatus(app?.id ?? '', 'ready');
    expect(app.status).toBe('ready');

    clock.now = at(11, 21, 9);
    app = await tracker.setStatus(app.id, 'applied');
    const rel = 'applications/2026-11-21_acme-gmbh_data-engineer';
    expect(app).toMatchObject({
      status: 'applied',
      folderPath: rel,
      appliedAt: at(11, 21, 9).toISOString(),
      resumeDocId: r2.id,
    });
    expect(folderOf(dataDir, rel)).toEqual([
      'analysis.json',
      'cover-letter.pdf',
      'cover-letter.tex',
      'jd.md',
      'meta.json',
      'resume.pdf',
      'resume.tex',
    ]);
    // the final version (2), not version 1; PDF bytes are copied exactly
    expect(readFileSync(join(dataDir, rel, 'resume.tex'), 'utf8')).toBe(r2.tex);
    expect(r1.tex).not.toBe(r2.tex);
    expect([...readFileSync(join(dataDir, rel, 'resume.pdf'))]).toEqual([
      0x25, 0x50, 0x44, 0x46, 0xff, 0x00, 0xfe,
    ]);
    expect(readFileSync(join(dataDir, rel, 'jd.md'), 'utf8')).toContain('We need a Data Engineer.');
    const analysis = JSON.parse(readFileSync(join(dataDir, rel, 'analysis.json'), 'utf8')) as {
      job: { company: string };
      fitScore: number;
    };
    expect(analysis).toMatchObject({ job: { company: 'Acme GmbH' }, fitScore: 88 });
    const meta = JSON.parse(readFileSync(join(dataDir, rel, 'meta.json'), 'utf8')) as {
      resume: { texSha256: string };
    };
    expect(meta).toMatchObject({
      company: 'Acme GmbH',
      forced: null,
      resume: {
        version: 2,
        model: 'claude-sonnet-5-5',
        promptVersion: 'resume.generate@v1',
        profileHash: 'ph',
      },
      coverLetter: { version: 1 },
    });
    expect(meta.resume.texSha256).toMatch(/^[0-9a-f]{64}$/);

    // one git commit, nothing left uncommitted
    const [head] = await log(dataDir, { limit: 1 });
    expect(head?.message).toBe('apply: Acme GmbH — Data Engineer');
    const committed = await log(dataDir, { path: rel, limit: 5 });
    expect(committed).toHaveLength(1);

    const detail = await tracker.get(app.id);
    expect(detail.events.map((e) => [e.type, e.fromStatus, e.toStatus])).toEqual([
      ['status_change', null, 'preparing'],
      ['status_change', 'preparing', 'ready'],
      ['status_change', 'ready', 'applied'],
      ['document', null, null],
    ]);
    expect(detail.frozen).toEqual({
      folder: rel,
      files: [
        'analysis.json',
        'cover-letter.pdf',
        'cover-letter.tex',
        'jd.md',
        'meta.json',
        'resume.pdf',
        'resume.tex',
      ],
    });
    expect(detail.analysisFrozen).toBe(true);
    expect(detail.analysis?.fitScore).toBe(88);
    expect(detail.documents.resume.map((d) => [d.version, d.isFinal, d.hasPdf])).toEqual([
      [1, false, true],
      [2, true, true],
    ]);
    expect(detail.application.nextAction).toBe('Follow up'); // 7 days after applying
    expect(detail.application.nextActionAt).toBe(at(11, 28, 9).toISOString());
  });

  it('applying needs a final resume unless forced with a reason', async () => {
    const { tracker, addJob, dataDir, db } = await setup();
    const job = addJob();
    const app = tracker.create(job.id);
    expect(app.status).toBe('saved');
    await expect(tracker.setStatus(app.id, 'applied')).rejects.toThrow(/final resume/);
    await expect(tracker.setStatus(app.id, 'applied', { force: true })).rejects.toThrow(/reason/);
    expect(tracker.forJob(job.id)?.status).toBe('saved');
    expect(readdirSync(join(dataDir, 'applications'))).toEqual([]); // nothing half-frozen
    const done = await tracker.setStatus(app.id, 'applied', {
      force: true,
      forceReason: 'applied through a recruiter',
    });
    expect(done.status).toBe('applied');
    const rel = done.folderPath ?? '';
    expect(folderOf(dataDir, rel)).toEqual(['analysis.json', 'jd.md', 'meta.json']);
    expect(JSON.parse(readFileSync(join(dataDir, rel, 'meta.json'), 'utf8'))).toMatchObject({
      forced: { reason: 'applied through a recruiter' },
      resume: null,
    });
    const ev = (await tracker.get(app.id)).events.find((e) => e.toStatus === 'applied');
    expect(ev?.payload).toMatchObject({ force: true, forceReason: 'applied through a recruiter' });
    expect(
      db.orm.select().from(applications).where(eq(applications.id, app.id)).get()?.appliedAt,
    ).not.toBeNull();
  });

  it('never overwrites: a re-apply gets -2, then -3; earlier folders stay byte-identical', async () => {
    const { tracker, addJob, addDoc, dataDir } = await setup();
    const job = addJob('Acme', 'Data Engineer');
    addDoc(job.id, 'resume', true);
    const app = tracker.create(job.id);
    const first = (await tracker.setStatus(app.id, 'applied')).folderPath;
    expect(first).toBe('applications/2026-11-20_acme_data-engineer');
    // the user edited a frozen file by hand
    writeFileSync(join(dataDir, first ?? '', 'resume.tex'), 'MY EDIT');
    await tracker.setStatus(app.id, 'withdrawn');
    const second = (await tracker.setStatus(app.id, 'applied')).folderPath;
    expect(second).toBe('applications/2026-11-20_acme_data-engineer-2');
    await tracker.setStatus(app.id, 'withdrawn');
    expect((await tracker.setStatus(app.id, 'applied')).folderPath).toBe(
      'applications/2026-11-20_acme_data-engineer-3',
    );
    expect(readFileSync(join(dataDir, first ?? '', 'resume.tex'), 'utf8')).toBe('MY EDIT');
    expect(readFileSync(join(dataDir, second ?? '', 'resume.tex'), 'utf8')).not.toBe('MY EDIT');
    // a folder that exists for another reason is skipped too
    const other = addJob('Acme', 'Data Engineer', {});
    addDoc(other.id, 'resume', true);
    mkdirSync(join(dataDir, 'applications/2026-11-20_acme_data-engineer-4'));
    writeFileSync(join(dataDir, 'applications/2026-11-20_acme_data-engineer-4/keep.txt'), 'x');
    // (-1 variants: base, -2, -3 are taken)
    const o = tracker.create(other.id);
    expect((await tracker.setStatus(o.id, 'applied')).folderPath).toBe(
      'applications/2026-11-20_acme_data-engineer-5',
    );
    expect(folderOf(dataDir, 'applications/2026-11-20_acme_data-engineer-4')).toEqual(['keep.txt']);
  });

  it('a traversal in the stored folder is refused when opening the folder', async () => {
    const { tracker, addJob, addDoc, db } = await setup();
    const job = addJob();
    addDoc(job.id, 'resume', true);
    const app = tracker.create(job.id);
    expect(() => tracker.folderPath(app.id)).toThrow(/no saved folder/);
    const done = await tracker.setStatus(app.id, 'applied');
    expect(tracker.folderPath(app.id)).toContain(done.folderPath ?? '?');
    for (const bad of ['../outside', '/etc', '.', 'applications/../..'])
      db.orm.update(applications).set({ folderPath: bad }).where(eq(applications.id, app.id)).run();
    expect(() => tracker.folderPath(app.id)).toThrow();
  });
});

describe('status rules, events, interviews, contacts', () => {
  it('validates metadata; choosing the same status is a no-op', async () => {
    const { tracker, addJob } = await setup();
    const app = tracker.create(addJob().id);
    await expect(tracker.setStatus(app.id, 'rejected')).rejects.toThrow(/before or after/);
    await expect(tracker.setStatus(app.id, 'not_applying')).rejects.toThrow(/reason/);
    const closed = await tracker.setStatus(app.id, 'not_applying', { reason: 'relocation' });
    expect(closed.status).toBe('not_applying');
    expect(closed.nextAction).toBeNull();
    await tracker.setStatus(app.id, 'not_applying', { reason: 'again' });
    const ev = (await tracker.get(app.id)).events.filter((e) => e.type === 'status_change');
    expect(ev.map((e) => e.toStatus)).toEqual(['saved', 'not_applying']);
    expect(ev[1]?.payload).toEqual({ reason: 'relocation' });
    await expect(tracker.setStatus('nope', 'ready')).rejects.toThrow(/no longer exists/);
  });

  it('interviews, notes, follow-ups, next actions and contacts all leave an event trail', async () => {
    const { tracker, addJob, clock } = await setup(at(11, 20, 12));
    const job = addJob();
    const other = addJob('Acme GmbH', 'Platform Engineer'); // same company
    const app = tracker.create(job.id);
    const app2 = tracker.create(other.id);

    const i1 = tracker.addInterview(app.id, { kind: 'screen', scheduledAt: at(11, 18).toISOString() });
    const i2 = tracker.addInterview(app.id, { kind: 'technical', scheduledAt: at(11, 25).toISOString() });
    expect([i1.round, i2.round]).toEqual([1, 2]);
    tracker.updateInterview(i1.id, { outcome: 'passed', notesMd: 'went well' });
    // interviewing 1 day after round 1: a thank-you is suggested
    await tracker.setStatus(app.id, 'interviewing');
    let cur = tracker.forJob(job.id);
    expect(cur).toMatchObject({
      nextAction: 'Send a thank-you note',
      nextActionSuggested: true,
      nextActionAt: at(11, 19).toISOString(),
    });
    tracker.note(app.id, 'sent the thank-you', 'follow_up');
    tracker.note(app.id, 'liked the team');
    expect(tracker.forJob(job.id)?.nextAction).toBeNull();
    // the user's own next action wins
    tracker.update(app.id, {
      nextAction: 'Prepare system design',
      nextActionAt: '2026-11-24',
      priority: 2,
      salaryExpectation: '80k EUR',
      channel: 'referral',
      notesMd: 'long notes',
    });
    cur = tracker.forJob(job.id);
    expect(cur).toMatchObject({
      nextAction: 'Prepare system design',
      nextActionSuggested: false,
      priority: 2,
      channel: 'referral',
      salaryExpectation: '80k EUR',
      notesMd: 'long notes',
    });
    tracker.update(app.id, { nextAction: null, nextActionAt: null });
    expect(tracker.deleteInterview(i2.id)).toBe(true);
    expect(tracker.deleteInterview(i2.id)).toBe(false);

    const c = tracker.addContact(app.id, {
      name: 'Dana Recruiter',
      email: 'dana@example.test',
      role: 'Recruiter',
    });
    expect(tracker.contacts(app2.id).available.map((x) => x.id)).toEqual([c.id]);
    tracker.linkContact(app2.id, c.id);
    tracker.linkContact(app2.id, c.id); // idempotent
    expect(tracker.contacts(app2.id)).toMatchObject({ linked: [{ id: c.id }], available: [] });
    expect(tracker.unlinkContact(app2.id, c.id)).toBe(true);
    expect(tracker.unlinkContact(app2.id, c.id)).toBe(false);
    expect(tracker.updateContact(c.id, { role: 'Lead recruiter' }).role).toBe('Lead recruiter');

    clock.now = at(11, 21, 9);
    const d = await tracker.get(app.id);
    expect(d.contacts.map((x) => x.name)).toEqual(['Dana Recruiter']);
    expect(d.interviews.map((i) => [i.round, i.outcome])).toEqual([[1, 'passed']]);
    expect(d.events.map((e) => [e.type, (e.payload as { action?: string } | null)?.action ?? null])).toEqual([
      ['status_change', null],
      ['interview', 'added'],
      ['interview', 'added'],
      ['interview', 'updated'],
      ['status_change', null],
      ['follow_up', null],
      ['note', null],
      ['interview', 'deleted'],
      ['contact', 'added'],
    ]);
    expect(tracker.deleteContact(c.id)).toBe(true);
    expect((await tracker.get(app.id)).contacts).toEqual([]);
  });

  it('a draft after shortlisting moves saved to preparing; later statuses are kept', async () => {
    const { tracker, addJob, addDoc } = await setup();
    const job = addJob();
    const app = tracker.create(job.id);
    addDoc(job.id, 'resume', false);
    expect(tracker.forJob(job.id)?.status).toBe('preparing');
    await tracker.setStatus(app.id, 'screening');
    addDoc(job.id, 'resume', false);
    expect(tracker.forJob(job.id)?.status).toBe('screening');
  });
});

describe('views and CSV', () => {
  async function populated() {
    const s = await setup();
    const mk = async (
      company: string,
      title: string,
      status: Parameters<typeof s.tracker.setStatus>[1],
      meta = {},
      extra: Partial<Parameters<typeof createJob>[2]> = {},
    ) => {
      const job = s.addJob(company, title, extra);
      const app = s.tracker.create(job.id);
      if (status !== 'saved')
        await s.tracker.setStatus(app.id, status, {
          force: status === 'applied',
          forceReason: 'test',
          ...meta,
        });
      return { job, app };
    };
    const a = await mk(
      'Acme',
      'Data Engineer',
      'applied',
      {},
      {
        locationText: 'Berlin',
        salaryMin: 60000,
        salaryMax: 70000,
        salaryCurrency: 'EUR',
        salaryPeriod: 'year',
      },
    );
    s.clock.now = at(11, 25, 12); // 5 days later
    const b = await mk('Beta, Inc.', '=SUM(A1) "Lead"', 'saved');
    const c = await mk('Cyan', 'Cloud', 'rejected', { stage: 'after_interview' });
    s.db.orm.update(applications).set({ priority: 1 }).where(eq(applications.id, b.app.id)).run();
    return { ...s, a, b, c };
  }

  it('board: lanes as in docs/08, cards with days in status and next action', async () => {
    const { tracker } = await populated();
    const board = tracker.board();
    expect(board.lanes.map((l) => [l.id, l.cards.map((c) => c.company)])).toEqual([
      ['not_applied', ['Beta, Inc.']],
      ['applied', ['Acme']],
      ['in_process', []],
      ['waiting', []],
      ['closed', ['Cyan']],
    ]);
    const acme = board.lanes[1]?.cards[0];
    expect(acme).toMatchObject({
      role: 'Data Engineer',
      daysInStatus: 5,
      status: 'applied',
      nextAction: 'Follow up',
      fit: null,
    });
  });

  it('table: filters and sorts', async () => {
    const { tracker, a } = await populated();
    const names = (f?: Parameters<typeof tracker.table>[0], s?: Parameters<typeof tracker.table>[1]) =>
      tracker.table(f, s).map((r) => r.company);
    expect(names({}, { by: 'company', dir: 'asc' })).toEqual(['Acme', 'Beta, Inc.', 'Cyan']);
    expect(names({}, { by: 'company', dir: 'desc' })).toEqual(['Cyan', 'Beta, Inc.', 'Acme']);
    expect(names({ status: ['applied', 'rejected'] }, { by: 'company', dir: 'asc' })).toEqual([
      'Acme',
      'Cyan',
    ]);
    expect(names({ text: 'berlin' })).toEqual(['Acme']);
    expect(names({ text: 'cloud' })).toEqual(['Cyan']);
    expect(names({ appliedFrom: '2026-11-20', appliedTo: '2026-11-20' })).toEqual(['Acme']);
    expect(names({ appliedFrom: '2026-11-21' })).toEqual([]);
    expect(names({ hasNextActionDue: true })).toEqual([]); // follow-up is due 11-27
    expect(names({ source: 'manual' })).toEqual([]);
    expect(names({}, { by: 'priority', dir: 'asc' })[0]).toBe('Beta, Inc.');
    const row = tracker.table({ status: ['applied'] })[0];
    expect(row).toMatchObject({
      id: a.app.id,
      daysSince: 5,
      salary: '60000-70000 EUR/year',
      location: 'Berlin',
      resumeVersion: null,
    });
  });

  it('timeline: applied, interviews and deadlines inside the range', async () => {
    const { tracker, a } = await populated();
    tracker.addInterview(a.app.id, { kind: 'onsite', scheduledAt: at(11, 27).toISOString() });
    tracker.addInterview(a.app.id, {
      kind: 'hr',
      scheduledAt: at(12, 3).toISOString(),
      outcome: 'cancelled',
    });
    const items = tracker.timeline('2026-11-01', '2026-11-30');
    expect(items.map((i) => [i.kind, i.company])).toEqual([
      ['applied', 'Acme'],
      ['interview', 'Acme'],
    ]);
    expect(tracker.timeline('2026-12-01', '2026-12-31')).toEqual([]);
  });

  it('timeline includes deadlines of applications not yet sent', async () => {
    const { tracker, addJob } = await setup();
    const job = addJob('Acme', 'Data Engineer', { deadlineAt: '2026-11-22' });
    tracker.create(job.id);
    expect(tracker.timeline('2026-11-22', '2026-11-22').map((i) => i.kind)).toEqual(['deadline']);
  });

  it('CSV export: header, escaping, formula guard, honours filters and cancel', async () => {
    const { tracker, dataDir } = await populated();
    const target = join(dataDir, 'out.csv');
    const pick = vi.fn(() => Promise.resolve(target));
    const res = await tracker.exportCsv(
      { status: ['applied', 'saved'] },
      { by: 'company', dir: 'asc' },
      pick,
    );
    expect(res).toEqual({ status: 'saved', path: target, rows: 2 });
    expect(pick).toHaveBeenCalledWith('stellio-applications-2026-11-25.csv');
    const csv = readFileSync(target, 'utf8');
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const lines = csv.slice(1).split('\r\n');
    expect(lines[0]).toBe(
      'Company,Role,Status,Fit,Applied,Days since,Source,Location,Salary,Resume version,Next action,Next action due,Priority',
    );
    expect(lines[1]).toBe(
      `Acme,Data Engineer,applied,,${at(11, 20, 12).toISOString()},5,,Berlin,60000-70000 EUR/year,,Follow up,${at(11, 27, 12).toISOString()},`,
    );
    // comma and quotes are quoted; a leading = is neutralised
    expect(lines[2]).toBe(`"Beta, Inc.","'=SUM(A1) ""Lead""",saved,,,,,,,,,,1`);
    expect(lines[3]).toBe('');
    expect(await tracker.exportCsv(undefined, undefined, () => Promise.resolve(null))).toEqual({
      status: 'cancelled',
    });
    expect(existsSync(join(dataDir, 'stellio-applications.csv'))).toBe(false);
  });
});

describe('daily follow-up digest', () => {
  it('notifies once per day with the due follow-ups; a new day notifies again', async () => {
    const { tracker, addJob, db, clock } = await setup(at(11, 20, 8));
    const notify = vi.fn();
    const digest = createDigest({ db, tracker, notify, now: () => clock.now });
    expect(digest.check()).toBe(false); // nothing due
    const app = tracker.create(addJob('Acme', 'Data Engineer').id);
    tracker.update(app.id, { nextAction: 'Email Dana', nextActionAt: at(11, 20, 9).toISOString() });
    expect(digest.check()).toBe(false); // due at 09:00, not yet

    clock.now = at(11, 20, 10);
    expect(digest.check()).toBe(true);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith({
      title: '1 follow-up due',
      body: 'Acme — Data Engineer: Email Dana',
    });
    clock.now = at(11, 20, 18);
    expect(digest.check()).toBe(false); // once a day
    expect(notify).toHaveBeenCalledTimes(1);

    // survives a restart: the day is stored, not in memory
    const again = createDigest({ db, tracker, notify, now: () => clock.now });
    expect(again.check()).toBe(false);

    clock.now = at(11, 21, 9);
    const second = tracker.create(addJob('Beta', 'Backend').id);
    tracker.update(second.id, { nextActionAt: at(11, 21, 8).toISOString() });
    expect(again.check()).toBe(true);
    expect(notify).toHaveBeenLastCalledWith({
      title: '2 follow-ups due',
      body: 'Acme — Data Engineer: Email Dana\nBeta — Backend: Follow up',
    });
  });

  it('the digest follows the notification settings: off, or not before its time', async () => {
    const { tracker, addJob, db, clock } = await setup(at(11, 20, 8));
    const app = tracker.create(addJob('Acme', 'Data Engineer').id);
    tracker.update(app.id, { nextActionAt: at(11, 19).toISOString() });
    const notify = vi.fn();
    const cfg = { digestEnabled: true, digestTime: '09:30' };
    const digest = createDigest({ db, tracker, notify, now: () => clock.now, settings: () => cfg });
    expect(digest.check()).toBe(false); // 08:00, before 09:30
    clock.now = at(11, 20, 9);
    expect(digest.check()).toBe(false);
    cfg.digestEnabled = false;
    clock.now = at(11, 20, 10);
    expect(digest.check()).toBe(false); // switched off
    cfg.digestEnabled = true;
    expect(digest.check()).toBe(true);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('closed applications never nag, and a throwing notifier is reported, not fatal', async () => {
    vi.useFakeTimers();
    try {
      const { tracker, addJob, db, clock } = await setup(at(11, 20, 10));
      const app = tracker.create(addJob().id);
      tracker.update(app.id, { nextActionAt: at(11, 19).toISOString() });
      await tracker.setStatus(app.id, 'withdrawn');
      const onError = vi.fn();
      const notify = vi.fn(() => {
        throw new Error('no notifications here');
      });
      const digest = createDigest({ db, tracker, notify, now: () => clock.now, onError });
      digest.start(1000);
      expect(notify).not.toHaveBeenCalled();
      const open = tracker.create(addJob('Beta', 'Backend').id);
      tracker.update(open.id, { nextActionAt: at(11, 19).toISOString() });
      await vi.advanceTimersByTimeAsync(1000);
      expect(onError).toHaveBeenCalledTimes(1);
      digest.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('deleting a job', () => {
  it('removes its application, events and interviews, but not the frozen folder', async () => {
    const { tracker, addJob, addDoc, db, dataDir } = await setup();
    const job = addJob();
    addDoc(job.id, 'resume', true);
    const app = tracker.create(job.id);
    tracker.addInterview(app.id, { kind: 'screen' });
    const rel = (await tracker.setStatus(app.id, 'applied')).folderPath ?? '';
    expect(deleteJob(db, job.id)).toBe(true);
    expect(db.orm.select().from(applications).all()).toEqual([]);
    expect(db.orm.select().from(applicationEvents).all()).toEqual([]);
    expect(db.orm.select().from(interviews).all()).toEqual([]);
    expect(existsSync(join(dataDir, rel, 'resume.tex'))).toBe(true);
  });
});
