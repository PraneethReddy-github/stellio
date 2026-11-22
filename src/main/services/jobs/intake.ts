import { createHash } from 'node:crypto';
import { dedupeKey } from '@shared/jobs/dedupe';
import { aiFailureMessage } from '../../ai/failure';
import type { ClaudeRunner } from '../../ai/runner';
import { parseJd } from '../../ai/tasks/jdParse';
import type { Db } from '../../db/database';
import { setAiRunRelated } from '../../db/repos/aiRuns';
import { createJob, findJobByDedupeKey, findJobByHash } from '../../db/repos/jobs';
import { recomputeSkillDemand } from '../../db/repos/skills';
import { UserError } from '../../ipc/dispatch';
import type { AiSettingsService } from '../settings/ai';
import { guardedFetch, httpUrlOrNull, type Fetcher } from './net';
import { fetchJobPage, type PageHint } from './page';

export type IntakeResult =
  { status: 'ok'; jobId: string; duplicate: boolean } | { status: 'needs_text'; reason: string };

export interface IntakeHint extends Partial<Omit<PageHint, 'source'>> {
  url?: string;
  source?: PageHint['source'];
  /** `<title>` of a fetched page: only used when the text gives no title. */
  pageTitle?: string;
}

export interface IntakeDeps {
  db: Db;
  runner: ClaudeRunner;
  settings: AiSettingsService;
  /** Tests inject a fetcher; production uses `guardedFetch`. */
  fetcher?: Fetcher;
}

const MIN_TEXT_CHARS = 50;

/** Hash over whitespace/case-folded text, so a re-paste with different line breaks still matches. */
export const hashText = (md: string): string =>
  createHash('sha256').update(md.toLowerCase().replace(/\s+/g, ' ').trim()).digest('hex');

const isUniqueViolation = (e: unknown): boolean =>
  e instanceof Error && (e as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE';

export function createIntake({ db, runner, settings, fetcher = guardedFetch }: IntakeDeps) {
  /** Stores a posting from its text: dedupe by hash, `jd.parse`, dedupe by key, insert. */
  async function intakeText(
    text: string,
    hint: IntakeHint = {},
    signal?: AbortSignal,
  ): Promise<IntakeResult> {
    const url = httpUrlOrNull(hint.url);
    const md = text.replace(/\r\n?/g, '\n').replaceAll('\0', '').trim();
    if (md.length < MIN_TEXT_CHARS) throw new UserError('That text is too short to be a job posting.');
    const hash = hashText(md);
    const sameText = findJobByHash(db, hash);
    if (sameText) return { status: 'ok', jobId: sameText.id, duplicate: true };

    const res = await parseJd(runner, { text: md, config: settings.forTask('jd.parse'), signal });
    if (!res.ok) throw new UserError(aiFailureMessage(res.status, res.error));
    const jd = res.data;

    const knownCompany = hint.company?.trim() || jd.company?.trim() || hint.companyFallback;
    const knownTitle = hint.title?.trim() || jd.title?.trim() || hint.pageTitle;
    const company = knownCompany || 'Unknown company';
    const title = knownTitle || 'Untitled role';
    const { city, country, remote } = jd.location;
    // A placeholder says nothing about the role, so only the same text may match it.
    const key = dedupeKey({ company, title, city, remote }) + (knownCompany && knownTitle ? '' : `|${hash}`);
    const link = (jobId: string, duplicate: boolean): IntakeResult => {
      setAiRunRelated(db, res.runId, 'job', jobId);
      return { status: 'ok', jobId, duplicate };
    };
    const sameRole = findJobByDedupeKey(db, key);
    if (sameRole) return link(sameRole.id, true);

    try {
      const job = createJob(
        db,
        company,
        {
          title,
          locationText: [city, country].filter(Boolean).join(', ') || null,
          country,
          remote,
          employmentType: jd.employment_type,
          seniority: jd.seniority,
          salaryMin: jd.salary?.min ?? null,
          salaryMax: jd.salary?.max ?? null,
          salaryCurrency: jd.salary?.currency ?? null,
          salaryPeriod: jd.salary?.period ?? null,
          language: jd.language,
          url,
          applyUrl: httpUrlOrNull(hint.applyUrl) ?? url,
          postedAt: hint.postedAt ?? null,
          deadlineAt: jd.deadline,
          descriptionMd: md,
          descriptionHash: hash,
          structuredJson: jd,
          dedupeKey: key,
        },
        {
          source: hint.source ?? 'manual',
          externalId: hint.externalId ?? `hash:${hash}`,
          url,
          rawJson: hint.raw ?? null,
        },
      );
      // Demand is derived data: a failure here must not undo an intake that already succeeded.
      try {
        recomputeSkillDemand(db);
      } catch {
        // the next intake recomputes it
      }
      return link(job.id, false);
    } catch (e) {
      // Two intakes of the same posting raced past the checks above.
      const existing = isUniqueViolation(e)
        ? (findJobByDedupeKey(db, key) ?? findJobByHash(db, hash))
        : undefined;
      if (existing) return link(existing.id, true);
      throw e;
    }
  }

  /** `source` overrides where the posting is recorded as found (the web search agent passes `websearch`). */
  async function intakeUrl(
    url: string,
    signal?: AbortSignal,
    source?: PageHint['source'],
  ): Promise<IntakeResult> {
    const page = await fetchJobPage(url, fetcher, signal);
    if (page.status === 'needs_text') return page;
    const { title, ...hint } = page.hint;
    // An ATS title is exact; a page <title> is only a fallback ("Careers at Acme").
    return intakeText(
      page.markdown,
      {
        ...hint,
        url: page.url,
        ...(source ? { source } : {}),
        ...(hint.source === 'manual' ? { pageTitle: title } : { title }),
      },
      signal,
    );
  }

  return { intakeText, intakeUrl };
}
export type Intake = ReturnType<typeof createIntake>;
