import {
  type AnySQLiteColumn,
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { ulid } from 'ulid';

const now = () => new Date().toISOString();

/** id (ULID) + ISO-8601 timestamps shared by every entity table. */
const base = {
  id: text()
    .primaryKey()
    .$defaultFn(() => ulid()),
  createdAt: text('created_at').notNull().$defaultFn(now),
  updatedAt: text('updated_at').notNull().$defaultFn(now).$onUpdateFn(now),
};
const bool = (name: string) => integer(name, { mode: 'boolean' });
const json = <T>(name: string) => text(name, { mode: 'json' }).$type<T>();

export const ATS_TYPES = ['greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workable', 'other'] as const;
export const REMOTE_KINDS = ['onsite', 'hybrid', 'remote', 'unknown'] as const;
export const JOB_STATES = ['new', 'shortlisted', 'dismissed', 'archived'] as const;
export const JOB_SOURCES = [
  'adzuna',
  'arbeitnow',
  'ba',
  'remotive',
  'remoteok',
  'himalayas',
  'greenhouse',
  'lever',
  'ashby',
  'smartrecruiters',
  'workable',
  'websearch',
  'manual',
] as const;
export const APPLICATION_STATUSES = [
  'saved',
  'preparing',
  'ready',
  'applied',
  'acknowledged',
  'screening',
  'interviewing',
  'assessment',
  'offer',
  'waiting',
  'accepted',
  'declined',
  'rejected',
  'withdrawn',
  'ghosted',
  'not_applying',
] as const;
export const APPLICATION_CHANNELS = ['company_site', 'platform', 'referral', 'email', 'recruiter'] as const;
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
export const INTERVIEW_KINDS = ['screen', 'technical', 'onsite', 'hr', 'final', 'other'] as const;
export const INTERVIEW_OUTCOMES = ['pending', 'passed', 'failed', 'cancelled'] as const;
export const DOCUMENT_KINDS = ['resume', 'cover_letter'] as const;
export const SKILL_ORIGINS = ['profile_have', 'profile_learning', 'jd_only', 'unlisted_confirmed'] as const;
export const JD_IMPORTANCE = ['required', 'preferred', 'mentioned', 'absent'] as const;
export const SKILL_RECOMMENDATIONS = ['keep', 'remove', 'learn', 'add_to_profile'] as const;
export const SKILL_DECISIONS = ['pending', 'kept', 'removed', 'learning', 'added'] as const;
export const DEMAND_WINDOWS = ['30d', '90d', 'all'] as const;
export const LEARNING_STATUSES = ['todo', 'doing', 'done', 'dropped'] as const;
export const SCAN_TRIGGERS = ['schedule', 'manual', 'startup_catchup'] as const;
export const SCAN_STATUSES = ['running', 'ok', 'partial', 'error'] as const;
/** `running` is the state between insert and finish; the data model doc lists only terminal states. */
export const AI_RUN_STATUSES = [
  'running',
  'ok',
  'error',
  'timeout',
  'cancelled',
  'invalid_output',
  'auth',
  'usage_limit',
  'bad_model',
] as const;

export const companies = sqliteTable('companies', {
  ...base,
  name: text().notNull(),
  domain: text(),
  careersUrl: text('careers_url'),
  atsType: text('ats_type', { enum: ATS_TYPES }),
  atsSlug: text('ats_slug'),
  watch: bool('watch').notNull().default(false),
  notes: text(),
});

export const jobs = sqliteTable(
  'jobs',
  {
    ...base,
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id),
    title: text().notNull(),
    locationText: text('location_text'),
    country: text(),
    remote: text({ enum: REMOTE_KINDS }).notNull().default('unknown'),
    employmentType: text('employment_type'),
    seniority: text(),
    salaryMin: integer('salary_min'),
    salaryMax: integer('salary_max'),
    salaryCurrency: text('salary_currency'),
    salaryPeriod: text('salary_period'),
    language: text(),
    url: text(),
    applyUrl: text('apply_url'),
    postedAt: text('posted_at'),
    deadlineAt: text('deadline_at'),
    descriptionMd: text('description_md').notNull().default(''),
    descriptionHash: text('description_hash'),
    /** Set when Fetch / Paste full text replaced the posting text. */
    descriptionUpdatedAt: text('description_updated_at'),
    structuredJson: json<unknown>('structured_json'),
    firstSeenAt: text('first_seen_at').notNull().$defaultFn(now),
    lastSeenAt: text('last_seen_at').notNull().$defaultFn(now),
    closedAt: text('closed_at'),
    dedupeKey: text('dedupe_key').notNull(),
    state: text({ enum: JOB_STATES }).notNull().default('new'),
    dismissReason: text('dismiss_reason'),
    /** Found only by side-job search profiles: triaged on pay and hours, never auto-analyzed. */
    sideJob: bool('side_job').notNull().default(false),
  },
  (t) => [uniqueIndex('jobs_dedupe_key_uq').on(t.dedupeKey), index('jobs_state_idx').on(t.state)],
);

