import { ZodError } from 'zod';
import { UserError } from '../../ipc/dispatch';
import { AtsNotFoundError, detectAts, parseAtsResponse, type AtsJob, type AtsRef } from './ats';
import { extractPage, fragmentToMarkdown, MIN_JD_CHARS } from './html';
import { FetchError, guardedFetch, httpUrlOrNull, type Fetcher } from './net';

export interface PageHint {
  title?: string;
  /** From the ATS payload: trusted over the parsed text. */
  company?: string;
  /** Last resort when nothing else names the company (the ATS board slug). */
  companyFallback?: string;
  applyUrl?: string;
  postedAt?: string;
  /** Source kind and id for `job_sources`. */
  source: AtsRef['kind'] | 'manual' | 'websearch';
  externalId?: string;
  raw?: unknown;
}
export type PageResult =
  { status: 'ok'; markdown: string; url: string; hint: PageHint } | { status: 'needs_text'; reason: string };

const BLOCKED_STATUS = new Set([401, 403, 429, 999]);
const NEEDS_TEXT_HELP = 'Paste the job text instead.';

function atsMarkdown(j: AtsJob): string {
  const head = [
    `# ${j.title}`,
    j.company && `Company: ${j.company}`,
    j.location && `Location: ${j.location}`,
    j.remote && `Workplace: ${j.remote}`,
    j.salaryText && `Salary: ${j.salaryText}`,
    j.deadline && `Application deadline: ${j.deadline}`,
  ].filter(Boolean);
  return `${head.join('\n')}\n\n${fragmentToMarkdown(j.descriptionHtml)}`.trim();
}

async function fetchAts(
  ref: AtsRef,
  url: string,
  fetcher: Fetcher,
  signal?: AbortSignal,
): Promise<PageResult> {
  const res = await fetcher(ref.apiUrl, { signal, accept: 'application/json', allowedHosts: [ref.apiHost] });
  if (res.status === 404) throw new UserError('That posting was not found. It may have been closed.');
  if (res.status !== 200)
    throw new UserError(`The job board answered HTTP ${String(res.status)}. ${NEEDS_TEXT_HELP}`);
  let job: AtsJob;
  try {
    job = parseAtsResponse(ref, JSON.parse(res.body));
  } catch (e) {
    if (e instanceof AtsNotFoundError)
      throw new UserError('That posting was not found. It may have been closed.');
    if (e instanceof SyntaxError || e instanceof ZodError)
      return {
        status: 'needs_text',
        reason: `The ${ref.kind} job board returned an unexpected response. ${NEEDS_TEXT_HELP}`,
      };
    throw e;
  }
  const markdown = atsMarkdown(job);
  if (!job.descriptionHtml.trim())
    return {
      status: 'needs_text',
      reason: `The posting on ${ref.kind} has no description. ${NEEDS_TEXT_HELP}`,
    };
  return {
    status: 'ok',
    markdown,
    url: httpUrlOrNull(job.url) ?? url,
    hint: {
      title: job.title,
      ...(job.company ? { company: job.company } : {}),
      companyFallback: ref.company,
      ...(job.applyUrl ? { applyUrl: job.applyUrl } : {}),
      ...(job.postedAt ? { postedAt: job.postedAt } : {}),
      source: ref.kind,
      externalId: `${ref.company}/${ref.id}`,
      raw: job.raw,
    },
  };
}

/** Fetches a job posting URL: vendor JSON for known ATS links, otherwise HTML to Markdown. */
export async function fetchJobPage(
  url: string,
  fetcher: Fetcher = guardedFetch,
  signal?: AbortSignal,
): Promise<PageResult> {
  try {
    const ats = detectAts(url);
    if (ats) return await fetchAts(ats, url, fetcher, signal);

    const res = await fetcher(url, { signal });
    if (BLOCKED_STATUS.has(res.status))
      return {
        status: 'needs_text',
        reason: `The site blocked the request (HTTP ${String(res.status)}). ${NEEDS_TEXT_HELP}`,
      };
    if (res.status === 404 || res.status === 410)
      throw new UserError('That page was not found. It may have been closed.');
    if (res.status < 200 || res.status >= 300)
      throw new UserError(`The site answered HTTP ${String(res.status)}.`);

    const text = /json/i.test(res.contentType) || /plain/i.test(res.contentType) ? res.body.trim() : null;
    const page = text === null ? extractPage(res.body) : { markdown: text, title: null, loginWall: false };
    if (page.loginWall)
      return {
        status: 'needs_text',
        reason: `This looks like a sign-in or bot-check page. ${NEEDS_TEXT_HELP}`,
      };
    if (page.markdown.length < MIN_JD_CHARS)
      return {
        status: 'needs_text',
        reason: `Only ${String(page.markdown.length)} characters of text could be read; the page probably needs JavaScript or a login. ${NEEDS_TEXT_HELP}`,
      };
    return {
      status: 'ok',
      markdown: page.markdown,
      url: res.finalUrl,
      hint: { ...(page.title ? { title: page.title } : {}), source: 'manual' },
    };
  } catch (e) {
    if (e instanceof FetchError) throw new UserError(e.message);
    throw e;
  }
}
