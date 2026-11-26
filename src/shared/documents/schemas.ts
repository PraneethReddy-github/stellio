import { z } from 'zod';

/** One resume bullet. `source_ids` are profile entry ids; the parent entry always counts as a source. */
export const BulletSchema = z.object({ text: z.string(), source_ids: z.array(z.string()) });
export type Bullet = z.infer<typeof BulletSchema>;

/**
 * Skill-line labels the model may use (D21 + adversarial review): the profile categories' display names plus a
 * few common groupings, alone or two joined with " & " in this order ("Cloud & Tools"). A fixed list, so a label
 * can never carry a claim ("Kubernetes, AWS Certified").
 */
export const BASE_CATEGORY_LABELS = [
  'Languages',
  'Frameworks',
  'Libraries',
  'Databases',
  'Data',
  'Analytics',
  'Machine Learning',
  'Cloud',
  'DevOps',
  'Platforms',
  'Tools',
  'Testing',
  'Practices',
  'Domain',
] as const;
export const CATEGORY_LABELS = [
  ...BASE_CATEGORY_LABELS,
  ...BASE_CATEGORY_LABELS.flatMap((a, i) => BASE_CATEGORY_LABELS.slice(i + 1).map((b) => `${a} & ${b}`)),
] as [string, ...string[]];

const EntryContent = z.object({ entry_id: z.string(), bullets: z.array(BulletSchema) });

/** Language a document version is written in. Drafts are English; a German version is translated from one. */
export const DOC_LANGUAGES = ['en', 'de'] as const;
export const DocLanguageSchema = z.enum(DOC_LANGUAGES);
export type DocLanguage = z.infer<typeof DocLanguageSchema>;

/**
 * What `resume.generate` / `resume.revise` return (docs/phases/phase-5-plan.md, D21). Never LaTeX: code renders
 * the .tex, and employers, titles, dates, locations, degrees and institutions come from the profile.
 */
export const ResumeContentSchema = z.object({
  /** Null when rules.summary.enabled is false. */
  summary: z.string().nullable(),
  /** Display order is enforced reverse-chronological by the renderer. */
  experience: z.array(EntryContent),
  projects: z.array(EntryContent),
  /** Bullets optional (coursework, thesis). */
  education: z.array(EntryContent),
  certifications: z.array(z.object({ entry_id: z.string() })),
  /** Template format 2 sections; default [] so versions stored before them still parse. */
  publications: z.array(EntryContent).default([]),
  patents: z.array(EntryContent).default([]),
  /** Awards and positions of responsibility (the Miscellaneous section). */
  awards: z.array(z.object({ entry_id: z.string() })).default([]),
  /** Skill names must exist in the profile (name or alias). */
  skills: z.array(z.object({ category_label: z.enum(CATEGORY_LABELS), skills: z.array(z.string()) })),
  omitted: z.array(z.object({ id: z.string(), reason: z.string() })),
  change_log: z.array(z.string()),
});
export type ResumeContent = z.infer<typeof ResumeContentSchema>;

export const TRUTH_KINDS = [
  'unknown_id',
  'number_not_in_source',
  'skill_not_allowed',
  'entry_not_in_profile',
  'unknown_organisation',
  'label_not_allowed',
  /** Cover letter: a name in the salutation that the posting does not contain. */
  'name_not_in_source',
  /** German version: a number or a technical term that its English source text does not contain. */
  'term_not_in_source',
] as const;
export const TruthReportSchema = z.object({
  ok: z.boolean(),
  violations: z.array(
    z.object({ kind: z.enum(TRUTH_KINDS), text: z.string(), detail: z.string(), path: z.string() }),
  ),
  /** Not blocking: capitalised terms the cited sources do not contain (names, places, products). */
  warnings: z
    .array(
      z.object({
        kind: z.literal('unverified_term'),
        text: z.string(),
        detail: z.string(),
        path: z.string(),
      }),
    )
    .default([]),
});
export type TruthReport = z.infer<typeof TruthReportSchema>;
export type TruthViolation = TruthReport['violations'][number];
export type TruthWarning = TruthReport['warnings'][number];

export const KeywordHitSchema = z.object({
  term: z.string(),
  found: z.boolean(),
  /** The profile has this skill (status have), so a missing hit can be fixed. */
  youHave: z.boolean(),
});
export type KeywordHit = z.infer<typeof KeywordHitSchema>;

export const AtsReportSchema = z.object({
  /** 0-100, weighted keyword coverage (required ×2). */
  score: z.number(),
  required: z.array(KeywordHitSchema),
  preferred: z.array(KeywordHitSchema),
  format: z.array(z.object({ check: z.string(), ok: z.boolean(), detail: z.string() })),
});
export type AtsReport = z.infer<typeof AtsReportSchema>;

export const LintReportSchema = z.object({
  ok: z.boolean(),
  issues: z.array(
    z.object({
      rule: z.string(),
      severity: z.enum(['error', 'warning']),
      message: z.string(),
      path: z.string().nullable(),
    }),
  ),
});
export type LintReport = z.infer<typeof LintReportSchema>;
export type LintIssue = LintReport['issues'][number];

export const CompileSummarySchema = z.object({
  ok: z.boolean(),
  pages: z.number().nullable(),
  errors: z.array(z.object({ line: z.number().optional(), message: z.string() })),
  overfull: z.number(),
});
export type CompileSummary = z.infer<typeof CompileSummarySchema>;

export const ResumeChecksSchema = z.object({
  /** Null for a manually edited version: the truth check is not applied to hand-written tex. */
  truth: TruthReportSchema.nullable(),
  ats: AtsReportSchema,
  lint: LintReportSchema,
  compile: CompileSummarySchema.nullable(),
});
export type ResumeChecks = z.infer<typeof ResumeChecksSchema>;

export const ResumeMetaSchema = z.object({
  profileHash: z.string(),
  rulesHash: z.string(),
  templateHash: z.string(),
  /** Null for a manual edit. */
  model: z.string().nullable(),
  promptVersion: z.string().nullable(),
  jobId: z.string(),
  version: z.number().int(),
  createdAt: z.string(),
  parentVersion: z.number().int().nullable(),
  instruction: z.string().nullable(),
  userEdited: z.boolean(),
  isFinal: z.boolean(),
  language: DocLanguageSchema.default('en'),
});
export type ResumeMeta = z.infer<typeof ResumeMetaSchema>;

export const ResumeDocumentSchema = z.object({
  /** Null for a manually edited version (only tex exists). */
  content: ResumeContentSchema.nullable(),
  tex: z.string(),
  checks: ResumeChecksSchema,
  meta: ResumeMetaSchema,
});
export type ResumeDocument = z.infer<typeof ResumeDocumentSchema>;

/** `resume:list` row: meta plus summary checks. */
export const ResumeVersionSummarySchema = z.object({
  meta: ResumeMetaSchema,
  truthOk: z.boolean().nullable(),
  truthViolations: z.number().int(),
  atsScore: z.number(),
  lintErrors: z.number().int(),
  pages: z.number().nullable(),
  compileOk: z.boolean().nullable(),
  /** profile, rules or template changed since this version was made. */
  stale: z.boolean(),
});
export type ResumeVersionSummary = z.infer<typeof ResumeVersionSummarySchema>;

/** `resume:progress` stages for the running state. */
export const RESUME_STAGES = ['drafting', 'checking', 'compiling', 'fixing'] as const;
export type ResumeStage = (typeof RESUME_STAGES)[number];
