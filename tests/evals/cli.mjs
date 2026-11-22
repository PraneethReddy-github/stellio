#!/usr/bin/env node
// `npm run eval -- <task> [--limit N] [--only substring] [--model id]` runs the REAL Claude CLI over tests/evals fixtures.
// It uses your Claude login and counts against your usage: keep --limit small. Tasks: jd.parse, job.analyze, resume.generate, cover.generate, referrals (one search + one message; EVAL_COMPANY/EVAL_ROLE/EVAL_LOCATION), insights (one ask over a seeded fixture DB).
import { spawnSync } from 'node:child_process';

const [task, ...rest] = process.argv.slice(2);
if (
  !['jd.parse', 'job.analyze', 'resume.generate', 'cover.generate', 'referrals', 'insights'].includes(
    task ?? '',
  )
) {
  console.error(
    'usage: npm run eval -- <jd.parse|job.analyze|resume.generate|cover.generate|referrals|insights> [--limit N] [--only substring] [--model id]',
  );
  process.exit(2);
}
const flag = (name) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const res = spawnSync('npx', ['vitest', 'run', '-c', 'vitest.eval.config.mts'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    EVAL_TASK: task,
    EVAL_LIMIT: flag('limit') ?? '',
    EVAL_ONLY: flag('only') ?? '',
    EVAL_MODEL: flag('model') ?? '',
  },
});
process.exit(res.status ?? 1);
