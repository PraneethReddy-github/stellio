import { z } from 'zod';
import { AnalysisResultSchema, JobSummarySchema } from '../jobs/schemas';
import { NudgeSchema } from '../skills/nudges';
import { APPLICATION_STATUSES, REJECT_STAGES, statusMetaProblem } from './status';

export const AppStatusSchema = z.enum(APPLICATION_STATUSES);
export const CHANNELS = ['company_site', 'platform', 'referral', 'email', 'recruiter'] as const;
export const INTERVIEW_KINDS = ['screen', 'technical', 'onsite', 'hr', 'final', 'other'] as const;
export const INTERVIEW_OUTCOMES = ['pending', 'passed', 'failed', 'cancelled'] as const;
export const EVENT_TYPES = [
  'status_change',
  'note',
  'interview',
  'follow_up',
  'contact',
  'document',
  'email',
  'referral',
] as const;
export const TABLE_SORTS = [
  'company',
  'role',
  'status',
  'fit',
  'appliedAt',
  'daysSince',
  'priority',
  'nextActionAt',
  'updatedAt',
] as const;

/** ISO datetime or a plain date. */
export const IsoWhen = z.union([z.iso.datetime({ offset: true }), z.iso.date()]);

export const StatusMetaSchema = z.object({
  stage: z.enum(REJECT_STAGES).optional(),
  reason: z.string().max(500).optional(),
  note: z.string().max(2000).optional(),
  deadline: IsoWhen.optional(),
  force: z.boolean().optional(),
  forceReason: z.string().max(500).optional(),
});

/** `apps:setStatus` input; rejected / ghosted need a stage, not_applying a reason, force a reason. */
export const SetStatusInputSchema = z
  .object({ id: z.string().min(1).max(64), status: AppStatusSchema, meta: StatusMetaSchema.optional() })
  .superRefine((v, ctx) => {
    const problem = statusMetaProblem(v.status, v.meta);
    if (problem) ctx.addIssue({ code: 'custom', message: problem, path: ['meta'] });
  });

export const ApplicationSchema = z.object({
  id: z.string(),
  jobId: z.string(),
  company: z.string(),
  role: z.string(),
  status: AppStatusSchema,
  statusChangedAt: z.string(),
  appliedAt: z.string().nullable(),
  channel: z.enum(CHANNELS).nullable(),
  priority: z.number().int().nullable(),
  /** The one the user set, else the suggested one (docs/08 §2). */
  nextAction: z.string().nullable(),
  nextActionAt: z.string().nullable(),
  nextActionSuggested: z.boolean(),
  folderPath: z.string().nullable(),
  resumeDocId: z.string().nullable(),
  coverDocId: z.string().nullable(),
  salaryExpectation: z.string().nullable(),
  notesMd: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Application = z.infer<typeof ApplicationSchema>;

export const AppEventSchema = z.object({
  id: z.string(),
  applicationId: z.string(),
  type: z.enum(EVENT_TYPES),
  fromStatus: AppStatusSchema.nullable(),
  toStatus: AppStatusSchema.nullable(),
  at: z.string(),
  payload: z.unknown(),
});
export type AppEvent = z.infer<typeof AppEventSchema>;

export const InterviewSchema = z.object({
  id: z.string(),
  applicationId: z.string(),
  round: z.number().int(),
  kind: z.enum(INTERVIEW_KINDS),
  scheduledAt: z.string().nullable(),
  outcome: z.enum(INTERVIEW_OUTCOMES),
  notesMd: z.string().nullable(),
});
export type Interview = z.infer<typeof InterviewSchema>;

export const ContactSchema = z.object({
  id: z.string(),
  companyId: z.string().nullable(),
  name: z.string(),
  role: z.string().nullable(),
  email: z.string().nullable(),
  linkedinUrl: z.string().nullable(),
  notesMd: z.string().nullable(),
});
export type Contact = z.infer<typeof ContactSchema>;

// ---- views -------------------------------------------------------------------------------------------------

export const BoardCardSchema = z.object({
  id: z.string(),
  jobId: z.string(),
  company: z.string(),
  role: z.string(),
  fit: z.number().nullable(),
  daysInStatus: z.number().int(),
  nextAction: z.string().nullable(),
  nextActionAt: z.string().nullable(),
  status: AppStatusSchema,
  priority: z.number().int().nullable(),
});
export type BoardCard = z.infer<typeof BoardCardSchema>;
export const BoardSchema = z.object({
  lanes: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      statuses: z.array(AppStatusSchema),
      cards: z.array(BoardCardSchema),
    }),
  ),
});
export type Board = z.infer<typeof BoardSchema>;

export const TableFiltersSchema = z.object({
  status: z.array(AppStatusSchema).max(16).optional(),
  text: z.string().max(200).optional(),
  source: z.string().max(40).optional(),
  appliedFrom: IsoWhen.optional(),
  appliedTo: IsoWhen.optional(),
  hasNextActionDue: z.boolean().optional(),
});
export type TableFilters = z.infer<typeof TableFiltersSchema>;
export const TableSortSchema = z.object({ by: z.enum(TABLE_SORTS), dir: z.enum(['asc', 'desc']) });
export type TableSort = z.infer<typeof TableSortSchema>;
export const TableInputSchema = z.object({
  filters: TableFiltersSchema.optional(),
  sort: TableSortSchema.optional(),
});

