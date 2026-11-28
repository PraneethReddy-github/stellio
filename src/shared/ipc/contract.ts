import { z } from 'zod';
import { RESUME_STAGES, ResumeDocumentSchema, ResumeVersionSummarySchema } from '../documents/schemas';
import { CoverDocumentSchema, CoverVersionSummarySchema } from '../documents/cover';
import { AiRunLogSchema, AiRunSchema, RunIdSchema } from '../ai/runs';
import { AnalysisRecordSchema, JOB_STATES, JobDetailSchema, JobSummarySchema } from '../jobs/schemas';
import { AiSettingsSchema } from '../settings/ai';
import { NotificationSettingsSchema } from '../settings/notifications';
import { UpdateSettingsSchema, UpdateStatusSchema, type UpdateProgress } from '../settings/updates';
import { BackupEntrySchema } from '../backups';
import { SetupPatchSchema, SetupStateSchema } from '../setup';
import {
  DiscoverySettingsSchema,
  InboxInputSchema,
  InboxItemSchema,
  ScanOutcomeSchema,
  ScanRunSchema,
  ScheduleSchema,
  SearchProfileInputSchema,
  SearchProfileSchema,
  SourceIdSchema,
  SourceStatusSchema,
  TimerPreviewSchema,
  TimerStatusSchema,
  WatchEntrySchema,
} from '../discovery/schemas';
import {
  AppEventSchema,
  ApplicationSchema,
  BoardSchema,
  CHANNELS,
  ContactSchema,
  INTERVIEW_KINDS,
  INTERVIEW_OUTCOMES,
  InterviewSchema,
  IsoWhen,
  SetStatusInputSchema,
  TableInputSchema,
  TableRowSchema,
  TimelineItemSchema,
  TodaySummarySchema,
  TrackerGetSchema,
} from '../tracker/schemas';
import {
  PersonSchema,
  ReferralItemSchema,
  ReferralRequestSchema,
  ReferralSettingsSchema,
  ReferralStatusSchema,
  SearchHintsSchema,
  SearchExcludeSchema,
  SearchOutcomeSchema,
} from '../referrals/schemas';
import { DiagnosticSchema, ProfileSchema } from '../profile';
import { ProfileSuggestionSchema } from '../profile/suggest';
import { INSIGHT_WINDOWS, InsightsAnswerSchema, InsightsSummarySchema } from '../insights/schemas';
import { RoadmapItemSchema, WhatIfSchema } from '../skills/roadmap';
import { RULES_AND_TEMPLATE_FILES, TEMPLATE_FILES } from '../rules/files';
import { SKILL_CATEGORIES, SKILL_STATUSES, SkillRowSchema } from '../profile';
import {
  DEMAND_WINDOWS,
  GapRowSchema,
  LEARNING_STATUSES,
  LearningItemSchema,
  LedgerRowSchema,
  ProfilePreviewSchema,
  SKILL_DECIDE_ACTIONS,
  SkillAuditRowSchema,
} from '../skills/schemas';

const PhotoState = z.object({ present: z.boolean(), dataUrl: z.string().nullable() });
const ProfileSnapshot = z.object({
  markdown: z.string(),
  model: ProfileSchema,
  diagnostics: z.array(DiagnosticSchema),
  hash: z.string(),
});
const ProfileDraft = ProfileSnapshot.omit({ hash: true });
const CommitHash = z.string().regex(/^[0-9a-f]{4,64}$/i);
/** Only these files can be addressed; the renderer never sends free-form paths. */
const RulesPath = z.enum(RULES_AND_TEMPLATE_FILES);
const RulesSnapshot = z.object({
  path: RulesPath,
  content: z.string(),
  hash: z.string(),
  diagnostics: z.array(DiagnosticSchema),
});
const HistoryEntry = z.object({ hash: z.string(), date: z.string(), message: z.string() });
/** Renderer-supplied id that `tasks:cancel` refers to. */
const RequestId = z.uuid();
const JobId = z.string().min(1).max(64);
const AppId = z.string().min(1).max(64);
const IntakeResult = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), jobId: z.string(), duplicate: z.boolean() }),
  /** The page could not be read (login wall, JS-only, blocked): ask the user to paste the text. */
  z.object({ status: z.literal('needs_text'), reason: z.string() }),
]);
const Version = z.number().int().min(1);
/** A stored resume version; `pdfBase64` when it was compiled. */
const ResumeView = ResumeDocumentSchema.extend({ pdfBase64: z.string().optional() });
/** A stored cover letter version; `pdfBase64` when it was compiled. */
const CoverView = CoverDocumentSchema.extend({ pdfBase64: z.string().optional() });
const LatexStatus = z.object({
  engine: z.object({ kind: z.literal('tectonic'), path: z.string(), version: z.string() }).nullable(),
  cacheWarm: z.boolean().nullable(),
  installSupported: z.boolean(),
  /** OS sandbox for compiles; null = compiles are refused until bubblewrap works. Optional for older callers. */
  sandbox: z.literal('bwrap').nullable().optional(),
});

