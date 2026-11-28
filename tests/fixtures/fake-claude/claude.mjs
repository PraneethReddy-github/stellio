#!/usr/bin/env node
// Fake `claude` CLI for runner tests. Behaviour is chosen by env FAKE_CLAUDE_MODE.
// Other env: FAKE_CLAUDE_CAPTURE (ndjson file: argv/stdin/cwd/env per call, plus end markers),
// FAKE_CLAUDE_OUTPUT (JSON for structured_output, default {"answer":"hi"}), FAKE_CLAUDE_DELAY_MS,
// FAKE_CLAUDE_STATE (counter file for *_then_ok modes), FAKE_CLAUDE_PIDFILE (hang modes write the grandchild pid).
// Per-task overrides: the task is recognised from the --json-schema keys (JD_PARSE, JOB_ANALYZE, JOB_SIDE_FIT, PROFILE_IMPORT, SKILLS_AUDIT,
// JOB_TRIAGE, DISCOVERY_WEBSEARCH, REFERRALS_SEARCH, REFERRALS_MESSAGE, INSIGHTS_ASK, LEARNING_RESOURCES, PROFILE_SUGGEST;
// RESUME_GENERATE / RESUME_REVISE, COVER_GENERATE / COVER_REVISE and RESUME_TRANSLATE / COVER_TRANSLATE share a schema
// per pair and are told apart by the system prompt);
// FAKE_CLAUDE_OUTPUT_<TASK>, FAKE_CLAUDE_MODE_<TASK> and FAKE_CLAUDE_DELAY_MS_<TASK> win over the plain variables.
// A resume, cover, referral-message or insights-ask repair round (stdin has <repair_issues>) answers FAKE_CLAUDE_OUTPUT_<TASK>_REPAIR when set.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const out = (line) => process.stdout.write(line + '\n');
const env = process.env;
const argv = process.argv.slice(2);
const taskOf = () => {
  try {
    const keys = Object.keys(JSON.parse(argv[argv.indexOf('--json-schema') + 1]).properties ?? {});
    if (keys.includes('fit_score')) return 'JOB_ANALYZE';
    if (keys.includes('side_score')) return 'JOB_SIDE_FIT';
    if (keys.includes('responsibilities')) return 'JD_PARSE';
    if (keys.includes('front')) return 'PROFILE_IMPORT';
    if (keys.includes('rows')) return 'SKILLS_AUDIT';
    if (keys.includes('scores')) return 'JOB_TRIAGE';
    if (keys.includes('results')) return 'DISCOVERY_WEBSEARCH';
    if (keys.includes('candidates')) return 'REFERRALS_SEARCH';
    if (keys.includes('connection_note')) return 'REFERRALS_MESSAGE';
    if (keys.includes('numbers_used')) return 'INSIGHTS_ASK';
    if (keys.includes('resources')) return 'LEARNING_RESOURCES';
    if (keys.includes('skill_updates')) return 'PROFILE_SUGGEST';
    const system = argv[argv.indexOf('--system-prompt') + 1] ?? '';
    if (keys.length === 1 && keys[0] === 'items')
      return /cover letter/.test(system.split('\n')[0] ?? '') ? 'COVER_TRANSLATE' : 'RESUME_TRANSLATE';
    const revise = /^You revise/.test(system);
    if (keys.includes('paragraphs')) return revise ? 'COVER_REVISE' : 'COVER_GENERATE';
    if (keys.includes('change_log')) return revise ? 'RESUME_REVISE' : 'RESUME_GENERATE';
  } catch {
    // no schema (preflight ping etc.): plain variables apply
  }
  return null;
};
const task = taskOf();
const tenv = (name) => (task && env[`${name}_${task}`]) ?? env[name];
const mode = tenv('FAKE_CLAUDE_MODE') ?? 'ok';
const streaming = argv.includes('stream-json');

if (argv[0] === '--version') {
  out('2.1.328 (Claude Code)');
  process.exit(0);
}

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const stdin = Buffer.concat(chunks).toString('utf8');

