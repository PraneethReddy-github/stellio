import { z } from 'zod';
import { EMPLOYMENT_TYPES, REMOTE_KINDS, SALARY_PERIODS, SENIORITY } from '../jobs/schemas';

/** Sources the user can switch on and off. `watchlist` = every ATS board of a watched company. */
export const DISCOVERY_SOURCES = [
  'adzuna',
  'arbeitnow',
  'ba',
  'remotive',
  'remoteok',
  'himalayas',
  'watchlist',
  'websearch',
] as const;
export type DiscoverySource = (typeof DISCOVERY_SOURCES)[number];
export const SourceIdSchema = z.enum(DISCOVERY_SOURCES);

const List = z.array(z.string().trim().min(1).max(100)).max(50);

export const SearchProfileInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  roles: List,
  keywords: List,
  excludeKeywords: List,
  locations: List,
  remoteOk: z.boolean(),
  countries: List,
  seniority: z.array(z.enum(SENIORITY)),
  salaryFloor: z.number().int().min(0).nullable(),
  currency: z.string().trim().max(8).nullable(),
  languages: List,
  excludedCompanies: List,
  enabled: z.boolean(),
});
export type SearchProfileInput = z.infer<typeof SearchProfileInputSchema>;
export const SearchProfileSchema = SearchProfileInputSchema.extend({ id: z.string() });
export type SearchProfile = z.infer<typeof SearchProfileSchema>;

/** What an adapter hands to the pipeline after zod validation. */
export const NormalizedJobSchema = z.object({
  source: z.string(),
  externalId: z.string().min(1).max(300),
  url: z.string().nullable(),
  applyUrl: z.string().nullable(),
  title: z.string().min(1).max(300),
  company: z.string().min(1).max(200),
  locationText: z.string().nullable(),
  city: z.string().nullable(),
  country: z.string().nullable(),
  remote: z.enum(REMOTE_KINDS),
  employmentType: z.enum(EMPLOYMENT_TYPES).nullable(),
  seniority: z.enum(SENIORITY).nullable(),
  salaryMin: z.number().nullable(),
  salaryMax: z.number().nullable(),
  salaryCurrency: z.string().nullable(),
  salaryPeriod: z.enum(SALARY_PERIODS).nullable(),
  postedAt: z.string().nullable(),
  descriptionMd: z.string(),
  /** Extra search text (tags, categories) for the relevance check. */
  tags: z.array(z.string()),
});
export type NormalizedJob = z.infer<typeof NormalizedJobSchema>;

export const RANK_WEIGHTS = { fit: 0.6, recency: 0.15, source: 0.15, salary: 0.1 } as const;

export const DiscoverySettingsSchema = z.object({
  /** Triage score from which a job gets the full analysis. */
  analyzeThreshold: z.number().int().min(0).max(100),
  maxAnalyzePerDay: z.number().int().min(0).max(100),
  /** `jd.parse` calls per scan. */
  maxParsePerScan: z.number().int().min(0).max(200),
  maxAgeDays: z.number().int().min(1).max(365),
  weights: z.object({
    fit: z.number().min(0).max(1),
    recency: z.number().min(0).max(1),
    source: z.number().min(0).max(1),
    salary: z.number().min(0).max(1),
  }),
});
export type DiscoverySettings = z.infer<typeof DiscoverySettingsSchema>;
export const DEFAULT_DISCOVERY_SETTINGS: DiscoverySettings = {
  analyzeThreshold: 70,
  maxAnalyzePerDay: 15,
  maxParsePerScan: 40,
  maxAgeDays: 30,
  weights: { ...RANK_WEIGHTS },
};

export const ScheduleSchema = z.object({
  enabled: z.boolean(),
  /** Local time, `HH:MM`. */
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
});
export type Schedule = z.infer<typeof ScheduleSchema>;
/** Off until the user turns it on: a first launch must not start spending Claude usage by itself. */
export const DEFAULT_SCHEDULE: Schedule = { enabled: false, time: '08:00' };

export const SourceStatusSchema = z.object({
  id: SourceIdSchema,
  label: z.string(),
  needsKey: z.boolean(),
  keySet: z.boolean(),
  enabled: z.boolean(),
  lastRunAt: z.string().nullable(),
  lastSuccessAt: z.string().nullable(),
  lastError: z.string().nullable(),
});
export type SourceStatus = z.infer<typeof SourceStatusSchema>;

export const WatchEntrySchema = z.object({
  id: z.string(),
  company: z.string(),
  careersUrl: z.string().nullable(),
  atsType: z.string().nullable(),
  atsSlug: z.string().nullable(),
});
export type WatchEntry = z.infer<typeof WatchEntrySchema>;

export const ScanRunSchema = z.object({
  id: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  trigger: z.string(),
  status: z.string(),
  newJobs: z.number().int(),
  perSource: z.record(
    z.string(),
    z.object({
      fetched: z.number(),
      new: z.number(),
      errors: z.array(z.string()),
      filtered: z.number().optional(),
      merged: z.number().optional(),
    }),
  ),
  error: z.string().nullable(),
});
export type ScanRun = z.infer<typeof ScanRunSchema>;

export const ScanOutcomeSchema = z.object({
  run: ScanRunSchema,
  /** New jobs whose triage score reached the analysis threshold. */
  strong: z.number().int(),
});
export type ScanOutcome = z.infer<typeof ScanOutcomeSchema>;

export const InboxInputSchema = z.object({
  filters: z
    .object({
      minScore: z.number().min(0).max(100).optional(),
      source: z.string().max(40).optional(),
      remote: z.enum(REMOTE_KINDS).optional(),
      text: z.string().max(100).optional(),
    })
    .default({}),
  sort: z.enum(['rank', 'recent', 'score']).default('rank'),
  limit: z.number().int().min(1).max(500).default(100),
});
export type InboxInput = z.infer<typeof InboxInputSchema>;

export const InboxItemSchema = z.object({
  jobId: z.string(),
  company: z.string(),
  title: z.string(),
  locationText: z.string().nullable(),
  remote: z.enum(REMOTE_KINDS),
  salaryText: z.string().nullable(),
  url: z.string().nullable(),
  postedAt: z.string().nullable(),
  firstSeenAt: z.string(),
  /** Full-analysis fit when present, else the triage score. */
  score: z.number().nullable(),
  scoreKind: z.enum(['fit', 'triage']).nullable(),
  reason: z.string().nullable(),
  rank: z.number(),
  sources: z.array(z.string()),
});
export type InboxItem = z.infer<typeof InboxItemSchema>;

export const TimerStatusSchema = z.object({
  installed: z.boolean(),
  enabled: z.boolean(),
  active: z.boolean(),
  /** `systemctl` could not be run (no systemd user session). */
  unavailable: z.boolean(),
  time: z.string().nullable(),
  nextRun: z.string().nullable(),
});
export type TimerStatus = z.infer<typeof TimerStatusSchema>;
export const TimerPreviewSchema = z.object({
  service: z.object({ path: z.string(), content: z.string() }),
  timer: z.object({ path: z.string(), content: z.string() }),
});
export type TimerPreview = z.infer<typeof TimerPreviewSchema>;