/**
 * Single source of truth for every renderer → main call.
 * Main validates `input` and `output` (trust boundary); the renderer client is typed from the same schemas.
 * Add a channel here, then register its handler in src/main/ipc/handlers.ts.
 */
export const ipcContract = {
  'app:getInfo': {
    input: z.undefined(),
    output: z.object({
      name: z.string(),
      version: z.string(),
      electron: z.string(),
      chrome: z.string(),
      node: z.string(),
      platform: z.string(),
      dataDir: z.string(),
      gitAvailable: z.boolean(),
    }),
  },
  'app:ping': {
    input: z.object({ message: z.string().max(200) }),
    output: z.object({ echo: z.string(), at: z.string() }),
  },
  'ai:status': {
    input: z.undefined(),
    output: z.object({
      installed: z.boolean(),
      version: z.string().optional(),
      loggedIn: z.boolean().optional(),
      error: z.string().optional(),
    }),
  },
  'profile:get': { input: z.undefined(), output: ProfileSnapshot },
  'profile:save': {
    input: z.object({
      markdown: z.string().max(2_000_000),
      /** Hash the editor started from; null skips the conflict check (e.g. accepting an import draft). */
      expectedHash: z.string().nullable(),
      message: z.string().max(200).optional(),
    }),
    output: ProfileSnapshot,
  },
  'profile:history': {
    input: z.object({ limit: z.number().int().min(1).max(500) }),
    output: z.array(z.object({ hash: z.string(), date: z.string(), message: z.string() })),
  },
  'profile:changes': { input: z.object({ hash: CommitHash }), output: z.object({ diff: z.string() }) },
  'profile:revert': { input: z.object({ hash: CommitHash }), output: ProfileSnapshot },
  /** Main shows the file picker itself; the renderer never sends file paths. */
  'profile:importFromFile': {
    input: z.undefined(),
    output: z.discriminatedUnion('status', [
      z.object({ status: z.literal('cancelled') }),
      z.object({ status: z.literal('draft'), draft: ProfileDraft, sourceName: z.string() }),
    ]),
  },
  /** The resume photo (templates/photo.jpg, D26) as a data URL for the Profile screen. */
  'photo:get': { input: z.undefined(), output: PhotoState },
  /** Main shows the file picker (PNG/JPEG), checks and re-encodes the image, stores and commits it. */
  'photo:choose': {
    input: z.undefined(),
    output: z.discriminatedUnion('status', [
      z.object({ status: z.literal('cancelled') }),
      z.object({ status: z.literal('saved'), photo: PhotoState }),
    ]),
  },
  'photo:clear': { input: z.undefined(), output: PhotoState },
  'rules:list': {
    input: z.undefined(),
    output: z.array(
      z.object({
        path: RulesPath,
        name: z.string(),
        kind: z.enum(['rules', 'template']),
        hash: z.string(),
        errors: z.number().int(),
        warnings: z.number().int(),
        /** Differs from the bundled default. */
        modified: z.boolean(),
      }),
    ),
  },
  'rules:get': { input: z.object({ path: RulesPath }), output: RulesSnapshot },
  'rules:save': {
    input: z.object({
      path: RulesPath,
      content: z.string().max(2_000_000),
      /** Hash the editor started from; null skips the conflict check. */
      expectedHash: z.string().nullable(),
      message: z.string().max(200).optional(),
    }),
    output: RulesSnapshot,
  },
  'rules:history': {
    input: z.object({ path: RulesPath, limit: z.number().int().min(1).max(500) }),
    output: z.array(HistoryEntry),
  },
  'rules:changes': {
    input: z.object({ path: RulesPath, hash: CommitHash }),
    output: z.object({ diff: z.string() }),
  },
  'rules:revert': { input: z.object({ path: RulesPath, hash: CommitHash }), output: RulesSnapshot },
  /** The renderer diffs the two strings itself (diffLines). */
  'rules:resetPreview': {
    input: z.object({ path: RulesPath }),
    output: z.object({ current: z.string(), seedDefault: z.string() }),
  },
  'rules:reset': {
    input: z.object({ path: RulesPath, expectedHash: z.string().nullable() }),
    output: RulesSnapshot,
  },
  'latex:status': { input: z.undefined(), output: LatexStatus },
  /** Downloads the pinned Tectonic build; progress arrives as `latex:installProgress` events. */
  'latex:install': { input: z.undefined(), output: LatexStatus },
  /** First compile downloads about 43 MB of TeX packages; can take about 2 minutes. */
  'latex:warmUp': { input: z.undefined(), output: LatexStatus },
  /** Compiles a template as-is with its sample content. `content` overrides the saved file (unsaved editor text). */
  'latex:compileTemplate': {
    input: z.object({ path: z.enum(TEMPLATE_FILES), content: z.string().max(2_000_000).optional() }),
    output: z.object({
      ok: z.boolean(),
      pages: z.number().int().nullable(),
      errors: z.array(z.object({ line: z.number().int().optional(), message: z.string() })),
      warnings: z.array(z.object({ kind: z.enum(['overfull', 'underfull', 'other']), message: z.string() })),
      /** True when the failure is the missing offline package cache: run latex:warmUp. */
      cacheMissing: z.boolean(),
      durationMs: z.number(),
      /** Omitted when the PDF is over 5 MB. */
      pdfBase64: z.string().optional(),
    }),
  },
  'settings:getAi': { input: z.undefined(), output: AiSettingsSchema },
  'settings:setAi': { input: AiSettingsSchema, output: AiSettingsSchema },
  'notifications:get': { input: z.undefined(), output: NotificationSettingsSchema },
  'notifications:set': { input: NotificationSettingsSchema, output: NotificationSettingsSchema },
  'updates:get': { input: z.undefined(), output: UpdateSettingsSchema },
  'updates:set': { input: UpdateSettingsSchema, output: UpdateSettingsSchema },
  /** May ask GitHub (at most daily, only when switched on). */
  'updates:status': { input: z.undefined(), output: UpdateStatusSchema },
  'updates:check': { input: z.undefined(), output: UpdateStatusSchema },
  /** Downloads, verifies and installs `version`; progress arrives as `updates:progress` events. */
  'updates:install': {
    input: z.object({ version: z.string().regex(/^\d+\.\d+\.\d+$/) }),
    output: UpdateStatusSchema,
  },
  'updates:cancel': { input: z.undefined(), output: z.object({ cancelled: z.boolean() }) },
  'updates:restart': { input: z.undefined(), output: z.object({ restarting: z.literal(true) }) },
  /** First-run Setup checklist memory (dismissed, completed, rules reviewed). */
  'setup:get': { input: z.undefined(), output: SetupStateSchema },
  'setup:set': { input: SetupPatchSchema, output: SetupStateSchema },
  /** `.stellio/backups`, newest first: database snapshots plus profile/rules copies. */
  'backups:list': { input: z.undefined(), output: z.array(BackupEntrySchema) },
  'backups:create': { input: z.undefined(), output: BackupEntrySchema },
  /**
   * Restores a database snapshot by file name (validated; the current database is snapshotted first).
   * The app restarts itself shortly after the reply.
   */
  'backups:restore': {
    input: z.object({ name: z.string().min(1).max(200) }),
    output: z.object({ snapshot: z.string(), restarting: z.literal(true) }),
  },
  'backups:openFolder': { input: z.undefined(), output: z.object({ path: z.string() }) },
  /**
   * Fetches and parses a posting link. A page that cannot be read comes back as `needs_text`; other failures
   * (network, Claude) are errors with a readable message.
   */
  'jobs:intakeUrl': {
    input: z.object({ url: z.string().max(2048), requestId: RequestId }),
    output: IntakeResult,
  },
  'jobs:intakeText': {
    input: z.object({
      text: z.string().max(200_000),
      url: z.string().max(2048).optional(),
      requestId: RequestId,
    }),
    output: IntakeResult,
  },
  'jobs:list': {
    input: z.object({
      limit: z.number().int().min(1).max(500),
      offset: z.number().int().min(0),
      state: z.enum(JOB_STATES).optional(),
    }),
    output: z.object({ items: z.array(JobSummarySchema), total: z.number().int() }),
  },
  /** The job and its latest full analysis. */
  'jobs:get': {
    input: z.object({ id: JobId }),
    output: z.object({ job: JobDetailSchema, analysis: AnalysisRecordSchema.nullable() }),
  },
  'jobs:analyze': {
    input: z.object({ id: JobId, requestId: RequestId }),
    output: z.object({ analysis: AnalysisRecordSchema }),
  },
  'jobs:delete': { input: z.object({ id: JobId }), output: z.object({ deleted: z.boolean() }) },
  'jobs:deleteMany': {
    input: z.object({ ids: z.array(JobId).min(1).max(10_000) }),
    output: z.object({ deleted: z.number().int() }),
  },
  'jobs:setState': {
    input: z.object({ id: JobId, state: z.enum(JOB_STATES) }),
    output: JobSummarySchema,
  },
  /** Activity list, newest first. */
  'ai:runs': {
    input: z.object({ limit: z.number().int().min(1).max(500) }),
    output: z.array(AiRunSchema),
  },
  /** One run plus its saved prompt/output; `log` is null once the file is pruned. */
  'ai:run': {
    input: z.object({ id: RunIdSchema }),
    output: z.object({ run: AiRunSchema, log: AiRunLogSchema.nullable() }),
  },
  /**
   * Drafts a resume (resume.generate) → truth/lint/ATS checks → sandboxed compile → one repair round if a check
   * blocks → stored as the next version. Stages arrive as `resume:progress` events. Cancellable by requestId.
   */
  'resume:generate': {
    input: z.object({ jobId: JobId, instruction: z.string().max(2000).optional(), requestId: RequestId }),
    output: ResumeView,
  },
  /** Applies an instruction to a drafted version (resume.revise); same checks; new version with parentVersion. */
  'resume:revise': {
    input: z.object({
      jobId: JobId,
      fromVersion: Version,
      instruction: z.string().trim().min(1).max(2000),
      requestId: RequestId,
    }),
    output: ResumeView,
  },
  /** German version of a drafted English version (resume.translate, D27); same checks plus the translation check. */
  'resume:translate': {
    input: z.object({ jobId: JobId, fromVersion: Version, requestId: RequestId }),
    output: ResumeView,
  },
  /** All versions, oldest first, with summary checks and staleness. */
  'resume:list': { input: z.object({ jobId: JobId }), output: z.array(ResumeVersionSummarySchema) },
  'resume:get': { input: z.object({ jobId: JobId, version: Version }), output: ResumeView },
  /** Hand-edited tex as a new version: lint + ATS re-run; truth check not applied (checks.truth = null). */
  'resume:saveManual': {
    input: z.object({ jobId: JobId, fromVersion: Version, tex: z.string().min(1).max(500_000) }),
    output: ResumeView,
  },
  'resume:compile': { input: z.object({ jobId: JobId, version: Version }), output: ResumeView },
  /** Makes this the only final version; returns the updated list. */
  'resume:markFinal': {
    input: z.object({ jobId: JobId, version: Version }),
    output: z.array(ResumeVersionSummarySchema),
  },
  /** Main shows the save dialog (Firstname_Lastname_Resume_<Company>.<ext>); the renderer never sends paths. */
  'resume:export': {
    input: z.object({ jobId: JobId, version: Version, format: z.enum(['tex', 'pdf']) }),
    output: z.discriminatedUnion('status', [
      z.object({ status: z.literal('saved'), path: z.string() }),
      z.object({ status: z.literal('cancelled') }),
    ]),
  },
  /** Sends this version to overleaf.com in the OS browser (explicit user action only). */
  'resume:openOverleaf': {
    input: z.object({ jobId: JobId, version: Version }),
    output: z.object({ url: z.string() }),
  },
  /** The two versions' tex; the renderer diffs them (diffLines). */
  'resume:diff': {
    input: z.object({ jobId: JobId, a: Version, b: Version }),
    output: z.object({ a: z.string(), b: z.string() }),
  },
  // --- C1 cover letter: the same flow as resume:*; no ATS check. Export name Firstname_Lastname_CoverLetter_<Company>.
  'cover:generate': {
    input: z.object({ jobId: JobId, instruction: z.string().max(2000).optional(), requestId: RequestId }),
    output: CoverView,
  },
  'cover:revise': {
    input: z.object({
      jobId: JobId,
      fromVersion: Version,
      instruction: z.string().trim().min(1).max(2000),
      requestId: RequestId,
    }),
    output: CoverView,
  },
  'cover:translate': {
    input: z.object({ jobId: JobId, fromVersion: Version, requestId: RequestId }),
    output: CoverView,
  },
  'cover:list': { input: z.object({ jobId: JobId }), output: z.array(CoverVersionSummarySchema) },
  'cover:get': { input: z.object({ jobId: JobId, version: Version }), output: CoverView },
  /** Hand-edited tex as a new version: lint re-runs; truth check not applied (checks.truth = null). */
  'cover:saveManual': {
    input: z.object({ jobId: JobId, fromVersion: Version, tex: z.string().min(1).max(500_000) }),
    output: CoverView,
  },
  'cover:compile': { input: z.object({ jobId: JobId, version: Version }), output: CoverView },
  'cover:markFinal': {
    input: z.object({ jobId: JobId, version: Version }),
    output: z.array(CoverVersionSummarySchema),
  },
  'cover:export': {
    input: z.object({ jobId: JobId, version: Version, format: z.enum(['tex', 'pdf']) }),
    output: z.discriminatedUnion('status', [
      z.object({ status: z.literal('saved'), path: z.string() }),
      z.object({ status: z.literal('cancelled') }),
    ]),
  },
  'cover:openOverleaf': {
    input: z.object({ jobId: JobId, version: Version }),
    output: z.object({ url: z.string() }),
  },
  'cover:diff': {
    input: z.object({ jobId: JobId, a: Version, b: Version }),
    output: z.object({ a: z.string(), b: z.string() }),
  },
  // --- end C1
  /** Aborts the in-flight task started with this requestId. */
  'tasks:cancel': { input: z.object({ requestId: RequestId }), output: z.object({ cancelled: z.boolean() }) },

  // ---- skills engine (docs/07, phase 6 S1) ----
  /**
   * The per-resume skill audit of a drafted version: code-decided rows plus AI wording (`skills.audit`, cached
   * per version; `refresh` asks again). `aiWarning` is set when the wording task failed; the rows are complete.
   */
  'skills:audit': {
    input: z.object({
      jobId: JobId,
      version: Version,
      requestId: RequestId,
      refresh: z.boolean().optional(),
    }),
    output: z.object({ rows: z.array(SkillAuditRowSchema), aiWarning: z.string().nullable() }),
  },
  /**
   * K / R / L / A. keep and remove store a new resume version (`newVersion`) with the audit of that version;
   * learn upserts a learning item; add_to_profile writes nothing and returns the diff preview: save it with
   * `profile:save` (expectedHash), then call `skills:recordApproval`.
   */
  'skills:decide': {
    input: z.object({
      jobId: JobId,
      version: Version,
      skill: z.string().trim().min(1).max(100),
      decision: z.enum(SKILL_DECIDE_ACTIONS),
      /** add_to_profile: the row the user filled in (level, years, evidence). Defaults to a bare "have" row. */
      profileRow: SkillRowSchema.extend({
        category: z.enum(SKILL_CATEGORIES),
        level: z.number().int().min(1).max(5).nullable(),
        status: z.enum(SKILL_STATUSES),
      }).optional(),
    }),
    output: z.object({
      audit: z.array(SkillAuditRowSchema),
      newVersion: z.number().int().optional(),
      profilePreview: ProfilePreviewSchema.optional(),
    }),
  },
  /** After the profile save for an add-to-profile preview succeeded: the skill is then allowed for this job. */
  'skills:recordApproval': {
    input: z.object({ jobId: JobId, skill: z.string().trim().min(1).max(100) }),
    output: z.object({ approved: z.array(z.string()) }),
  },
  /** Profile skills with 90-day demand and learning status. */
  'skills:ledger': { input: z.undefined(), output: z.array(LedgerRowSchema) },
  /** JD skills the profile does not have (as `have`), ranked by demand. */
  'skills:gaps': {
    input: z.object({ window: z.enum(DEMAND_WINDOWS).optional() }),
    output: z.array(GapRowSchema),
  },
  'learning:list': { input: z.undefined(), output: z.array(LearningItemSchema) },
  /** "Learn" on a gap (no job): a learning item from demand alone; an existing one is returned, a dropped one reopened. */
  'learning:add': {
    input: z.object({ skill: z.string().trim().min(1).max(100) }),
    output: LearningItemSchema,
  },
  'learning:update': {
    input: z.object({
      id: z.string().min(1).max(64),
      status: z.enum(LEARNING_STATUSES).optional(),
      priority: z.number().int().min(1).max(5).optional(),
      reason: z.string().max(500).nullable().optional(),
      targetLevel: z.number().int().min(1).max(5).nullable().optional(),
      estHours: z.number().int().min(0).max(2000).nullable().optional(),
      resourcesMd: z.string().max(5000).nullable().optional(),
    }),
    output: LearningItemSchema,
  },
  // --- P9 insights and learning (docs/07 §4-5, docs/08 §5)
  /** Response / interview rates per segment, median time to response, ghosting; computed in code. */
  'insights:summary': {
    input: z.object({ window: z.enum(INSIGHT_WINDOWS) }),
    output: InsightsSummarySchema,
  },
  /** Asks `insights.ask` about the aggregated tables only; every number in the answer is checked in code. Cancellable. */
  'insights:ask': {
    input: z.object({ question: z.string().trim().min(3).max(500), requestId: RequestId }),
    output: InsightsAnswerSchema,
  },
  /** Learning items ranked by `priority = demand x fit-uplift / hours`, with "unlocks N jobs". */
  'learning:roadmap': {
    input: z.undefined(),
    output: z.object({ items: z.array(RoadmapItemSchema), openJobs: z.number().int() }),
  },
  /** What-if: how many open stretch jobs would become apply with these 1-3 skills (code approximation). */
  'learning:whatIf': {
    input: z.object({ skills: z.array(z.string().trim().min(1).max(100)).min(1).max(3) }),
    output: WhatIfSchema,
  },
  /** On demand, per item: 2-3 suggested resources (official docs first), stored on the item. Cancellable. */
  'learning:resources': {
    input: z.object({ id: z.string().min(1).max(64), requestId: RequestId }),
    output: LearningItemSchema,
  },
  /** `profile.suggest`: proposed profile edits as a before/after preview. Never writes; save via `profile:save`. */
  'profile:suggest': { input: z.object({ requestId: RequestId }), output: ProfileSuggestionSchema },
  // --- end P9
  // --- T1 tracker (docs/08): applications, interviews, contacts, board/table/timeline, Today
  /** Starts an application for a job by hand (shortlisting and drafting do it automatically); returns the existing one. */
  'apps:create': { input: z.object({ jobId: JobId }), output: ApplicationSchema },
  'apps:forJob': { input: z.object({ jobId: JobId }), output: ApplicationSchema.nullable() },
  /**
   * Any status to any status. rejected / ghosted need `meta.stage`, not_applying `meta.reason`. `applied` freezes
   * the final resume (+ cover letter), JD, analysis and meta into `applications/<date>_<company>_<role>/` and
   * needs a final resume unless `meta.force` + `meta.forceReason`.
   */
  'apps:setStatus': { input: SetStatusInputSchema, output: ApplicationSchema },
  'apps:update': {
    input: z.object({
      id: AppId,
      patch: z.object({
        channel: z.enum(CHANNELS).nullable().optional(),
        priority: z.number().int().min(1).max(3).nullable().optional(),
        nextAction: z.string().max(300).nullable().optional(),
        nextActionAt: IsoWhen.nullable().optional(),
        salaryExpectation: z.string().max(200).nullable().optional(),
        notesMd: z.string().max(20_000).nullable().optional(),
      }),
    }),
    output: ApplicationSchema,
  },
  /** A note, or `follow_up` = "I followed up / sent the thank-you" (restarts the follow-up clock). */
  'apps:note': {
    input: z.object({
      id: AppId,
      text: z.string().trim().min(1).max(5000),
      kind: z.enum(['note', 'follow_up']).optional(),
    }),
    output: AppEventSchema,
  },
  'apps:interview:add': {
    input: z.object({
      applicationId: AppId,
      round: z.number().int().min(1).max(50).optional(),
      kind: z.enum(INTERVIEW_KINDS).optional(),
      scheduledAt: IsoWhen.nullable().optional(),
      outcome: z.enum(INTERVIEW_OUTCOMES).optional(),
      notesMd: z.string().max(20_000).nullable().optional(),
    }),
    output: InterviewSchema,
  },
  'apps:interview:update': {
    input: z.object({
      id: AppId,
      patch: z.object({
        round: z.number().int().min(1).max(50).optional(),
        kind: z.enum(INTERVIEW_KINDS).optional(),
        scheduledAt: IsoWhen.nullable().optional(),
        outcome: z.enum(INTERVIEW_OUTCOMES).optional(),
        notesMd: z.string().max(20_000).nullable().optional(),
      }),
    }),
    output: InterviewSchema,
  },
  'apps:interview:delete': { input: z.object({ id: AppId }), output: z.object({ deleted: z.boolean() }) },
  /** Creates a contact at the application's company and links it. */
  'apps:contact:add': {
    input: z.object({
      applicationId: AppId,
      name: z.string().trim().min(1).max(200),
      role: z.string().max(200).nullable().optional(),
      email: z.string().max(320).nullable().optional(),
      linkedinUrl: z.string().max(500).nullable().optional(),
      notesMd: z.string().max(20_000).nullable().optional(),
    }),
    output: ContactSchema,
  },
  'apps:contact:update': {
    input: z.object({
      id: AppId,
      patch: z.object({
        name: z.string().trim().min(1).max(200).optional(),
        role: z.string().max(200).nullable().optional(),
        email: z.string().max(320).nullable().optional(),
        linkedinUrl: z.string().max(500).nullable().optional(),
        notesMd: z.string().max(20_000).nullable().optional(),
      }),
    }),
    output: ContactSchema,
  },
  'apps:contact:delete': { input: z.object({ id: AppId }), output: z.object({ deleted: z.boolean() }) },
  'apps:contact:link': {
    input: z.object({ applicationId: AppId, contactId: AppId }),
    output: z.object({ linked: z.literal(true) }),
  },
  'apps:contact:unlink': {
    input: z.object({ applicationId: AppId, contactId: AppId }),
    output: z.object({ unlinked: z.boolean() }),
  },
  /** Linked contacts, and the company's other contacts that could be linked. */
  'apps:contact:list': {
    input: z.object({ applicationId: AppId }),
    output: z.object({ linked: z.array(ContactSchema), available: z.array(ContactSchema) }),
  },
  /** Opens the frozen application folder in the OS file manager; only paths inside the data folder. */
  'apps:openFolder': { input: z.object({ id: AppId }), output: z.object({ path: z.string() }) },
  'tracker:board': { input: z.undefined(), output: BoardSchema },
  'tracker:table': { input: TableInputSchema, output: z.object({ rows: z.array(TableRowSchema) }) },
  /** The table as CSV through a save dialog (the renderer never sends a path). */
  'tracker:exportCsv': {
    input: TableInputSchema,
    output: z.discriminatedUnion('status', [
      z.object({ status: z.literal('saved'), path: z.string(), rows: z.number().int() }),
      z.object({ status: z.literal('cancelled') }),
    ]),
  },
  'tracker:timeline': {
    input: z.object({ from: IsoWhen, to: IsoWhen }),
    output: z.object({ items: z.array(TimelineItemSchema) }),
  },
  'tracker:get': { input: z.object({ id: AppId }), output: TrackerGetSchema },
  'today:summary': { input: z.undefined(), output: TodaySummarySchema },
  // --- end T1

  // --- D1 discovery
  /** Every source with its switch, key state and last success/error. Keys themselves never leave the main process. */
  'discovery:sources': { input: z.undefined(), output: z.array(SourceStatusSchema) },
  'discovery:setSourceEnabled': {
    input: z.object({ id: SourceIdSchema, enabled: z.boolean() }),
    output: z.array(SourceStatusSchema),
  },
  /** Stores the Adzuna key encrypted with the OS keyring; the answer only says it is set. */
  'discovery:setApiKey': {
    input: z.object({ id: z.literal('adzuna'), appId: z.string().max(100), appKey: z.string().max(200) }),
    output: z.object({ keySet: z.boolean() }),
  },
  'discovery:clearApiKey': {
    input: z.object({ id: z.literal('adzuna') }),
    output: z.object({ keySet: z.boolean() }),
  },
  'discovery:profiles': { input: z.undefined(), output: z.array(SearchProfileSchema) },
  /** Creates a search profile, or updates the one with `id`. */
  'discovery:saveProfile': {
    input: z.object({ id: z.string().min(1).max(64).optional(), profile: SearchProfileInputSchema }),
    output: SearchProfileSchema,
  },
  'discovery:deleteProfile': {
    input: z.object({ id: z.string().min(1).max(64) }),
    output: z.object({ deleted: z.boolean() }),
  },
  'discovery:watchlist': { input: z.undefined(), output: z.array(WatchEntrySchema) },
  /** Adds a company by careers URL (ATS found from the URL or the page's links). */
  'discovery:watchAdd': {
    input: z.object({
      url: z.string().max(2048),
      name: z.string().trim().max(200).optional(),
      requestId: RequestId,
    }),
    output: WatchEntrySchema,
  },
  'discovery:watchRemove': {
    input: z.object({ id: z.string().min(1).max(64) }),
    output: z.object({ removed: z.boolean() }),
  },
  /** Runs a scan now. Progress arrives as `discovery:progress` events; cancellable by requestId. */
  'discovery:scanNow': { input: z.object({ requestId: RequestId }), output: ScanOutcomeSchema },
  'discovery:scanRuns': {
    input: z.object({ limit: z.number().int().min(1).max(100).default(20) }),
    output: z.array(ScanRunSchema),
  },
  'discovery:schedule': { input: z.undefined(), output: ScheduleSchema },
  'discovery:setSchedule': { input: ScheduleSchema, output: ScheduleSchema },
  'discovery:settings': { input: z.undefined(), output: DiscoverySettingsSchema },
  'discovery:setSettings': { input: DiscoverySettingsSchema, output: DiscoverySettingsSchema },
  /** The exact systemd unit files Stellio would write. */
  'discovery:timerPreview': { input: z.undefined(), output: TimerPreviewSchema },
  'discovery:timerInstall': { input: z.undefined(), output: TimerStatusSchema },
  'discovery:timerRemove': { input: z.undefined(), output: TimerStatusSchema },
  'discovery:timerStatus': { input: z.undefined(), output: TimerStatusSchema },
  /** New jobs, ranked (docs/05 §2), with triage score and reason. */
  'jobs:inbox': { input: InboxInputSchema, output: z.array(InboxItemSchema) },
  /** How many open jobs each Re-score choice covers; `sideJob` picks the Career or Side jobs list. */
  'jobs:rescoreCounts': {
    input: z.object({ sideJob: z.boolean().optional() }),
    output: z.object({ unscored: z.number(), all: z.number(), stale: z.number() }),
  },
  /** Triages again: the open jobs of `scope`, or the one job. Progress arrives as `jobs:rescoreProgress`. */
  'jobs:rescore': {
    input: z
      .object({
        scope: z.enum(['unscored', 'all', 'stale', 'job']),
        jobId: JobId.optional(),
        sideJob: z.boolean().optional(),
        requestId: RequestId,
      })
      .refine((v) => v.scope !== 'job' || v.jobId !== undefined, { message: 'jobId is required' }),
    output: z.object({ total: z.number(), scored: z.number(), error: z.string().nullable() }),
  },
  'jobs:dismiss': {
    input: z.object({ id: JobId, reason: z.string().trim().max(200).default('') }),
    output: z.object({ dismissed: z.boolean() }),
  },
  /** Shortlists the job: it becomes an application in `saved`. */
  'jobs:shortlist': { input: z.object({ id: JobId }), output: z.object({ applicationId: z.string() }) },
  // --- end D1

  // --- R1 referrals (docs/14). Nothing here sends a message or logs into anything: Stellio only drafts.
  /** Searches public pages for people at the company; stores the validated, ranked result. Cancellable by requestId. */
  'referrals:search': {
    input: z.object({
      jobId: JobId.optional(),
      company: z.string().trim().min(1).max(200),
      role: z.string().trim().min(1).max(200),
      location: z.string().trim().max(200).default(''),
      hints: SearchHintsSchema.default({}),
      exclude: SearchExcludeSchema.optional(),
      requestId: RequestId,
    }),
    output: SearchOutcomeSchema,
  },
  /** Requests with their person, best score first; for one job, or all. */
  /** Contacted requests whose follow-up is due now. */
  'referrals:due': { input: z.undefined(), output: z.array(ReferralItemSchema) },
  'referrals:list': { input: z.object({ jobId: JobId.optional() }), output: z.array(ReferralItemSchema) },
  'referrals:person': {
    input: z.object({ id: z.string().min(1).max(64) }),
    output: z.object({ person: PersonSchema, requests: z.array(ReferralRequestSchema) }),
  },
  /** Drafts the connection note and message for one person and job (lint and truth checked, one repair round). */
  'referrals:draft': {
    input: z.object({ personId: z.string().min(1).max(64), jobId: JobId, requestId: RequestId }),
    output: ReferralItemSchema,
  },
  /** Outreach status; the change lands on the job's application timeline. */
  'referrals:setStatus': {
    input: z.object({
      id: z.string().min(1).max(64),
      status: ReferralStatusSchema,
      note: z.string().trim().max(2000).optional(),
    }),
    output: ReferralItemSchema,
  },
  'referrals:delete': {
    input: z.object({ personId: z.string().min(1).max(64) }),
    output: z.object({ deleted: z.boolean() }),
  },
  'referrals:deleteMany': {
    input: z.object({ personIds: z.array(z.string().min(1).max(64)).min(1).max(10_000) }),
    output: z.object({ deleted: z.number().int() }),
  },
  'referrals:deleteAll': { input: z.undefined(), output: z.object({ deleted: z.number().int() }) },
  'referrals:settings': { input: z.undefined(), output: ReferralSettingsSchema },
  'referrals:setSettings': { input: ReferralSettingsSchema, output: ReferralSettingsSchema },
  // --- end R1
} as const;