const capture = (rec) => {
  if (env.FAKE_CLAUDE_CAPTURE) appendFileSync(env.FAKE_CLAUDE_CAPTURE, JSON.stringify(rec) + '\n');
};
capture({
  kind: 'call',
  argv,
  stdin,
  cwd: process.cwd(),
  env: {
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: env.CLAUDE_CODE_DISABLE_AUTO_MEMORY ?? null,
    CLAUDE_CODE_SIMPLE: env.CLAUDE_CODE_SIMPLE ?? null,
  },
  t: Date.now(),
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bump = () => {
  const f = env.FAKE_CLAUDE_STATE;
  if (!f) return 1;
  const n = (existsSync(f) ? Number(readFileSync(f, 'utf8')) : 0) + 1;
  writeFileSync(f, String(n));
  return n;
};

const envelope = (extra) => ({
  type: 'result',
  subtype: 'success', // the real CLI says "success" even on errors
  is_error: false,
  api_error_status: null,
  duration_ms: 12,
  num_turns: 2,
  total_cost_usd: 0.0012,
  usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  session_id: 'fake',
  ...extra,
});
const repairOutput = () =>
  task && stdin.includes('<repair_issues>') ? env[`FAKE_CLAUDE_OUTPUT_${task}_REPAIR`] : undefined;
// JOB_TRIAGE without a fixed output scores every <job id="..."> in stdin: FAKE_CLAUDE_TRIAGE_SCORES is a JSON map
// {"text in the job block": score}, anything else gets FAKE_CLAUDE_TRIAGE_DEFAULT (75).
const triageOutput = () => {
  const map = JSON.parse(env.FAKE_CLAUDE_TRIAGE_SCORES ?? '{}');
  const scores = [...stdin.matchAll(/<job id="([^"]+)">([\s\S]*?)<\/job>/g)].map(([, id, body]) => {
    const hit = Object.entries(map).find(([text]) => body.includes(text));
    return {
      id,
      score: hit ? hit[1] : Number(env.FAKE_CLAUDE_TRIAGE_DEFAULT ?? 75),
      reason: 'Fake triage reason.',
    };
  });
  return { scores };
};
const okOutput = () =>
  JSON.parse(
    repairOutput() ??
      tenv('FAKE_CLAUDE_OUTPUT') ??
      (task === 'JOB_TRIAGE' ? JSON.stringify(triageOutput()) : '{"answer":"hi"}'),
  );
const okEnvelope = (out = okOutput()) => envelope({ result: JSON.stringify(out), structured_output: out });
const errEnvelope = (result, api_error_status = null) =>
  envelope({ is_error: true, api_error_status, terminal_reason: 'api_error', result });

const emit = (final, code = 0) => {
  if (streaming) {
    out(JSON.stringify({ type: 'system', subtype: 'init', model: 'fake' }));
    out(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '...' }] } }));
    out(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }));
  }
  out(JSON.stringify(final));
  capture({ kind: 'end', t: Date.now() });
  process.exit(code);
};

if (tenv('FAKE_CLAUDE_DELAY_MS')) await sleep(Number(tenv('FAKE_CLAUDE_DELAY_MS')));

switch (mode) {
  case 'ok':
    emit(okEnvelope());
    break;
  case 'invalid_then_ok':
    emit(bump() === 1 ? okEnvelope({ wrong: true }) : okEnvelope());
    break;
  case 'invalid_always':
    emit(okEnvelope({ wrong: true }));
    break;
  case 'result_text_only':
    emit(envelope({ result: JSON.stringify(okOutput()) }));
    break;
  case 'auth':
    emit(errEnvelope('Not logged in · Please run /login'), 1);
    break;
  case 'usage_limit':
    emit(errEnvelope("You've hit your usage limit · resets 5pm (UTC)", 429), 1);
    break;
  case 'bad_model':
    console.error('[claude-code:unrecognized_model] {"model":"claude-nope-9"}');
    emit(errEnvelope("There's an issue with the selected model (claude-nope-9).", 404), 1);
    break;
  case 'nonzero_with_json':
    emit(errEnvelope('boom: something broke'), 1);
    break;
  case 'overloaded':
    emit(errEnvelope('API Error: Overloaded', 529), 1);
    break;
  case 'overloaded_then_ok':
    if (bump() === 1) emit(errEnvelope('API Error: Overloaded', 529), 1);
    else emit(okEnvelope());
    break;
  case 'hang':
  case 'hang_stubborn': {
    // grandchild stays in our process group: the group kill must reap it too
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    if (env.FAKE_CLAUDE_PIDFILE) writeFileSync(env.FAKE_CLAUDE_PIDFILE, String(child.pid));
    process.on('SIGTERM', mode === 'hang' ? () => process.exit(143) : () => undefined);
    setInterval(() => undefined, 1000);
    break;
  }
  default:
    console.error(`unknown FAKE_CLAUDE_MODE ${mode}`);
    process.exit(2);
}
