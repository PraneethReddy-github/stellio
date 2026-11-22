import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { coverPosting } from '../fixtures/cover';
import { sampleAnalysis, sampleJd } from '../fixtures/jobs';
import { JOB_URL, goodMessage, jane, john } from '../fixtures/referrals';
import { invoke, launchApp, type Launched } from './helpers';

const FAKE_CLAUDE = resolve('tests/fixtures/fake-claude/claude.mjs');
type Res<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };
interface Item {
  id: string;
  personId: string;
  jobId: string | null;
  applicationId: string | null;
  status: string;
  score: number;
  why: string;
  noteText: string | null;
  messageBody: string | null;
  checks: { ok: boolean } | null;
  nextActionAt: string | null;
  person: { fullName: string; publicContact: { source_url: string }[]; purgeAfter: string | null };
}
interface Outcome {
  returned: number;
  kept: number;
  dropped: { reason: string; count: number }[];
  items: Item[];
}

const candidates = [
  jane({
    public_contact: [
      { kind: 'email', value: 'jane@janedoe.test', source_url: 'https://www.nimbusanalytics.test/team' },
    ],
    facts: [
      ...jane().facts,
      { text: 'Email: jane@janedoe.test', source_url: 'https://www.nimbusanalytics.test/team' },
    ],
  }),
  john(),
  jane({ full_name: 'Bruno Broker', profile_urls: ['https://www.rocketreach.co/bruno'] }),
];

let l: Launched;
test.beforeAll(async () => {
  l = await launchApp({
    STELLIO_CLAUDE_BIN: FAKE_CLAUDE,
    FAKE_CLAUDE_MODE: 'ok',
    FAKE_CLAUDE_OUTPUT_JD_PARSE: JSON.stringify(sampleJd),
    FAKE_CLAUDE_OUTPUT_JOB_ANALYZE: JSON.stringify(sampleAnalysis),
    FAKE_CLAUDE_OUTPUT_REFERRALS_SEARCH: JSON.stringify({ candidates }),
    FAKE_CLAUDE_OUTPUT_REFERRALS_MESSAGE: JSON.stringify(goodMessage(JOB_URL)),
  });
  const r = (await invoke(l.page, 'profile:save', {
    markdown: readFileSync(resolve('tests/fixtures/profiles/full.md'), 'utf8'),
    expectedHash: null,
  })) as Res<unknown>;
  expect(r.ok).toBe(true);
});
test.afterAll(async () => {
  await l.close();
});

const ok = async <T>(channel: string, input?: unknown): Promise<T> => {
  const r = (await invoke(l.page, channel, input)) as Res<T>;
  if (!r.ok) throw new Error(`${channel}: ${r.error.code} ${r.error.message}`);
  return r.data;
};

test.describe.configure({ mode: 'serial' });
let jobId = '';
let items: Item[] = [];

test('search → validated, ranked people; progress events; sourced contacts only', async () => {
  const intake = await ok<{ status: string; jobId: string }>('jobs:intakeText', {
    text: coverPosting,
    url: JOB_URL,
    requestId: randomUUID(),
  });
  jobId = intake.jobId;
  await l.page.evaluate(() => {
    const w = window as unknown as {
      __prog: unknown[];
      stellio: { on: (e: string, f: (p: unknown) => void) => void };
    };
    w.__prog = [];
    w.stellio.on('referrals:progress', (p) => w.__prog.push(p));
  });
  const requestId = randomUUID();
  const out = await ok<Outcome>('referrals:search', {
    jobId,
    company: 'Nimbus Analytics GmbH',
    role: 'data engineer',
    location: 'Berlin, Germany',
    requestId,
  });
  items = out.items;
  expect(out).toMatchObject({ returned: 3, kept: 2, dropped: [{ reason: 'no_profile_url', count: 1 }] });
  expect(items.map((i) => i.person.fullName)).toEqual(['Jane Doe', 'John Roe']);
  expect(items[0]).toMatchObject({ status: 'not_contacted', jobId });
  expect(items[0]?.why).toBeTruthy();
  const contacts = items.flatMap((i) => i.person.publicContact);
  expect(contacts).toHaveLength(1);
  expect(contacts.every((c) => c.source_url.startsWith('https://'))).toBe(true);
  const prog = await l.page.evaluate(
    () => (window as unknown as { __prog: { requestId: string; stage: string }[] }).__prog,
  );
  expect(prog.map((p) => p.stage)).toEqual(['searching', 'validating', 'saving']);
  expect(prog.every((p) => p.requestId === requestId)).toBe(true);
});

