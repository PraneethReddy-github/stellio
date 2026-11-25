import { z } from 'zod';
import { lintRules } from '@shared/rules';
import {
  DEFAULT_RETENTION_DAYS,
  FOLLOW_UP_DAYS,
  MAX_CANDIDATES,
  ReferralSettingsSchema,
  checkMessage,
  detectLanguage,
  rankPeople,
  groundForSearch,
  sharedGroundFrom,
  validateCandidates,
  type Language,
  type MessageChecks,
  type MessageOutput,
  type ReferralItem,
  type ReferralRequest,
  type ReferralSettings,
  type ReferralStatus,
  type SearchExclude,
  type SearchHints,
  type SearchOutcome,
  type Person,
} from '@shared/referrals';
import { aiFailureMessage } from '../../ai/failure';
import { deleteReferralLogs } from '../../ai/logs';
import type { ClaudeRunner } from '../../ai/runner';
import { draftReferralMessage, searchReferrals } from '../../ai/tasks/referrals';
import type { Db } from '../../db/database';
import { setAiRunRelated } from '../../db/repos/aiRuns';
import { appendEvent, ensureApplication } from '../../db/repos/applications';
import { getJob, getJobSummary, upsertCompanyByName } from '../../db/repos/jobs';
import {
  deleteAllPeople,
  deletePerson,
  dueItems,
  findRequest,
  getPerson,
  getRequestRow,
  itemsByIds,
  listItems,
  purgeExpired,
  rebasePurge,
  requestsOfPerson,
  setPurgeAfter,
  toRequest,
  updateRequest,
  upsertPerson,
  upsertRequest,
  wasContacted,
} from '../../db/repos/referrals';
import { getSetting, setSetting } from '../../db/repos/settings';
import { UserError } from '../../ipc/dispatch';
import { hashText } from '../datafolder/files';
import { draftWithRepair, withoutExcluded } from '../documents/common';
import { requireRealProfile } from '../profile/guard';
import type { ProfileService } from '../profile/service';
import type { RulesService } from '../rules/service';
import type { AiSettingsService } from '../settings/ai';

const SETTINGS_KEY = 'referrals.settings';
const DAY_MS = 86_400_000;

export interface ReferralsDeps {
  db: Db;
  runner: ClaudeRunner;
  settings: AiSettingsService;
  profile: ProfileService;
  rules: RulesService;
  /** Where AI run logs live; deleting people also deletes the referrals run logs that name them. */
  aiLogDir?: string;
  now?: () => Date;
  onError?: (e: unknown) => void;
}

export type SearchStage = 'searching' | 'validating' | 'saving';
export interface SearchInput {
  jobId?: string;
  company: string;
  role: string;
  location?: string;
  hints?: SearchHints;
  exclude?: SearchExclude;
}

/** "Jane D.": first name and last initial, the form shown on the application timeline. */
export function shortName(full: string): string {
  const parts = full.trim().split(/\s+/);
  const first = parts[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1] ?? '') : '';
  return last ? `${first} ${last.charAt(0).toUpperCase()}.` : first;
}

const EVENT_TEXT: Record<ReferralStatus, (who: string) => string> = {
  not_contacted: (w) => `Outreach to ${w} reset`,
  contacted: (w) => `Asked ${w} for a referral`,
  replied: (w) => `${w} replied`,
  referred: (w) => `${w} referred you`,
  declined: (w) => `${w} declined to refer you`,
  no_response: (w) => `No response from ${w}`,
};