export const jobSources = sqliteTable(
  'job_sources',
  {
    ...base,
    jobId: text('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    source: text({ enum: JOB_SOURCES }).notNull(),
    externalId: text('external_id').notNull(),
    url: text(),
    rawJson: json<unknown>('raw_json'),
    fetchedAt: text('fetched_at').notNull().$defaultFn(now),
  },
  (t) => [uniqueIndex('job_sources_source_external_id_uq').on(t.source, t.externalId)],
);

export const analyses = sqliteTable(
  'analyses',
  {
    ...base,
    jobId: text('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    profileHash: text('profile_hash').notNull(),
    model: text().notNull(),
    promptVersion: text('prompt_version').notNull(),
    fitScore: integer('fit_score'),
    verdict: text({ enum: ['apply', 'stretch', 'skip'] }),
    summary: text(),
    resultJson: json<unknown>('result_json'),
    triage: bool('triage').notNull().default(false),
  },
  (t) => [index('analyses_job_triage_idx').on(t.jobId, t.triage, t.createdAt, t.id)],
);

/** Side-job checks (the Fit tab of a side job). `result_json` is a `SideFitResult`. */
export const sideFits = sqliteTable(
  'side_fits',
  {
    ...base,
    jobId: text('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    profileHash: text('profile_hash').notNull(),
    model: text().notNull(),
    promptVersion: text('prompt_version').notNull(),
    score: integer().notNull(),
    verdict: text({ enum: ['take', 'maybe', 'skip'] }).notNull(),
    summary: text().notNull(),
    resultJson: json<unknown>('result_json').notNull(),
  },
  (t) => [index('side_fits_job_idx').on(t.jobId, t.createdAt, t.id)],
);

export const applications = sqliteTable('applications', {
  ...base,
  jobId: text('job_id')
    .notNull()
    .references(() => jobs.id)
    .unique(),
  status: text({ enum: APPLICATION_STATUSES }).notNull().default('saved'),
  statusChangedAt: text('status_changed_at').notNull().$defaultFn(now),
  appliedAt: text('applied_at'),
  channel: text({ enum: APPLICATION_CHANNELS }),
  priority: integer(),
  nextAction: text('next_action'),
  nextActionAt: text('next_action_at'),
  folderPath: text('folder_path'),
  // documents.application_id points back here, hence the explicit column type (circular reference).
  resumeDocId: text('resume_doc_id').references((): AnySQLiteColumn => documents.id, {
    onDelete: 'set null',
  }),
  coverDocId: text('cover_doc_id').references((): AnySQLiteColumn => documents.id, { onDelete: 'set null' }),
  salaryExpectation: text('salary_expectation'),
  notesMd: text('notes_md'),
});

export const documents = sqliteTable('documents', {
  ...base,
  applicationId: text('application_id').references(() => applications.id, { onDelete: 'set null' }),
  jobId: text('job_id')
    .notNull()
    .references(() => jobs.id, { onDelete: 'cascade' }),
  kind: text({ enum: DOCUMENT_KINDS }).notNull(),
  version: integer().notNull(),
  tex: text().notNull(),
  pdfPath: text('pdf_path'),
  profileHash: text('profile_hash'),
  rulesHash: text('rules_hash'),
  templateHash: text('template_hash'),
  model: text(),
  promptVersion: text('prompt_version'),
  truthReportJson: json<unknown>('truth_report_json'),
  atsReportJson: json<unknown>('ats_report_json'),
  userEdited: bool('user_edited').notNull().default(false),
  isFinal: bool('is_final').notNull().default(false),
});

export const applicationEvents = sqliteTable(
  'application_events',
  {
    ...base,
    applicationId: text('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    type: text({ enum: EVENT_TYPES }).notNull(),
    fromStatus: text('from_status', { enum: APPLICATION_STATUSES }),
    toStatus: text('to_status', { enum: APPLICATION_STATUSES }),
    at: text().notNull().$defaultFn(now),
    payloadJson: json<unknown>('payload_json'),
  },
  (t) => [index('application_events_application_id_at_idx').on(t.applicationId, t.at)],
);

export const interviews = sqliteTable('interviews', {
  ...base,
  applicationId: text('application_id')
    .notNull()
    .references(() => applications.id, { onDelete: 'cascade' }),
  round: integer().notNull().default(1),
  kind: text({ enum: INTERVIEW_KINDS }).notNull().default('other'),
  scheduledAt: text('scheduled_at'),
  outcome: text({ enum: INTERVIEW_OUTCOMES }).notNull().default('pending'),
  notesMd: text('notes_md'),
});

export const contacts = sqliteTable('contacts', {
  ...base,
  companyId: text('company_id').references(() => companies.id, { onDelete: 'set null' }),
  name: text().notNull(),
  role: text(),
  email: text(),
  linkedinUrl: text('linkedin_url'),
  notesMd: text('notes_md'),
});

export const applicationContacts = sqliteTable(
  'application_contacts',
  {
    ...base,
    applicationId: text('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    contactId: text('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
  },
  (t) => [uniqueIndex('application_contacts_uq').on(t.applicationId, t.contactId)],
);

export const skillAudits = sqliteTable('skill_audits', {
  ...base,
  documentId: text('document_id')
    .notNull()
    .references(() => documents.id, { onDelete: 'cascade' }),
  skill: text().notNull(),
  origin: text({ enum: SKILL_ORIGINS }).notNull(),
  jdImportance: text('jd_importance', { enum: JD_IMPORTANCE }).notNull(),
  evidenceIds: json<string[]>('evidence_ids'),
  recommendation: text({ enum: SKILL_RECOMMENDATIONS }).notNull(),
  decision: text({ enum: SKILL_DECISIONS }).notNull().default('pending'),
  decidedAt: text('decided_at'),
  rationale: text(),
});

export const skillDemand = sqliteTable('skill_demand', {
  ...base,
  skill: text().notNull(),
  window: text({ enum: DEMAND_WINDOWS }).notNull(),
  jobCount: integer('job_count').notNull(),
  share: real().notNull(),
  requiredShare: real('required_share').notNull(),
  computedAt: text('computed_at').notNull(),
});

export const learningItems = sqliteTable('learning_items', {
  ...base,
  skill: text().notNull(),
  priority: integer().notNull().default(3),
  reason: text(),
  targetLevel: integer('target_level'),
  estHours: integer('est_hours'),
  status: text({ enum: LEARNING_STATUSES }).notNull().default('todo'),
  resourcesMd: text('resources_md'),
  linkedJobs: integer('linked_jobs').notNull().default(0),
  completedAt: text('completed_at'),
});

export const searchProfiles = sqliteTable('search_profiles', {
  ...base,
  name: text().notNull(),
  roles: json<string[]>('roles').notNull().default([]),
  keywords: json<string[]>('keywords').notNull().default([]),
  excludeKeywords: json<string[]>('exclude_keywords').notNull().default([]),
  locations: json<string[]>('locations').notNull().default([]),
  remoteOk: bool('remote_ok').notNull().default(true),
  countries: json<string[]>('countries').notNull().default([]),
  seniority: json<string[]>('seniority').notNull().default([]),
  salaryFloor: integer('salary_floor'),
  currency: text(),
  languages: json<string[]>('languages').notNull().default([]),
  excludedCompanies: json<string[]>('excluded_companies').notNull().default([]),
  enabled: bool('enabled').notNull().default(true),
  kind: text({ enum: ['career', 'side'] })
    .notNull()
    .default('career'),
  maxHoursPerWeek: integer('max_hours_per_week'),
  minHourlyPay: real('min_hourly_pay'),
});

export const scanRuns = sqliteTable('scan_runs', {
  ...base,
  startedAt: text('started_at').notNull().$defaultFn(now),
  finishedAt: text('finished_at'),
  trigger: text({ enum: SCAN_TRIGGERS }).notNull(),
  status: text({ enum: SCAN_STATUSES }).notNull().default('running'),
  perSourceJson:
    json<
      Record<string, { fetched: number; new: number; errors: string[]; filtered?: number; merged?: number }>
    >('per_source_json'),
  newJobs: integer('new_jobs').notNull().default(0),
  error: text(),
});

export const REFERRAL_STATUSES = [
  'not_contacted',
  'contacted',
  'replied',
  'referred',
  'declined',
  'no_response',
] as const;

/** Public people found for referrals (docs/14 §4). Only public facts with their sources; no phone numbers. */
export const people = sqliteTable(
  'people',
  {
    ...base,
    fullName: text('full_name').notNull(),
    title: text().notNull().default(''),
    companyId: text('company_id').references(() => companies.id, { onDelete: 'set null' }),
    locationText: text('location_text').notNull().default(''),
    country: text(),
    profileUrlsJson: json<{ url: string; kind: string }[]>('profile_urls_json').notNull().default([]),
    publicContactJson: json<{ kind: string; value: string; source_url: string }[]>('public_contact_json')
      .notNull()
      .default([]),
    sourcesJson: json<{ url: string; seen_at: string; facts: string[] }[]>('sources_json')
      .notNull()
      .default([]),
    sharedGroundJson: json<string[]>('shared_ground_json').notNull().default([]),
    /** Normalised name + company: the same person found twice is one row. */
    dedupeKey: text('dedupe_key').notNull(),
    firstSeenAt: text('first_seen_at').notNull().$defaultFn(now),
    lastSeenAt: text('last_seen_at').notNull().$defaultFn(now),
    /** Never-contacted people are deleted after this; null once you contacted them. */
    purgeAfter: text('purge_after'),
  },
  (t) => [
    uniqueIndex('people_dedupe_key_uq').on(t.dedupeKey),
    index('people_purge_after_idx').on(t.purgeAfter),
  ],
);

export const referralRequests = sqliteTable(
  'referral_requests',
  {
    ...base,
    personId: text('person_id')
      .notNull()
      .references(() => people.id, { onDelete: 'cascade' }),
    jobId: text('job_id').references(() => jobs.id, { onDelete: 'cascade' }),
    applicationId: text('application_id').references(() => applications.id, { onDelete: 'set null' }),
    status: text({ enum: REFERRAL_STATUSES }).notNull().default('not_contacted'),
    why: text().notNull().default(''),
    score: integer().notNull().default(0),
    noteText: text('note_text'),
    messageSubject: text('message_subject'),
    messageBody: text('message_body'),
    language: text(),
    checksJson: json<unknown>('checks_json'),
    rulesHash: text('rules_hash'),
    model: text(),
    promptVersion: text('prompt_version'),
    contactedAt: text('contacted_at'),
    nextActionAt: text('next_action_at'),
    notesMd: text('notes_md'),
  },
  (t) => [
    index('referral_requests_job_id_idx').on(t.jobId),
    index('referral_requests_person_id_idx').on(t.personId),
  ],
);

export const aiRuns = sqliteTable(
  'ai_runs',
  {
    ...base,
    task: text().notNull(),
    model: text().notNull(),
    promptVersion: text('prompt_version').notNull(),
    inputHash: text('input_hash'),
    startedAt: text('started_at').notNull().$defaultFn(now),
    durationMs: integer('duration_ms'),
    status: text({ enum: AI_RUN_STATUSES }).notNull().default('running'),
    exitCode: integer('exit_code'),
    tokensJson: json<{ input?: number; output?: number }>('tokens_json'),
    error: text(),
    relatedType: text('related_type'),
    relatedId: text('related_id'),
  },
  (t) => [index('ai_runs_started_at_idx').on(t.startedAt)],
);

/** Non-secret runtime state, keyed by `key` (no ULID id, no created_at). */
export const settingsKv = sqliteTable('settings_kv', {
  key: text().primaryKey(),
  valueJson: json<unknown>('value_json').notNull(),
  updatedAt: text('updated_at').notNull().$defaultFn(now).$onUpdateFn(now),
});