test('list and person', async () => {
  expect((await ok<Item[]>('referrals:list', { jobId })).map((i) => i.id)).toEqual(items.map((i) => i.id));
  expect(await ok<Item[]>('referrals:list', {})).toHaveLength(2);
  const p = await ok<{ person: { fullName: string }; requests: { jobId: string }[] }>('referrals:person', {
    id: items[0]?.personId,
  });
  expect(p.person.fullName).toBe('Jane Doe');
  expect(p.requests[0]?.jobId).toBe(jobId);
  const bad = (await invoke(l.page, 'referrals:person', { id: 'nope' })) as Res<unknown>;
  expect(bad.ok).toBe(false);
});

test('draft stores note and message that pass the checks', async () => {
  const item = await ok<Item>('referrals:draft', {
    personId: items[0]?.personId,
    jobId,
    requestId: randomUUID(),
  });
  expect(item.checks?.ok).toBe(true);
  expect(item.noteText).toContain('Nimbus Analytics');
  expect(item.messageBody).toContain(JOB_URL);
});

test('status flow lands on the application timeline with a 7-day reminder', async () => {
  const contacted = await ok<Item>('referrals:setStatus', {
    id: items[0]?.id,
    status: 'contacted',
    note: 'Sent',
  });
  expect(contacted.applicationId).toBeTruthy();
  expect(contacted.nextActionAt).not.toBeNull();
  expect(contacted.person.purgeAfter).toBeNull();
  const replied = await ok<Item>('referrals:setStatus', { id: items[0]?.id, status: 'replied' });
  expect(replied.nextActionAt).toBeNull();
  const app = await ok<{ events: { type: string; payload: { text: string } }[] }>('tracker:get', {
    id: contacted.applicationId,
  });
  expect(app.events.filter((e) => e.type === 'referral').map((e) => e.payload.text)).toEqual([
    'Asked Jane D. (Nimbus Analytics GmbH) for a referral',
    'Jane D. (Nimbus Analytics GmbH) replied',
  ]);
  const wrong = (await invoke(l.page, 'referrals:setStatus', {
    id: items[0]?.id,
    status: 'sent',
  })) as Res<unknown>;
  expect(wrong).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
});

test('retention setting is validated and persisted', async () => {
  expect(await ok('referrals:settings')).toEqual({ retentionDays: 90 });
  expect(await ok('referrals:setSettings', { retentionDays: 30 })).toEqual({ retentionDays: 30 });
  expect(await ok('referrals:settings')).toEqual({ retentionDays: 30 });
  expect(((await invoke(l.page, 'referrals:setSettings', { retentionDays: 0 })) as Res<unknown>).ok).toBe(
    false,
  );
});

test('rules/referral-message.md is seeded and editable like the other rules', async () => {
  const snap = await ok<{ content: string; diagnostics: unknown[] }>('rules:get', {
    path: 'rules/referral-message.md',
  });
  expect(snap.diagnostics).toEqual([]);
  expect(snap.content).toContain('connection_note:');
});

test('no channel can send a message or log in; inputs are validated', async () => {
  const send = (await invoke(l.page, 'referrals:send', {})) as Res<unknown>;
  expect(send).toMatchObject({ ok: false, error: { code: 'unknown_channel' } });
  const login = (await invoke(l.page, 'referrals:login', {})) as Res<unknown>;
  expect(login.ok).toBe(false);
  const noCompany = (await invoke(l.page, 'referrals:search', {
    company: '',
    role: 'x',
    requestId: randomUUID(),
  })) as Res<unknown>;
  expect(noCompany).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
});

test('delete one person, then delete all', async () => {
  expect(await ok('referrals:delete', { personId: items[1]?.personId })).toEqual({ deleted: true });
  expect(await ok<Item[]>('referrals:list', {})).toHaveLength(1);
  expect(await ok('referrals:deleteAll')).toEqual({ deleted: 1 });
  expect(await ok<Item[]>('referrals:list', {})).toEqual([]);
});
