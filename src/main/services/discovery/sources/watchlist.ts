import { z } from 'zod';
import { NormalizedJobSchema, type NormalizedJob, type WatchEntry } from '@shared/discovery/schemas';
import { isAtsSlug, parseAtsResponse, type AtsKind } from '../../jobs/ats';
import { fragmentToMarkdown } from '../../jobs/html';
import { httpUrlOrNull } from '../../jobs/net';
import { baseUrl, blankJob, SourceError, type SourceAdapter, type SourceCtx } from './http';

/**
 * Company watchlist: the vendors' public board-list endpoints, polled for every watched company. Items are mapped
 * with the same parsers the manual URL intake uses (`parseAtsResponse`), so both paths agree on every field.
 */
export const ATS_KINDS: readonly AtsKind[] = ['greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workable'];
const enc = encodeURIComponent;

const DEFAULT_HOSTS: Record<AtsKind, string> = {
  greenhouse: 'https://boards-api.greenhouse.io',
  lever: 'https://api.lever.co',
  ashby: 'https://api.ashbyhq.com',
  smartrecruiters: 'https://api.smartrecruiters.com',
  workable: 'https://apply.workable.com',
};

export function listUrl(kind: AtsKind, slug: string): string {
  const b = baseUrl(kind, DEFAULT_HOSTS[kind]);
  const co = enc(slug);
  switch (kind) {
    case 'greenhouse':
      return `${b}/v1/boards/${co}/jobs?content=true`;
    case 'lever':
      return `${b}/v0/postings/${co}?mode=json`;
    case 'ashby':
      return `${b}/posting-api/job-board/${co}?includeCompensation=true`;
    case 'smartrecruiters':
      return `${b}/v1/companies/${co}/postings?limit=100`;
    case 'workable':
      return `${b}/api/v1/widget/accounts/${co}?details=true`;
  }
}

