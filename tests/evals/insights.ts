import { expect } from 'vitest';
import { appendEvent } from '../../src/main/db/repos/applications';
import { createJob } from '../../src/main/db/repos/jobs';
import { insertLearningItem, recomputeSkillDemand } from '../../src/main/db/repos/skills';
import { applications } from '../../src/main/db/schema';
import { createInsightsService } from '../../src/main/services/insights/service';
import { createLearningService } from '../../src/main/services/skills/learning';
import type { AppStatus } from '../../src/shared/tracker';
import { sampleJd } from '../fixtures/jobs';
import { costOf, evalServices, type ResumeEvalEnv } from './resume';

const DAY = 86_400_000;
const ROLES = [
  'Data Engineer',
  'Analytics Engineer',
  'Backend Developer',
  'Data Analyst',
  'Platform Engineer',
];
const SOURCES = ['greenhouse', 'adzuna', 'lever'];
const REMOTE = ['remote', 'hybrid', 'onsite'] as const;
const SKILLS = [
  ['Python', 'SQL', 'dbt'],
  ['Python', 'Airflow'],
  ['Go', 'Kubernetes'],
  ['SQL', 'Tableau'],
  ['Terraform', 'AWS'],
];

/**
 * One real `insights.ask` over a seeded fixture database of 30 sent applications (fictional, deterministic):
 * replies depend on the board and the fit score, so there is a real pattern to find. Prints whether the
 * numbers check passed on the first run, after the repair, or only with a warning, and the cost.
 */
export async function evalInsights(env: ResumeEvalEnv): Promise<void> {
  const { line } = env;
  const { db, settings, runner, profile, runs } = evalServices(env, ['insights.ask']);
  const now = new Date();

  for (let i = 0; i < 30; i++) {
    const role = ROLES[i % ROLES.length] as string;
    const source = SOURCES[i % SOURCES.length] as string;
    const fit = 45 + ((i * 7) % 50);
    const skills = SKILLS[i % SKILLS.length] as string[];
    const appliedAt = new Date(now.getTime() - (i + 8) * DAY).toISOString();
    const job = createJob(
      db,
      `Company ${String(i)}`,
      {
        title: i % 4 === 0 ? `Senior ${role}` : role,
        dedupeKey: `eval-${String(i)}`,
        state: 'shortlisted',
        remote: REMOTE[i % 3],
        postedAt: new Date(now.getTime() - (i + 8 + (i % 9)) * DAY).toISOString(),
        structuredJson: {
          ...sampleJd,
          requirements: [{ text: 'Core skills', kind: 'required', skills }],
        },
      },
      { source: source as 'adzuna', externalId: `x${String(i)}`, url: null, rawJson: null },
    );
    const replied = fit >= 75 || source === 'greenhouse';
    const interviewed = replied && fit >= 85;
    const status: AppStatus = interviewed ? 'interviewing' : replied ? 'rejected' : 'applied';
    const app = db.orm
      .insert(applications)
      .values({ jobId: job.id, status, statusChangedAt: appliedAt, appliedAt })
      .returning()
      .get();
    appendEvent(db, app.id, 'status_change', {}, appliedAt, { to: 'applied' });
    if (replied)
      appendEvent(
        db,
        app.id,
        'status_change',
        {},
        new Date(Date.parse(appliedAt) + (2 + (i % 5)) * DAY).toISOString(),
        {
          to: status,
        },
      );
  }
  recomputeSkillDemand(db);
  insertLearningItem(db, 'dbt', { estHours: 20, status: 'todo' });
  insertLearningItem(db, 'Tableau', { estHours: 30, status: 'doing' });

  const learning = createLearningService({ db, runner, settings, profile });
  const insights = createInsightsService({ db, runner, settings, learning });
  const summary = insights.summary('all');
  line(
    `\ninsights.ask  model=${settings.forTask('insights.ask').model}  seeded ${String(summary.totals.applications)} applications, reply rate ${String(Math.round((summary.totals.responseRate ?? 0) * 100))}%`,
  );

  const question = 'Which roles should I prioritize, and what should I learn next?';
  const t0 = Date.now();
  const a = await insights.ask(question);
  const calls = runs.filter((r) => r.task === 'insights.ask').length;
  line(`  ${String(Date.now() - t0)} ms, ${String(calls)} CLI run${calls === 1 ? '' : 's'}`);
  line(`  answer: ${a.answer.replace(/\s+/g, ' ')}`);
  line(`  numbers used: ${a.numbersUsed.map((n) => `${n.label}=${n.value}`).join('; ') || 'none'}`);
  line(`  warning: ${a.warning ?? 'none'}`);
  line('\nSCORECARD insights.ask');
  line(
    `  numbers check ${a.warning === null ? (calls === 1 ? 'passed on the first run' : 'passed after the repair round') : 'FAILED twice (shown with a warning)'}`,
  );
  line(`  cost $${costOf(runs, 'insights.ask')} over ${String(calls)} run${calls === 1 ? '' : 's'}`);
  expect(a.answer.length).toBeGreaterThan(0);
}
