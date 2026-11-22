import { readFileSync, realpathSync } from 'node:fs';
import { readdir, writeFile } from 'node:fs/promises';
import { sep } from 'node:path';
import { asc, eq } from 'drizzle-orm';
import {
  AnalysisSnapshotSchema,
  LANES,
  addLocalDays,
  daysSince,
  localDateStr,
  statusMetaProblem,
  isClosed,
  toMs,
} from '@shared/tracker';
import type {
  AppEvent,
  Application,
  Board,
  Contact,
  Interview,
  StatusMeta,
  TableFilters,
  TableRow,
  TableSort,
  TimelineItem,
  TrackerGet,
  AppStatus,
} from '@shared/tracker';
import type { GapRow } from '@shared/skills/schemas';
import type { Nudge } from '@shared/skills/nudges';
import type { JobSummary } from '@shared/jobs/schemas';
import type { Db } from '../../db/database';
import {
  appendEvent,
  availableContacts,
  deleteContact,
  deleteInterview,
  ensureApplication,
  getApplication,
  getApplicationByJob,
  getContact,
  getInterview,
  insertContact,
  insertInterview,
  linkContact,
  linkJobDocuments,
  linkedContacts,
  listEvents,
  listInterviews,
  setStatusRow,
  unlinkContact,
  updateApplicationRow,
  updateContact,
  updateInterview,
  type ApplicationPatch,
  type ContactRow,
  type EventRow,
  type InterviewRow,
  type NewContact,
  type NewInterview,
} from '../../db/repos/applications';
import { listDocumentVersions, type DocumentRow } from '../../db/repos/documents';
import { getJobSummary } from '../../db/repos/jobs';
import { jobSources, documents } from '../../db/schema';
import { UserError } from '../../ipc/dispatch';
import { effectiveNext, loadContexts, toApplication, type Ctx } from './context';
import { analysisSnapshot, finalDocument, freezeApplication, insideFolder } from './freeze';
import { computeToday, referralFollowUps } from './today';

export interface TrackerDeps {
  db: Db;
  dataDir: string;
  gitAvailable: boolean;
  /** Missing skills by demand for the skills pulse; omitted = none. */
  gaps?: () => Promise<GapRow[]>;
  /** Staleness nudges for "Needs you"; omitted = none. */
  nudges?: () => Promise<Nudge[]>;
  now?: () => Date;
}
/** Shows a save dialog; null = cancelled. */
export type PickCsvPath = (defaultName: string) => Promise<string | null>;

const BOM = String.fromCharCode(0xfeff);
const compact = <T extends object>(o: T): Partial<T> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
const cmpNullsLast = <T>(a: T | null, b: T | null, dir: 1 | -1): number => {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  return (typeof a === 'string' ? a.localeCompare(b as string) : (a as number) - (b as number)) * dir;
};
/** Cells that a spreadsheet would run as a formula get a leading quote. */
const csvCell = (v: string | number | null): string => {
  if (v === null) return '';
  const s = typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? `'${v}` : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};
const salaryText = (j: {
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  salaryPeriod: string | null;
}): string | null => {
  if (j.salaryMin === null && j.salaryMax === null) return null;
  const range =
    j.salaryMin !== null && j.salaryMax !== null && j.salaryMin !== j.salaryMax
      ? `${String(j.salaryMin)}-${String(j.salaryMax)}`
      : String(j.salaryMin ?? j.salaryMax);
  return `${range}${j.salaryCurrency ? ` ${j.salaryCurrency}` : ''}${j.salaryPeriod ? `/${j.salaryPeriod}` : ''}`;
};
/** End of a filter bound: a plain date includes the whole day. */
const boundEnd = (v: string): number =>
  /^\d{4}-\d{2}-\d{2}$/.test(v) ? addLocalDays(new Date(toMs(v)), 1).getTime() : toMs(v) + 1;