/** Board URLs (`boards.greenhouse.io/acme`) and links found in a careers page, to `{kind, slug}`. */
const BOARD_HOSTS: [RegExp, AtsKind][] = [
  [/^(?:job-boards(?:\.eu)?|boards)\.greenhouse\.io$/, 'greenhouse'],
  [/^jobs(?:\.eu)?\.lever\.co$/, 'lever'],
  [/^jobs\.ashbyhq\.com$/, 'ashby'],
  [/^(?:jobs|careers)\.smartrecruiters\.com$/, 'smartrecruiters'],
  [/^apply\.workable\.com$/, 'workable'],
];
export function detectBoard(rawUrl: string): { kind: AtsKind; slug: string } | null {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  const hit = BOARD_HOSTS.find(([re]) => re.test(u.hostname.toLowerCase()));
  if (!hit) return null;
  // Greenhouse embeds: boards.greenhouse.io/embed/job_board?for=<slug>
  const embedded = u.searchParams.get('for');
  const slug = embedded ?? u.pathname.split('/').filter(Boolean)[0] ?? '';
  return isAtsSlug(slug) && slug !== 'embed' ? { kind: hit[1], slug } : null;
}
export function detectBoardInHtml(html: string): { kind: AtsKind; slug: string } | null {
  for (const m of html.matchAll(/https?:\/\/[a-z0-9.-]+\.[a-z]{2,}[^\s"'<>)]*/gi)) {
    const found = detectBoard(m[0].replace(/&amp;/g, '&'));
    if (found) return found;
  }
  return null;
}

const Items = {
  greenhouse: z.looseObject({ jobs: z.array(z.unknown()) }).transform((o) => o.jobs),
  lever: z.array(z.unknown()),
  ashby: z.looseObject({ jobs: z.array(z.unknown()), compensation: z.unknown().nullish() }),
  smartrecruiters: z.looseObject({ content: z.array(z.unknown()) }).transform((o) => o.content),
  workable: z.looseObject({ name: z.string().nullish(), jobs: z.array(z.unknown()) }),
};
const idOf = (item: unknown, key: string): string | null => {
  const v = (item as Record<string, unknown> | null)?.[key];
  return typeof v === 'string' || typeof v === 'number' ? String(v) : null;
};

interface RawBoardJob {
  kind: AtsKind;
  slug: string;
  company: string;
  /** Greenhouse/Lever/SmartRecruiters: the posting. Ashby/Workable: a one-job board payload. */
  payload: unknown;
  id: string;
}

/** All postings of one board as raw items. SmartRecruiters needs one extra request per new posting. */
async function* boardJobs(ctx: SourceCtx, e: WatchEntry): AsyncGenerator<RawBoardJob> {
  const kind = e.atsType as AtsKind;
  const slug = e.atsSlug ?? '';
  if (!ATS_KINDS.includes(kind) || !isAtsSlug(slug))
    throw new SourceError(`${e.company}: not a supported board`);
  const body = await ctx.getJson(listUrl(kind, slug));
  const base = { kind, slug, company: e.company };
  const fail = (): never => {
    throw new SourceError(`${e.company}: unexpected ${kind} response`);
  };
  switch (kind) {
    case 'greenhouse':
    case 'lever': {
      const items = Items[kind].safeParse(body);
      if (!items.success) return fail();
      for (const payload of items.data) {
        const id = idOf(payload, 'id');
        if (id) yield { ...base, payload, id };
      }
      return;
    }
    case 'ashby': {
      const board = Items.ashby.safeParse(body);
      if (!board.success) return fail();
      for (const j of board.data.jobs) {
        const id = idOf(j, 'id');
        if (id) yield { ...base, payload: { jobs: [j], compensation: board.data.compensation }, id };
      }
      return;
    }
    case 'workable': {
      const board = Items.workable.safeParse(body);
      if (!board.success) return fail();
      for (const j of board.data.jobs) {
        const id = idOf(j, 'shortcode');
        if (id) yield { ...base, payload: { name: board.data.name, jobs: [j] }, id };
      }
      return;
    }
    case 'smartrecruiters': {
      const items = Items.smartrecruiters.safeParse(body);
      if (!items.success) return fail();
      for (const stub of items.data) {
        const id = idOf(stub, 'id');
        if (!id || ctx.isKnown(`${slug}/${id}`)) {
          if (id) yield { ...base, payload: stub, id };
          continue;
        }
        if (ctx.detailBudget.left <= 0) continue;
        ctx.detailBudget.left--;
        const detail = await ctx.getJson(
          `${baseUrl(kind, DEFAULT_HOSTS[kind])}/v1/companies/${enc(slug)}/postings/${enc(id)}`,
        );
        yield { ...base, payload: detail, id };
      }
      return;
    }
  }
}

export function createWatchlistAdapter(watch: () => WatchEntry[]): SourceAdapter {
  return {
    id: 'watchlist',
    label: 'Company watchlist',
    needsKey: false,
    rateLimit: { rps: 2, burst: 4 },
    perProfile: false,
    queryless: true,
    applies: () => watch().length > 0,
    async *search(ctx) {
      const entries = watch();
      const errors: string[] = [];
      let yielded = 0;
      for (const e of entries) {
        try {
          for await (const j of boardJobs(ctx, e)) {
            if (yielded++ >= ctx.limit) return;
            yield j;
          }
        } catch (err) {
          if (ctx.signal.aborted) throw err;
          // one broken board must not hide the others
          errors.push(err instanceof SourceError ? err.message : `${e.company}: request failed`);
        }
      }
      if (errors.length > 0 && errors.length === entries.length) throw new SourceError(errors.join('; '));
      if (errors.length > 0) throw new SourceError(`Some boards failed: ${errors.join('; ')}`);
    },
    normalize(raw): NormalizedJob {
      const r = raw as RawBoardJob;
      const ref = { kind: r.kind, company: r.slug, id: r.id, apiUrl: '', apiHost: '' };
      const j = parseAtsResponse(ref, r.payload);
      const body = fragmentToMarkdown(j.descriptionHtml);
      return NormalizedJobSchema.parse({
        ...blankJob(r.kind),
        externalId: `${r.slug}/${r.id}`,
        url: httpUrlOrNull(j.url),
        applyUrl: httpUrlOrNull(j.applyUrl) ?? httpUrlOrNull(j.url),
        title: j.title,
        company: j.company ?? r.company,
        locationText: j.location,
        city: j.location?.split(/[,;]/)[0]?.trim() || null,
        remote: j.remote ?? (/\bremote\b/i.test(j.location ?? '') ? 'remote' : 'unknown'),
        postedAt: j.postedAt,
        descriptionMd: [j.salaryText && `Salary: ${j.salaryText}`, body].filter(Boolean).join('\n\n'),
      });
    },
  };
}
