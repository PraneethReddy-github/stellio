import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sampleAnalysis, sampleJd } from '../fixtures/jobs';
import { goodContent } from '../fixtures/resume';
import { invoke, type Launched } from './helpers';

const FAKE_CLAUDE = resolve('tests/fixtures/fake-claude/claude.mjs');
const TECTONIC = process.env.STELLIO_TECTONIC_BIN || resolve('spikes/latex/bin/tectonic');
export const DAY = 86_400_000;
export const SHOTS = process.env.SCREENSHOTS
  ? (process.env.SCREENSHOT_DIR ?? 'docs/screenshots/current')
  : null;

type Res<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };

export const localDate = (d: Date): string =>
  `${String(d.getFullYear())}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Env for a fake-CLI app: parse, analyse and draft all succeed. */
export const trackerEnv = (extra: Record<string, string> = {}): Record<string, string> => ({
  STELLIO_CLAUDE_BIN: FAKE_CLAUDE,
  ...(existsSync(TECTONIC) ? { STELLIO_TECTONIC_BIN: TECTONIC } : {}),
  FAKE_CLAUDE_MODE: 'ok',
  FAKE_CLAUDE_OUTPUT_JD_PARSE: JSON.stringify(sampleJd),
  FAKE_CLAUDE_OUTPUT_JOB_ANALYZE: JSON.stringify(sampleAnalysis),
  FAKE_CLAUDE_OUTPUT_RESUME_GENERATE: JSON.stringify(goodContent),
  ...extra,
});

export const posting = (company: string, role: string): string =>
  `${role} at ${company} in Berlin. ${'Build pipelines in Python and SQL. '.repeat(5)}`;

export function api(l: Launched) {
  const ok = async <T>(channel: string, input?: unknown): Promise<T> => {
    const r = (await invoke(l.page, channel, input)) as Res<T>;
    if (!r.ok) throw new Error(`${channel}: ${r.error.message}`);
    return r.data;
  };
  /** The fake CLI answers `jd.parse` with this company and title (it reads its env on every call). */
  const addJob = async (company: string, role: string, deadline: string | null = null): Promise<string> => {
    await l.app.evaluate(
      (_e, jd) => {
        process.env.FAKE_CLAUDE_OUTPUT_JD_PARSE = jd;
      },
      JSON.stringify({
        ...sampleJd,
        company,
        title: role,
        deadline,
        requirements: [
          ...sampleJd.requirements,
          { text: 'dbt for modelling', kind: 'required', skills: ['dbt'] },
        ],
      }),
    );
    const r = await ok<{ jobId: string }>('jobs:intakeText', {
      text: posting(company, role),
      requestId: randomUUID(),
    });
    await ok('jobs:analyze', { id: r.jobId, requestId: randomUUID() });
    return r.jobId;
  };
  const saveProfile = (): Promise<unknown> =>
    ok('profile:save', {
      markdown: readFileSync(resolve('tests/fixtures/profiles/full.md'), 'utf8'),
      expectedHash: null,
    });
  return { ok, addJob, saveProfile };
}

export interface Seeded {
  /** Applied, then screening, with an interview tomorrow. */
  a: { jobId: string; appId: string };
  /** Shortlisted, deadline in two days. */
  b: { jobId: string; appId: string };
  /** Not applying. */
  c: { jobId: string; appId: string };
}

/** Three applications in three lanes, the first with frozen files. */
export async function seedTracker(l: Launched): Promise<Seeded> {
  const { ok, addJob, saveProfile } = api(l);
  await saveProfile();
  const a = await addJob('Nimbus Analytics GmbH', 'Data Engineer');
  await ok('jobs:setState', { id: a, state: 'shortlisted' });
  await ok('resume:generate', { jobId: a, requestId: randomUUID() });
  await ok('resume:markFinal', { jobId: a, version: 1 });
  const appA = await ok<{ id: string }>('apps:forJob', { jobId: a });
  await ok('apps:setStatus', { id: appA.id, status: 'applied' });
  await ok('apps:setStatus', { id: appA.id, status: 'screening' });
  await ok('apps:interview:add', {
    applicationId: appA.id,
    kind: 'screen',
    scheduledAt: new Date(Date.now() + DAY).toISOString(),
  });

  const b = await addJob('Contoso Data AG', 'Analytics Engineer', localDate(new Date(Date.now() + 2 * DAY)));
  await ok('jobs:setState', { id: b, state: 'shortlisted' });
  const appB = await ok<{ id: string }>('apps:forJob', { jobId: b });

  const c = await addJob('Initech Systems', 'Platform Engineer');
  await ok('jobs:setState', { id: c, state: 'shortlisted' });
  const appC = await ok<{ id: string }>('apps:forJob', { jobId: c });
  await ok('apps:setStatus', {
    id: appC.id,
    status: 'not_applying',
    meta: { reason: 'Relocation required' },
  });
  return {
    a: { jobId: a, appId: appA.id },
    b: { jobId: b, appId: appB.id },
    c: { jobId: c, appId: appC.id },
  };
}
