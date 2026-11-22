import { z } from 'zod';

/** Mirrors of the enums in src/main/db/schema.ts (a unit test keeps them equal). */
export const SKILL_ORIGINS = ['profile_have', 'profile_learning', 'jd_only', 'unlisted_confirmed'] as const;
export const JD_IMPORTANCE = ['required', 'preferred', 'mentioned', 'absent'] as const;
export const SKILL_DECISIONS = ['pending', 'kept', 'removed', 'learning', 'added'] as const;
export const DEMAND_WINDOWS = ['30d', '90d', 'all'] as const;
export const LEARNING_STATUSES = ['todo', 'doing', 'done', 'dropped'] as const;

/** What the audit tells the user to do (docs/07 §2). `emphasize` and `ask_have` are stored as keep / add_to_profile. */
export const AUDIT_RECOMMENDATIONS = [
  'keep',
  'emphasize',
  'remove',
  'learn',
  'add_to_profile',
  'ask_have',
] as const;
export type AuditRecommendation = (typeof AUDIT_RECOMMENDATIONS)[number];

/** The user's choices (K / R / L / A). "I have it" on an ask_have row is add_to_profile; "I don't" is learn. */
export const SKILL_DECIDE_ACTIONS = ['keep', 'remove', 'learn', 'add_to_profile'] as const;

export const DemandShareSchema = z.object({
  jobCount: z.number().int(),
  /** Share of jobs (with a parsed JD in the window) that name the skill, 0-1. */
  share: z.number(),
  /** Share of those jobs that list it as required, 0-1. */
  requiredShare: z.number(),
});
export type DemandShare = z.infer<typeof DemandShareSchema>;

export const SkillAuditRowSchema = z.object({
  skill: z.string(),
  origin: z.enum(SKILL_ORIGINS),
  onResume: z.boolean(),
  jdImportance: z.enum(JD_IMPORTANCE),
  evidenceIds: z.array(z.string()),
  strength: z.enum(['high', 'medium', 'low', 'none']),
  recommendation: z.enum(AUDIT_RECOMMENDATIONS),
  decision: z.enum(SKILL_DECISIONS),
  /** 90-day window; null when no stored job names the skill. */
  demand: DemandShareSchema.nullable(),
  /** ask_have: the profile skill that is a close substitute. */
  adjacentTo: z.string().nullable(),
  /** AI-written, one sentence; null until `skills.audit` has run. */
  rationale: z.string().nullable(),
  /** AI estimate in hours to reach working level (learn / ask_have rows only). Always an estimate. */
  learnEstimateHours: z.number().int().nullable(),
});
export type SkillAuditRow = z.infer<typeof SkillAuditRowSchema>;

/** Output of the `skills.audit` task: wording only. */
export const SkillsAuditOutputSchema = z.object({
  rows: z.array(
    z.object({
      skill: z.string(),
      rationale: z.string(),
      learn_estimate_hours: z.number().int().nullable(),
    }),
  ),
});
export type SkillsAuditOutput = z.infer<typeof SkillsAuditOutputSchema>;

export const ProfilePreviewSchema = z.object({
  before: z.string(),
  after: z.string(),
  /** Pass to `profile:save` so a concurrent edit is detected. */
  expectedHash: z.string(),
});
export type ProfilePreview = z.infer<typeof ProfilePreviewSchema>;

export const LearningItemSchema = z.object({
  id: z.string(),
  skill: z.string(),
  priority: z.number().int(),
  reason: z.string().nullable(),
  targetLevel: z.number().int().nullable(),
  estHours: z.number().int().nullable(),
  status: z.enum(LEARNING_STATUSES),
  resourcesMd: z.string().nullable(),
  linkedJobs: z.number().int(),
  completedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type LearningItem = z.infer<typeof LearningItemSchema>;

export const LedgerRowSchema = z.object({
  skill: z.string(),
  category: z.string(),
  level: z.number().nullable(),
  years: z.number().nullable(),
  lastUsed: z.string(),
  status: z.string(),
  demand: DemandShareSchema.nullable(),
  learning: LearningItemSchema.nullable(),
});
export type LedgerRow = z.infer<typeof LedgerRowSchema>;

export const GapRowSchema = z.object({
  skill: z.string(),
  category: z.string().nullable(),
  demand: DemandShareSchema,
  /** 1-5, from demand (required counts double). */
  priority: z.number().int(),
  /** The profile lists it, but not as `have`. */
  inProfile: z.enum(['learning', 'want']).nullable(),
  learning: LearningItemSchema.nullable(),
});
export type GapRow = z.infer<typeof GapRowSchema>;