export function createReferralsService(deps: ReferralsDeps) {
  const { db, runner } = deps;
  const now = deps.now ?? (() => new Date());
  const nowIso = (): string => now().toISOString();
  let timer: NodeJS.Timeout | undefined;

  function settings(): ReferralSettings {
    try {
      const stored = getSetting(db, SETTINGS_KEY, z.unknown());
      const merged = ReferralSettingsSchema.safeParse({
        retentionDays: DEFAULT_RETENTION_DAYS,
        ...(typeof stored === 'object' && stored !== null ? stored : {}),
      });
      if (merged.success) return merged.data;
    } catch {
      // a broken stored value falls back to the default
    }
    return { retentionDays: DEFAULT_RETENTION_DAYS };
  }
  const purgeAt = (from: Date): string =>
    new Date(from.getTime() + settings().retentionDays * DAY_MS).toISOString();

  function requireItem(id: string): ReferralItem {
    const row = getRequestRow(db, id);
    const item = row ? itemsByIds(db, [id])[0] : undefined;
    if (!item) throw new UserError('That referral request no longer exists.');
    return item;
  }

  /** Never-contacted people expire; contacted ones are kept. */
  function refreshPurge(personId: string): void {
    const p = getPerson(db, personId);
    if (!p) return;
    setPurgeAfter(db, personId, wasContacted(db, personId) ? null : purgeAt(new Date(p.lastSeenAt)));
  }

  async function search(
    input: SearchInput,
    o: { signal?: AbortSignal; onProgress?: (stage: SearchStage, count?: number) => void } = {},
  ): Promise<SearchOutcome> {
    const company = input.company.trim();
    const role = input.role.trim();
    if (company === '' || role === '') throw new UserError('Enter a company and a role to search for.');
    if (input.jobId && !getJobSummary(db, input.jobId)) throw new UserError('That job no longer exists.');
    const hints = input.hints ?? {};
    const progress = o.onProgress ?? (() => undefined);
    const snap = await deps.profile.get();
    requireRealProfile(snap.model);
    const ground = sharedGroundFrom(withoutExcluded(snap.model));
    const at = now();

    progress('searching');
    const run = await searchReferrals(runner, {
      company,
      role,
      location: (input.location ?? '').trim(),
      hints,
      exclude: input.exclude,
      ground: groundForSearch(ground),
      limit: MAX_CANDIDATES,
      today: at.toISOString().slice(0, 10),
      config: deps.settings.forTask('referrals.search'),
      signal: o.signal,
    });
    if (input.jobId) setAiRunRelated(db, run.runId, 'job', input.jobId);
    if (!run.ok) throw new UserError(aiFailureMessage(run.status, run.error));

    progress('validating', run.data.candidates.length);
    const companyRow = upsertCompanyByName(db, company);
    const valid = validateCandidates(run.data.candidates, {
      company,
      companyDomains: companyRow.domain ? [companyRow.domain] : [],
      now: at,
      exclude: input.exclude,
    });
    const keywords = role
      .split(/[,;/]|\bor\b/i)
      .map((k) => k.trim())
      .filter(Boolean);
    const ranked = rankPeople(
      valid.people,
      {
        roleKeywords: keywords,
        team: hints.team,
        seniority: hints.seniority,
        location: input.location,
        alumni: hints.alumni,
      },
      ground,
      at,
    );

    progress('saving', ranked.length);
    const ids = db.sqlite.transaction(() =>
      ranked.map((r) => {
        const person = upsertPerson(db, r.person, {
          companyId: companyRow.id,
          ground: r.sharedGround,
          now: at.toISOString(),
          purgeAfter: purgeAt(at),
        });
        return upsertRequest(db, person.id, input.jobId ?? null, { why: r.why, score: r.score }).id;
      }),
    )();
    return {
      returned: valid.returned,
      kept: valid.people.length,
      dropped: valid.dropped,
      items: itemsByIds(db, ids).sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id)),
    };
  }

  async function draft(
    personId: string,
    jobId: string,
    o: { signal?: AbortSignal } = {},
  ): Promise<ReferralItem> {
    const person = getPerson(db, personId);
    if (!person) throw new UserError('That person no longer exists.');
    const job = getJob(db, jobId);
    const summary = getJobSummary(db, jobId);
    if (!job || !summary) throw new UserError('That job no longer exists.');

    const [snap, rulesFile, policyFile] = await Promise.all([
      deps.profile.get(),
      deps.rules.get('rules/referral-message.md'),
      deps.rules.get('rules/skills-policy.md'),
    ]);
    const rules = lintRules('referral-message', rulesFile.content).config;
    if (!rules) throw new UserError('rules/referral-message.md has errors. Fix them in Rules first.');
    const policy = lintRules('skills-policy', policyFile.content).config;
    if (!policy) throw new UserError('rules/skills-policy.md has errors. Fix them in Rules first.');
    requireRealProfile(snap.model);
    const profile = withoutExcluded(snap.model);
    const config = deps.settings.forTask('referrals.message');

    const facts = person.sources.flatMap((s) => s.facts.map((text) => ({ text, source_url: s.url })));
    const personTexts = [person.title, person.locationText, ...facts.map((f) => f.text)];
    const expected: Language | null = detectLanguage(personTexts.join('. '));
    const language: Language = rules.match_language && expected ? expected : 'en';
    const reference = job.url ?? job.id;
    const ground = sharedGroundFrom(profile);
    const ctx = {
      roleTitle: job.title,
      company: summary.company,
      jobRefs: [job.url ?? '', job.id].filter(Boolean),
      personFacts: personTexts,
      ground,
      expectedLanguage: expected,
    };
    const truthInput = {
      policy,
      jobTitle: job.title,
      jobCompany: summary.company,
      jobLocation: summary.locationText ?? '',
      person: {
        name: person.fullName,
        title: person.title,
        location: person.locationText,
        facts: personTexts,
      },
    };
    const base = {
      profile,
      rulesText: rulesFile.content,
      job: { title: job.title, company: summary.company, location: summary.locationText ?? '', reference },
      person: {
        name: person.fullName,
        title: person.title,
        company: person.company,
        location: person.locationText,
        facts,
      },
      language,
      config,
      signal: o.signal,
    };

    const { best, model } = await draftWithRepair<
      MessageOutput,
      { content: MessageOutput; issues: string[]; rank: [number, number]; checks: MessageChecks }
    >({
      db,
      jobId,
      model: config.model,
      onStage: () => undefined,
      run: (repair) =>
        draftReferralMessage(runner, { ...base, previous: repair?.previous, repairIssues: repair?.issues }),
      evaluate: (content) => {
        const checks = checkMessage(content, rules, profile, ctx, truthInput);
        return Promise.resolve({
          content,
          checks,
          issues: [
            ...checks.lint.map((i) => `Rules (${i.rule}): ${i.message}`),
            ...checks.truth.map((v) => `Truth (${v.kind}): "${v.text}": ${v.detail}`),
          ],
          rank: [checks.truth.length, checks.lint.length],
        });
      },
    });

    const request =
      findRequest(db, personId, jobId) ?? upsertRequest(db, personId, jobId, { why: '', score: 0 });
    updateRequest(db, request.id, {
      noteText: best.content.connection_note.trim(),
      messageSubject: best.content.subject.trim(),
      messageBody: best.content.body.trim(),
      language: best.content.language,
      checksJson: best.checks,
      rulesHash: hashText(`${rulesFile.hash}\n${policyFile.hash}`),
      model,
      promptVersion: 'referrals.message@v1',
    });
    return requireItem(request.id);
  }

  function setStatus(id: string, status: ReferralStatus, note?: string): ReferralItem {
    const item = requireItem(id);
    const text = note?.trim() ?? '';
    if (item.status === status && text === '') return item;
    const at = nowIso();
    const patch: Parameters<typeof updateRequest>[2] = { status };
    if (status === 'contacted') {
      patch.contactedAt = item.contactedAt ?? at;
      patch.nextActionAt = new Date(now().getTime() + FOLLOW_UP_DAYS * DAY_MS).toISOString();
    } else if (status === 'not_contacted') {
      patch.contactedAt = null;
      patch.nextActionAt = null;
    } else patch.nextActionAt = null;
    if (text) patch.notesMd = [item.notesMd, `${at.slice(0, 10)}: ${text}`].filter(Boolean).join('\n');

    db.sqlite.transaction(() => {
      if (item.jobId && item.status !== status) {
        const { app } = ensureApplication(db, item.jobId, 'manual', at);
        patch.applicationId = app.id;
        const who = `${shortName(item.person.fullName)} (${item.person.company})`;
        appendEvent(
          db,
          app.id,
          'referral',
          {
            action: status,
            personId: item.personId,
            text: EVENT_TEXT[status](who),
            ...(text ? { note: text } : {}),
          },
          at,
        );
      }
      updateRequest(db, id, patch);
      refreshPurge(item.personId);
    })();
    return requireItem(id);
  }

  const purge = (): number => purgeExpired(db, nowIso());

  /** All or none, then the run logs that name them. Returns how many existed. */
  async function deletePeople(ids: readonly string[]): Promise<number> {
    const found = ids.flatMap((id) => getPerson(db, id) ?? []);
    const deleted = db.sqlite.transaction(() => found.filter((p) => deletePerson(db, p.id)).length)();
    if (found.length > 0 && deps.aiLogDir)
      await deleteReferralLogs(
        db,
        deps.aiLogDir,
        found.flatMap((p) => [p.fullName, ...p.profileUrls.map((u) => u.url)]),
      );
    return deleted;
  }

  return {
    search,
    draft,
    setStatus,
    settings,

    setSettings(v: unknown): ReferralSettings {
      const parsed = ReferralSettingsSchema.parse(v);
      setSetting(db, SETTINGS_KEY, parsed);
      rebasePurge(db, parsed.retentionDays);
      return parsed;
    },

    list: (jobId?: string): ReferralItem[] => listItems(db, jobId),
    due: (): ReferralItem[] => dueItems(db, nowIso()),

    person(id: string): { person: Person; requests: ReferralRequest[] } {
      const person = getPerson(db, id);
      if (!person) throw new UserError('That person no longer exists.');
      return { person, requests: requestsOfPerson(db, id).map(toRequest) };
    },

    async deletePerson(personId: string): Promise<boolean> {
      return (await deletePeople([personId])) > 0;
    },
    deletePeople,
    async deleteAll(): Promise<number> {
      const n = deleteAllPeople(db);
      if (deps.aiLogDir) await deleteReferralLogs(db, deps.aiLogDir);
      return n;
    },

    /** Deletes never-contacted people whose retention ran out. */
    purge,

    /** Purges now and then daily; a failure is reported and retried at the next tick. */
    start(intervalMs = DAY_MS): void {
      if (timer) return;
      const safe = (): void => {
        try {
          purge();
        } catch (e) {
          deps.onError?.(e);
        }
      };
      safe();
      timer = setInterval(safe, intervalMs);
      timer.unref();
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
export type ReferralsService = ReturnType<typeof createReferralsService>;
