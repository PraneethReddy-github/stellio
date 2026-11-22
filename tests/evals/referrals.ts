import { expect } from 'vitest';
import { createJob } from '../../src/main/db/repos/jobs';
import { allContacts } from '../../src/main/db/repos/referrals';
import { createReferralsService } from '../../src/main/services/referrals/service';
import { costOf, evalServices, type ResumeEvalEnv } from './resume';

/**
 * One real `referrals.search` and one real `referrals.message` (top candidate) with the fictional full profile.
 * Prints counts only: no names or other details of real people (docs/14 §6).
 * Target: EVAL_COMPANY / EVAL_ROLE / EVAL_LOCATION (default SAP SE, software engineer, Germany).
 */
export async function evalReferrals(env: ResumeEvalEnv): Promise<void> {
  const { line } = env;
  const { db, settings, runner, profile, rules, runs } = evalServices(env, [
    'referrals.search',
    'referrals.message',
  ]);
  const company = process.env.EVAL_COMPANY || 'SAP SE';
  const role = process.env.EVAL_ROLE || 'software engineer';
  const location = process.env.EVAL_LOCATION || 'Germany';
  const job = createJob(db, company, {
    title: 'Software Engineer',
    dedupeKey: 'eval-referrals',
    descriptionMd: `Software Engineer at ${company}.`,
    locationText: location,
    state: 'shortlisted',
  });
  const referrals = createReferralsService({ db, runner, settings, profile, rules });

  line(
    `\nreferrals.search  model=${settings.forTask('referrals.search').model}  company="${company}"  role="${role}"  location="${location}"`,
  );
  const t0 = Date.now();
  const out = await referrals.search({ jobId: job.id, company, role, location });
  line(`  returned ${String(out.returned)}, kept ${String(out.kept)} in ${String(Date.now() - t0)} ms`);
  line(`  dropped ${out.dropped.map((d) => `${d.reason}=${String(d.count)}`).join(', ') || 'none'}`);

  const contacts = allContacts(db);
  const unsourced = contacts.filter((c) => !/^https?:\/\//.test(c.source_url));
  const kinds = new Map<string, number>();
  for (const i of out.items)
    for (const u of i.person.profileUrls) kinds.set(u.kind, (kinds.get(u.kind) ?? 0) + 1);
  const hosts = new Set(out.items.flatMap((i) => i.person.sources.map((s) => new URL(s.url).hostname)));
  line(`  profile url kinds ${[...kinds].map(([k, n]) => `${k}=${String(n)}`).join(', ') || 'none'}`);
  line(
    `  distinct source hosts ${String(hosts.size)}; facts per person avg ${(out.items.reduce((a, i) => a + i.person.sources.reduce((b, s) => b + s.facts.length, 0), 0) / Math.max(1, out.items.length)).toFixed(1)}`,
  );
  line(`  contacts kept ${String(contacts.length)}, without source_url ${String(unsourced.length)}`);
  line(
    `  people with shared ground ${String(out.items.filter((i) => i.person.sharedGround.length > 0).length)}`,
  );
  line(
    `  top scores ${out.items
      .slice(0, 5)
      .map((i) => String(i.score))
      .join(', ')}`,
  );

  const top = out.items[0];
  let ok = false;
  if (top) {
    const t1 = Date.now();
    const rec = await referrals.draft(top.personId, job.id);
    const c = rec.checks;
    ok = c?.ok === true;
    line(
      `\nreferrals.message  model=${settings.forTask('referrals.message').model}  ${String(Date.now() - t1)} ms`,
    );
    line(
      `  note ${String(rec.noteText?.length ?? 0)} chars, body ${String((rec.messageBody ?? '').split(/\s+/).filter(Boolean).length)} words, language ${rec.language ?? '?'}`,
    );
    line(`  lint issues ${String(c?.lint.length ?? -1)} [${c?.lint.map((l) => l.rule).join(', ') ?? ''}]`);
    line(
      `  truth violations ${String(c?.truth.length ?? -1)} [${c?.truth.map((v) => v.kind).join(', ') ?? ''}]`,
    );
    line(`  CLI runs for the message: ${String(runs.filter((r) => r.task === 'referrals.message').length)}`);
  }
  line('\nSCORECARD referrals');
  line(`  candidates returned ${String(out.returned)}, kept after validation ${String(out.kept)}`);
  line(`  contacts kept ${String(contacts.length)}; unsourced ${String(unsourced.length)} (must be 0)`);
  line(`  message lint+truth clean ${ok ? 'yes' : 'no'}`);
  line(`  cost search $${costOf(runs, 'referrals.search')}, message $${costOf(runs, 'referrals.message')}`);
  expect(unsourced).toEqual([]);
}