export const TableRowSchema = z.object({
  id: z.string(),
  jobId: z.string(),
  company: z.string(),
  role: z.string(),
  status: AppStatusSchema,
  fit: z.number().nullable(),
  appliedAt: z.string().nullable(),
  daysSince: z.number().int().nullable(),
  source: z.string().nullable(),
  location: z.string().nullable(),
  salary: z.string().nullable(),
  resumeVersion: z.number().int().nullable(),
  nextAction: z.string().nullable(),
  nextActionAt: z.string().nullable(),
  priority: z.number().int().nullable(),
  updatedAt: z.string(),
});
export type TableRow = z.infer<typeof TableRowSchema>;

export const TimelineItemSchema = z.object({
  kind: z.enum(['applied', 'interview', 'deadline']),
  at: z.string(),
  applicationId: z.string(),
  company: z.string(),
  role: z.string(),
  label: z.string(),
});
export type TimelineItem = z.infer<typeof TimelineItemSchema>;

const DocVersion = z.object({
  id: z.string(),
  version: z.number().int(),
  isFinal: z.boolean(),
  userEdited: z.boolean(),
  hasPdf: z.boolean(),
  model: z.string().nullable(),
  createdAt: z.string(),
});
export const AnalysisSnapshotSchema = z.object({
  fitScore: z.number().nullable(),
  verdict: z.string().nullable(),
  model: z.string(),
  promptVersion: z.string(),
  profileHash: z.string(),
  createdAt: z.string(),
  result: AnalysisResultSchema.nullable(),
  skillAudit: z.array(
    z.object({
      skill: z.string(),
      origin: z.string(),
      jdImportance: z.string(),
      recommendation: z.string(),
      decision: z.string(),
    }),
  ),
});
export type AnalysisSnapshot = z.infer<typeof AnalysisSnapshotSchema>;

export const TrackerGetSchema = z.object({
  application: ApplicationSchema,
  job: JobSummarySchema,
  events: z.array(AppEventSchema),
  interviews: z.array(InterviewSchema),
  contacts: z.array(ContactSchema),
  documents: z.object({ resume: z.array(DocVersion), cover: z.array(DocVersion) }),
  /** The folder made when you applied: its files (names only). Null before applying. */
  frozen: z.object({ folder: z.string(), files: z.array(z.string()) }).nullable(),
  /** From the frozen analysis.json when there is one, else the latest analysis now. */
  analysis: AnalysisSnapshotSchema.nullable(),
  analysisFrozen: z.boolean(),
});
export type TrackerGet = z.infer<typeof TrackerGetSchema>;

// ---- Today -------------------------------------------------------------------------------------------------

const AppRef = z.object({ applicationId: z.string(), company: z.string(), role: z.string() });
export const TodaySummarySchema = z.object({
  generatedAt: z.string(),
  statusLine: z.array(
    z.object({
      key: z.enum(['saved', 'ready', 'applied', 'in_process', 'waiting', 'offers', 'rejected']),
      label: z.string(),
      /** Applications that entered this group this month. */
      count: z.number().int(),
      previous: z.number().int(),
      delta: z.number().int(),
      /** Applications in this group right now. */
      current: z.number().int(),
    }),
  ),
  needsYou: z.object({
    followUps: z.array(AppRef.extend({ action: z.string(), at: z.string(), overdueDays: z.number().int() })),
    readyNotSent: z.array(AppRef.extend({ daysInStatus: z.number().int() })),
    deadlines: z.array(AppRef.extend({ deadline: z.string(), daysLeft: z.number().int() })),
    interviews: z.array(
      AppRef.extend({
        interviewId: z.string(),
        round: z.number().int(),
        kind: z.enum(INTERVIEW_KINDS),
        at: z.string(),
        when: z.enum(['today', 'tomorrow']),
      }),
    ),
    ghosted: z.array(AppRef.extend({ since: z.string(), days: z.number().int() })),
    /** Profile and skills staleness (docs/07 §4). */
    nudges: z.array(NudgeSchema),
  }),
  newMatches: z.array(
    z.object({
      jobId: z.string(),
      company: z.string(),
      title: z.string(),
      fit: z.number().nullable(),
      reason: z.string().nullable(),
    }),
  ),
  funnel: z.object({
    windowDays: z.number().int(),
    steps: z.array(
      z.object({
        key: z.enum(['discovered', 'shortlisted', 'applied', 'response', 'interview', 'offer']),
        label: z.string(),
        count: z.number().int(),
        /** count / previous step (0-1); null for the first step or when the previous is 0. */
        conversion: z.number().nullable(),
      }),
    ),
  }),
  weekly: z.array(z.object({ weekStart: z.string(), count: z.number().int() })),
  skills: z.object({
    missing: z.array(
      z.object({
        skill: z.string(),
        jobCount: z.number().int(),
        share: z.number(),
        requiredShare: z.number(),
      }),
    ),
    learning: z.array(
      z.object({ id: z.string(), skill: z.string(), priority: z.number().int(), status: z.string() }),
    ),
  }),
  lastScan: z
    .object({
      id: z.string(),
      startedAt: z.string(),
      finishedAt: z.string().nullable(),
      trigger: z.string(),
      status: z.string(),
      newJobs: z.number().int(),
      perSource: z.record(
        z.string(),
        z.object({ fetched: z.number(), new: z.number(), errors: z.array(z.string()) }),
      ),
      error: z.string().nullable(),
    })
    .nullable(),
});
export type TodaySummary = z.infer<typeof TodaySummarySchema>;