export type IpcChannel = keyof typeof ipcContract;
export type IpcInput<C extends IpcChannel> = z.input<(typeof ipcContract)[C]['input']>;
export type IpcOutput<C extends IpcChannel> = z.output<(typeof ipcContract)[C]['output']>;

export const ipcChannels = Object.keys(ipcContract) as IpcChannel[];

export function isIpcChannel(value: unknown): value is IpcChannel {
  return typeof value === 'string' && Object.hasOwn(ipcContract, value);
}

/** `failed` = expected failure whose message is safe to show (thrown as UserError); `internal` = bug, details only in the log. */
export type IpcErrorCode = 'invalid_input' | 'unknown_channel' | 'forbidden' | 'failed' | 'internal';
export type IpcResult<T> =
  { ok: true; data: T } | { ok: false; error: { code: IpcErrorCode; message: string } };

/** main → renderer push events. */
export interface IpcEvents {
  /** A watched file in the data folder changed outside the app (relative posix path). */
  'datafolder:changed': { relPath: string };
  /** Progress of `latex:install`. `total` is null when the server sent no length. */
  'latex:installProgress': {
    phase: 'download' | 'verify' | 'extract' | 'done';
    received: number;
    total: number | null;
  };
  /** Progress of `updates:install`. */
  'updates:progress': UpdateProgress;
  /** A Claude run failed because the subscription's usage limit is reached. `message` is the CLI's text. */
  'ai:usageLimit': { message: string; resetsAt?: string };
  /** Stage of a running `resume:generate` / `resume:revise`; `issues` = blocking issues being fixed. */
  'resume:progress': {
    jobId: string;
    requestId: string;
    stage: (typeof RESUME_STAGES)[number];
    issues?: number;
  };
  // --- C1 cover letter
  /** Stage of a running `cover:generate` / `cover:revise`; same stages as `resume:progress`. */
  'cover:progress': {
    jobId: string;
    requestId: string;
    stage: (typeof RESUME_STAGES)[number];
    issues?: number;
  };
  // --- end C1
  // --- D1 discovery
  /** A running scan: how far one source got (`new` = jobs added so far). */
  'discovery:progress': { requestId: string; source: string; fetched: number; new: number };
  /** A running `jobs:rescore`: triage batches done of all. */
  'jobs:rescoreProgress': { requestId: string; done: number; total: number };
  // --- end D1
  // --- R1 referrals
  /** Stage of a running `referrals:search`. */
  'referrals:progress': { requestId: string; stage: 'searching' | 'validating' | 'saving'; count?: number };
  // --- end R1
}
export type IpcEventName = keyof IpcEvents;
