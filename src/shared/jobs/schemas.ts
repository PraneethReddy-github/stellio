import { z } from 'zod';

/** Mirror of the enums in src/main/db/schema.ts (a unit test keeps them equal). */
export const REMOTE_KINDS = ['onsite', 'hybrid', 'remote', 'unknown'] as const;
export const JOB_STATES = ['new', 'shortlisted', 'dismissed', 'archived'] as const;

export const SENIORITY = [
  'intern',
  'junior',
  'mid',
  'senior',
  'staff',
  'lead',
  'manager',
  'director',
  'executive',
] as const;
export const EMPLOYMENT_TYPES = [
  'full_time',
  'part_time',
  'contract',
  'internship',
  'temporary',
  'freelance',
] as const;
export const SALARY_PERIODS = ['year', 'month', 'week', 'day', 'hour'] as const;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Output of the `jd.parse` task. Unknown values are null, never guessed. */
export const JdSchema = z.object({
  title: z.string().nullable(),
  company: z.string().nullable(),
  location: z.object({
    city: z.string().nullable(),
    country: z.string().nullable(),
    remote: z.enum(REMOTE_KINDS),
  }),
  employment_type: z.enum(EMPLOYMENT_TYPES).nullable(),
  seniority: z.enum(SENIORITY).nullable(),
  salary: z
    .object({
      min: z.number().nullable(),
      max: z.number().nullable(),
      currency: z.string().nullable(),
      period: z.enum(SALARY_PERIODS).nullable(),
    })
    .nullable(),
  /** ISO 639-1 code of the posting's language. */
  language: z.string().nullable(),
  deadline: isoDate.nullable(),
  requirements: z.array(
    z.object({ text: z.string(), kind: z.enum(['required', 'preferred']), skills: z.array(z.string()) }),
  ),
  responsibilities: z.array(z.string()),
  about: z.string().nullable(),
  benefits: z.array(z.string()),
});
export type Jd = z.infer<typeof JdSchema>;

export const VERDICTS = ['apply', 'stretch', 'skip'] as const;

const MatchedItem = z.object({
  requirement: z.string(),
  evidence_ids: z.array(z.string()),
  note: z.string(),
});

/** Output of the `job.analyze` task. */
export const AnalyzeOutputSchema = z.object({
  fit_score: z.number().int().min(0).max(100),
  verdict: z.enum(VERDICTS),
  summary: z.string(),
  verdict_reason: z.string(),
  matched: z.array(MatchedItem),
  missing_skills: z.array(
    z.object({
      skill: z.string(),
      importance: z.enum(['required', 'preferred']),
      have_adjacent: z.string().optional(),
    }),
  ),
  missing_experience: z.array(z.string()),
  red_flags: z.array(z.string()),
  strengths: z.array(z.string()),
});
export type AnalyzeOutput = z.infer<typeof AnalyzeOutputSchema>;

/** Stored in `analyses.result_json`: the model output after code-side validation, plus what was dropped. */
export const AnalysisResultSchema = AnalyzeOutputSchema.extend({
  warnings: z.array(z.string()),
  /** Matches the model claimed without any valid profile evidence; not counted as matched. */
  unverified: z.array(MatchedItem).default([]),
  /** Set when the model's score counted unverified matches, so it is not to be trusted as-is. */
  score_flag: z.literal('unverified_evidence').nullable().default(null),
});
export type AnalysisResult = z.infer<typeof AnalysisResultSchema>;

export const JobSummarySchema = z.object({
  id: z.string(),
  companyId: z.string(),
  company: z.string(),
  title: z.string(),
  locationText: z.string().nullable(),
  country: z.string().nullable(),
  remote: z.enum(REMOTE_KINDS),
  employmentType: z.string().nullable(),
  seniority: z.string().nullable(),
  salaryMin: z.number().nullable(),
  salaryMax: z.number().nullable(),
  salaryCurrency: z.string().nullable(),
  salaryPeriod: z.string().nullable(),
  language: z.string().nullable(),
  url: z.string().nullable(),
  applyUrl: z.string().nullable(),
  postedAt: z.string().nullable(),
  deadlineAt: z.string().nullable(),
  state: z.enum(JOB_STATES),
  firstSeenAt: z.string(),
  /** Latest full analysis, if any. */
  fitScore: z.number().nullable(),
  verdict: z.enum(VERDICTS).nullable(),
});
export type JobSummary = z.infer<typeof JobSummarySchema>;

export const AnalysisRecordSchema = z.object({
  id: z.string(),
  jobId: z.string(),
  createdAt: z.string(),
  profileHash: z.string(),
  model: z.string(),
  promptVersion: z.string(),
  result: AnalysisResultSchema,
  /** The profile changed since this analysis ran. */
  profileStale: z.boolean(),
  /** The posting text was replaced (Fetch / Paste full text) after this analysis ran. */
  postingStale: z.boolean(),
});
export type AnalysisRecord = z.infer<typeof AnalysisRecordSchema>;

export const JobDetailSchema = JobSummarySchema.extend({
  descriptionMd: z.string(),
  structured: JdSchema.nullable(),
  sources: z.array(z.object({ source: z.string(), url: z.string().nullable(), fetchedAt: z.string() })),
});
export type JobDetail = z.infer<typeof JobDetailSchema>;