export function createTrackerService(deps: TrackerDeps) {
  const { db, dataDir } = deps;
  const now = deps.now ?? (() => new Date());
  const nowIso = (): string => now().toISOString();

  function requireCtx(id: string): Ctx {
    const c = loadContexts(db, id)[0];
    if (!c) throw new UserError('That application no longer exists.');
    return c;
  }
  const view = (id: string): Application => toApplication(requireCtx(id), now());
  function requireApp(id: string) {
    const a = getApplication(db, id);
    if (!a) throw new UserError('That application no longer exists.');
    return a;
  }

  const toEvent = (e: EventRow): AppEvent => ({
    id: e.id,
    applicationId: e.applicationId,
    type: e.type,
    fromStatus: e.fromStatus,
    toStatus: e.toStatus,
    at: e.at,
    payload: e.payloadJson ?? null,
  });
  const toInterview = (i: InterviewRow): Interview => ({
    id: i.id,
    applicationId: i.applicationId,
    round: i.round,
    kind: i.kind,
    scheduledAt: i.scheduledAt,
    outcome: i.outcome,
    notesMd: i.notesMd,
  });
  const toContact = (c: ContactRow): Contact => ({
    id: c.id,
    companyId: c.companyId,
    name: c.name,
    role: c.role,
    email: c.email,
    linkedinUrl: c.linkedinUrl,
    notesMd: c.notesMd,
  });

  function docVersions(jobId: string, kind: DocumentRow['kind']) {
    return listDocumentVersions(db, jobId, kind).map((d) => ({
      id: d.id,
      version: d.version,
      isFinal: d.isFinal,
      userEdited: d.userEdited,
      hasPdf: d.pdfPath !== null,
      model: d.model,
      createdAt: d.createdAt,
    }));
  }

  async function frozenFiles(folder: string): Promise<string[]> {
    try {
      return (await readdir(insideFolder(dataDir, folder))).filter((n) => !n.startsWith('.')).sort();
    } catch {
      return [];
    }
  }

  // ---- table ---------------------------------------------------------------------------------------------

  function tableRows(
    filters: TableFilters = {},
    sort: TableSort = { by: 'updatedAt', dir: 'desc' },
  ): TableRow[] {
    const t = now();
    const sources = new Map<string, string[]>();
    for (const s of db.orm.select().from(jobSources).orderBy(asc(jobSources.fetchedAt)).all())
      (sources.get(s.jobId) ?? sources.set(s.jobId, []).get(s.jobId))?.push(s.source);
    const finals = new Map(
      db.orm
        .select()
        .from(documents)
        .where(eq(documents.kind, 'resume'))
        .all()
        .filter((d) => d.isFinal)
        .map((d) => [d.jobId, d.version]),
    );
    const text = filters.text?.trim().toLowerCase();
    const from = filters.appliedFrom ? toMs(filters.appliedFrom) : null;
    const to = filters.appliedTo ? boundEnd(filters.appliedTo) : null;
    const rows = loadContexts(db)
      .filter((c) => !filters.status?.length || filters.status.includes(c.app.status))
      .filter(
        (c) =>
          !text ||
          [c.company, c.job.title, c.job.locationText ?? ''].some((s) => s.toLowerCase().includes(text)),
      )
      .filter((c) => !filters.source || (sources.get(c.job.id) ?? []).includes(filters.source))
      .filter((c) => {
        if (from === null && to === null) return true;
        if (!c.app.appliedAt) return false;
        const at = toMs(c.app.appliedAt);
        return (from === null || at >= from) && (to === null || at < to);
      })
      .map((c) => ({ c, next: effectiveNext(c, t) }))
      .filter(({ next }) => !filters.hasNextActionDue || (next.at !== null && toMs(next.at) <= t.getTime()))
      .map(({ c, next }): TableRow => ({
        id: c.app.id,
        jobId: c.job.id,
        company: c.company,
        role: c.job.title,
        status: c.app.status,
        fit: c.fit,
        appliedAt: c.app.appliedAt,
        daysSince: c.app.appliedAt ? daysSince(c.app.appliedAt, t) : null,
        source: sources.get(c.job.id)?.[0] ?? null,
        location: c.job.locationText,
        salary: salaryText(c.job),
        resumeVersion: finals.get(c.job.id) ?? null,
        nextAction: next.action,
        nextActionAt: next.at,
        priority: c.app.priority,
        updatedAt: c.app.updatedAt,
      }));
    const dir = sort.dir === 'asc' ? 1 : -1;
    const key = sort.by === 'daysSince' ? 'daysSince' : sort.by;
    return rows.sort(
      (a, b) =>
        cmpNullsLast(a[key], b[key], dir) || a.company.localeCompare(b.company) || a.id.localeCompare(b.id),
    );
  }

  /** Applications of one job-event kind inside [from, to]: plain dates cover the whole day. */
  function timeline(from: string, to: string): TimelineItem[] {
    const lo = toMs(from);
    const hi = boundEnd(to);
    const inside = (v: string | null): v is string => v !== null && toMs(v) >= lo && toMs(v) < hi;
    const out: TimelineItem[] = [];
    for (const c of loadContexts(db)) {
      const base = { applicationId: c.app.id, company: c.company, role: c.job.title };
      if (inside(c.app.appliedAt))
        out.push({ ...base, kind: 'applied', at: c.app.appliedAt, label: 'Applied' });
      for (const i of c.interviews)
        if (inside(i.scheduledAt) && i.outcome !== 'cancelled')
          out.push({
            ...base,
            kind: 'interview',
            at: i.scheduledAt,
            label: `Interview round ${String(i.round)} (${i.kind})`,
          });
      if (inside(c.job.deadlineAt) && ['saved', 'preparing', 'ready'].includes(c.app.status))
        out.push({ ...base, kind: 'deadline', at: c.job.deadlineAt, label: 'Application deadline' });
    }
    return out.sort((a, b) => toMs(a.at) - toMs(b.at) || a.company.localeCompare(b.company));
  }

  // ---- changes -------------------------------------------------------------------------------------------

  function note(id: string, type: 'note' | 'follow_up', text: string): AppEvent {
    requireApp(id);
    return toEvent(appendEvent(db, id, type, { text }, nowIso()));
  }

  return {
    forJob: (jobId: string): Application | null => {
      const a = getApplicationByJob(db, jobId);
      return a ? view(a.id) : null;
    },

    /** The application for a job (manual start); the existing one when there is one. */
    create(jobId: string): Application {
      if (!getJobSummary(db, jobId)) throw new UserError('That job no longer exists.');
      return view(ensureApplication(db, jobId, 'manual', nowIso()).app.id);
    },

    /**
     * Any status can follow any status (docs/08 §1). Applying freezes the final documents first; when that
     * fails nothing changes. Choosing the current status again is a no-op.
     */
    async setStatus(id: string, status: AppStatus, meta: StatusMeta = {}): Promise<Application> {
      const problem = statusMetaProblem(status, meta);
      if (problem) throw new UserError(problem);
      const ctx = requireCtx(id);
      if (ctx.app.status === status) return toApplication(ctx, now());
      const at = nowIso();
      const payload: Record<string, unknown> = compact(meta);
      if (status !== 'applied') {
        setStatusRow(db, id, status, payload, at);
        return view(id);
      }
      const frozen = await freezeApplication({
        db,
        dataDir,
        gitAvailable: deps.gitAvailable,
        ctx,
        now: now(),
        force: meta.force ? { reason: meta.forceReason?.trim() ?? '' } : null,
      });
      db.sqlite.transaction(() => {
        setStatusRow(db, id, 'applied', { ...payload, folder: frozen.folder }, at, {
          appliedAt: at,
          folderPath: frozen.folder,
          resumeDocId: frozen.resumeDocId,
          coverDocId: frozen.coverDocId,
        });
        appendEvent(
          db,
          id,
          'document',
          { frozen: frozen.folder, files: frozen.files, commit: frozen.commit },
          at,
        );
        linkJobDocuments(db, ctx.job.id, id);
      })();
      return view(id);
    },

    update(id: string, patch: ApplicationPatch): Application {
      requireApp(id);
      updateApplicationRow(db, id, compact(patch));
      return view(id);
    },

    note: (id: string, text: string, kind: 'note' | 'follow_up' = 'note'): AppEvent => note(id, kind, text),

    addInterview(applicationId: string, v: NewInterview): Interview {
      requireApp(applicationId);
      const row = insertInterview(db, applicationId, compact(v));
      appendEvent(
        db,
        applicationId,
        'interview',
        {
          action: 'added',
          interviewId: row.id,
          round: row.round,
          kind: row.kind,
          scheduledAt: row.scheduledAt,
        },
        nowIso(),
      );
      return toInterview(row);
    },
    updateInterview(id: string, v: NewInterview): Interview {
      const cur = getInterview(db, id);
      if (!cur) throw new UserError('That interview no longer exists.');
      const row = updateInterview(db, id, compact(v)) ?? cur;
      appendEvent(
        db,
        cur.applicationId,
        'interview',
        {
          action: 'updated',
          interviewId: id,
          round: row.round,
          outcome: row.outcome,
          scheduledAt: row.scheduledAt,
        },
        nowIso(),
      );
      return toInterview(row);
    },
    deleteInterview(id: string): boolean {
      const cur = getInterview(db, id);
      if (!cur) return false;
      deleteInterview(db, id);
      appendEvent(
        db,
        cur.applicationId,
        'interview',
        { action: 'deleted', interviewId: id, round: cur.round },
        nowIso(),
      );
      return true;
    },

    /** Creates a contact at the application's company and links it. */
    addContact(applicationId: string, v: NewContact & { name: string }): Contact {
      const ctx = requireCtx(applicationId);
      const row = db.sqlite.transaction(() => {
        const c = insertContact(db, ctx.job.companyId, compact(v) as NewContact & { name: string });
        linkContact(db, applicationId, c.id);
        appendEvent(
          db,
          applicationId,
          'contact',
          { action: 'added', contactId: c.id, name: c.name },
          nowIso(),
        );
        return c;
      })();
      return toContact(row);
    },
    updateContact(id: string, v: NewContact): Contact {
      const row = updateContact(db, id, compact(v));
      if (!row) throw new UserError('That contact no longer exists.');
      return toContact(row);
    },
    deleteContact: (id: string): boolean => deleteContact(db, id),
    linkContact(applicationId: string, contactId: string): void {
      requireApp(applicationId);
      const c = getContact(db, contactId);
      if (!c) throw new UserError('That contact no longer exists.');
      linkContact(db, applicationId, contactId);
      appendEvent(db, applicationId, 'contact', { action: 'linked', contactId, name: c.name }, nowIso());
    },
    unlinkContact(applicationId: string, contactId: string): boolean {
      const c = getContact(db, contactId);
      const removed = unlinkContact(db, applicationId, contactId);
      if (removed)
        appendEvent(
          db,
          applicationId,
          'contact',
          { action: 'unlinked', contactId, name: c?.name ?? null },
          nowIso(),
        );
      return removed;
    },
    contacts(applicationId: string): { linked: Contact[]; available: Contact[] } {
      const ctx = requireCtx(applicationId);
      return {
        linked: linkedContacts(db, applicationId).map(toContact),
        available: availableContacts(db, applicationId, ctx.job.companyId).map(toContact),
      };
    },

    // ---- queries -----------------------------------------------------------------------------------------

    board(): Board {
      const t = now();
      const ctxs = loadContexts(db).sort(
        (a, b) =>
          b.app.statusChangedAt.localeCompare(a.app.statusChangedAt) || a.app.id.localeCompare(b.app.id),
      );
      return {
        lanes: LANES.map((lane) => ({
          id: lane.id,
          label: lane.label,
          statuses: [...lane.statuses],
          cards: ctxs
            .filter((c) => (lane.statuses as readonly AppStatus[]).includes(c.app.status))
            .map((c) => {
              const next = effectiveNext(c, t);
              return {
                id: c.app.id,
                jobId: c.job.id,
                company: c.company,
                role: c.job.title,
                fit: c.fit,
                daysInStatus: daysSince(c.app.statusChangedAt, t),
                nextAction: next.action,
                nextActionAt: next.at,
                status: c.app.status,
                priority: c.app.priority,
              };
            }),
        })),
      };
    },

    table: tableRows,

    /** Writes the filtered, sorted table as CSV where the user picks (UTF-8 with BOM so Excel reads umlauts). */
    async exportCsv(filters: TableFilters | undefined, sort: TableSort | undefined, pick: PickCsvPath) {
      const rows = tableRows(filters, sort);
      const path = await pick(`stellio-applications-${localDateStr(now())}.csv`);
      if (!path) return { status: 'cancelled' as const };
      const head = [
        'Company',
        'Role',
        'Status',
        'Fit',
        'Applied',
        'Days since',
        'Source',
        'Location',
        'Salary',
        'Resume version',
        'Next action',
        'Next action due',
        'Priority',
      ];
      const lines = rows.map((r) =>
        [
          r.company,
          r.role,
          r.status,
          r.fit,
          r.appliedAt,
          r.daysSince,
          r.source,
          r.location,
          r.salary,
          r.resumeVersion,
          r.nextAction,
          r.nextActionAt,
          r.priority,
        ]
          .map(csvCell)
          .join(','),
      );
      await writeFile(path, `${BOM}${[head.join(','), ...lines].join('\r\n')}\r\n`);
      return { status: 'saved' as const, path, rows: rows.length };
    },

    timeline,

    async get(id: string): Promise<TrackerGet> {
      const ctx = requireCtx(id);
      const job: JobSummary | undefined = getJobSummary(db, ctx.job.id);
      if (!job) throw new UserError('That job no longer exists.');
      const folder = ctx.app.folderPath;
      let analysis = null;
      let analysisFrozen = false;
      if (folder) {
        try {
          const raw = JSON.parse(
            readFileSync(`${insideFolder(dataDir, folder)}${sep}analysis.json`, 'utf8'),
          ) as unknown;
          const parsed = AnalysisSnapshotSchema.safeParse(raw);
          if (parsed.success) {
            analysis = parsed.data;
            analysisFrozen = true;
          }
        } catch {
          // no snapshot file: fall back to the live analysis
        }
      }
      analysis ??= analysisSnapshot(
        db,
        ctx.job.id,
        ctx.app.resumeDocId ?? finalDocument(db, ctx.job.id, 'resume')?.id ?? null,
      );
      return {
        application: toApplication(ctx, now()),
        job,
        events: listEvents(db, id).map(toEvent),
        interviews: listInterviews(db, id).map(toInterview),
        contacts: linkedContacts(db, id).map(toContact),
        documents: {
          resume: docVersions(ctx.job.id, 'resume'),
          cover: docVersions(ctx.job.id, 'cover_letter'),
        },
        frozen: folder ? { folder, files: await frozenFiles(folder) } : null,
        analysis,
        analysisFrozen,
      };
    },

    async today() {
      let missing: Awaited<ReturnType<NonNullable<TrackerDeps['gaps']>>> = [];
      try {
        missing = (await deps.gaps?.()) ?? [];
      } catch {
        // an unreadable profile must not break the dashboard: the skills pulse is just empty
      }
      let nudges: Nudge[] = [];
      try {
        nudges = (await deps.nudges?.()) ?? [];
      } catch {
        // same: a profile that cannot be read just has no nudges
      }
      return computeToday(
        db,
        now(),
        missing.map((g) => ({
          skill: g.skill,
          jobCount: g.demand.jobCount,
          share: g.demand.share,
          requiredShare: g.demand.requiredShare,
        })),
        nudges,
      );
    },

    /** The application's frozen folder as an absolute path inside the data folder (for shell.openPath). */
    folderPath(id: string): string {
      const folder = requireApp(id).folderPath;
      if (!folder)
        throw new UserError('This application has no saved folder yet. It is made when you apply.');
      const abs = insideFolder(dataDir, folder);
      let real: string;
      try {
        real = realpathSync(abs);
      } catch {
        throw new UserError('The application folder is missing.');
      }
      const root = realpathSync(dataDir);
      if (!real.startsWith(root + sep)) throw new UserError('That path is outside the data folder.');
      return real;
    },

    /** Applications whose follow-up is due now (open ones), for the daily digest. */
    dueFollowUps(): { company: string; role: string; action: string; at: string }[] {
      const t = now();
      const all = loadContexts(db);
      return all
        .map((c) => ({ c, n: effectiveNext(c, t) }))
        .filter(({ n }) => n.action !== null && n.at !== null && toMs(n.at) <= t.getTime())
        .map(({ c, n }) => ({
          company: c.company,
          role: c.job.title,
          action: n.action as string,
          at: n.at as string,
        }))
        .concat(
          referralFollowUps(
            db,
            all.filter((c) => !isClosed(c.app.status)),
            t,
          ),
        )
        .sort((a, b) => toMs(a.at) - toMs(b.at));
    },
  };
}
export type TrackerService = ReturnType<typeof createTrackerService>;
