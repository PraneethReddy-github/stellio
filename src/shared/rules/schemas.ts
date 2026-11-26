import { z } from 'zod';

/** Default order is template format 2's; `misc` is awards, positions and languages. */
export const RESUME_SECTIONS = [
  'header',
  'summary',
  'education',
  'experience',
  'projects',
  'publications',
  'patents',
  'skills',
  'certifications',
  'misc',
] as const;
export const MESSAGE_MUST_INCLUDE = ['role_title', 'job_reference', 'shared_ground', 'small_ask'] as const;
export const DATE_FORMATS = ['MMM YYYY', 'MMMM YYYY', 'MM/YYYY', 'YYYY-MM'] as const;
/** Letter date: "26.11.2026" or "26 November 2026". */
export const LETTER_DATE_FORMATS = ['DD.MM.YYYY', 'D MMMM YYYY'] as const;
export const TENSES = ['past_for_past_roles_present_for_current', 'past', 'present', 'any'] as const;

const int = (min: number, max: number) => z.number().int().min(min).max(max);
const words = z.array(z.string().trim().min(1).max(120)).max(300);
const uniq = (a: string[], ctx: z.RefinementCtx): void => {
  const dup = a.find((v, i) => a.indexOf(v) !== i);
  if (dup !== undefined) ctx.addIssue({ code: 'custom', message: `"${dup}" is listed twice` });
};

/**
 * Builds the three schemas. `strict` makes unknown keys an `unrecognized_keys` issue (reported as a warning);
 * the lenient variant strips them so a config is still produced.
 */
function build(strict: boolean) {
  const O = <T extends z.ZodRawShape>(shape: T) => (strict ? z.strictObject(shape) : z.object(shape));
  const range = (lo: number, hi: number, dMin: number, dMax: number) =>
    O({ min: int(lo, hi).default(dMin), max: int(lo, hi).default(dMax) }).refine((r) => r.min <= r.max, {
      message: 'min must not be greater than max',
      path: ['min'],
    });
  const sections = z.array(z.enum(RESUME_SECTIONS)).max(RESUME_SECTIONS.length).superRefine(uniq);

  const resume = O({
    version: z.literal(1),
    page_limit: int(1, 3).default(1),
    sections_order: sections.default([...RESUME_SECTIONS]),
    sections_required: sections.default(['header', 'experience', 'skills', 'education']),
    summary: O({ enabled: z.boolean().default(true), max_words: int(5, 200).default(50) }).default({
      enabled: true,
      max_words: 50,
    }),
    experience: O({
      max_roles: int(1, 12).default(4),
      bullets_per_role: range(0, 12, 2, 5).default({ min: 2, max: 5 }),
      most_recent_role_bullets_max: int(1, 12).default(6),
    }).default({ max_roles: 4, bullets_per_role: { min: 2, max: 5 }, most_recent_role_bullets_max: 6 }),
    projects: O({
      max: int(0, 10).default(3),
      bullets_per_project: range(0, 8, 1, 3).default({ min: 1, max: 3 }),
    }).default({ max: 3, bullets_per_project: { min: 1, max: 3 } }),
    bullet: O({
      min_chars: int(10, 400).default(60),
      max_chars: int(40, 600).default(190),
      must_start_with_verb: z.boolean().default(true),
      tense: z.enum(TENSES).default('past_for_past_roles_present_for_current'),
    })
      .refine((b) => b.min_chars <= b.max_chars, {
        message: 'min_chars must not be greater than max_chars',
        path: ['min_chars'],
      })
      .default({
        min_chars: 60,
        max_chars: 190,
        must_start_with_verb: true,
        tense: 'past_for_past_roles_present_for_current',
      }),
    skills_section: O({ max_lines: int(1, 10).default(4), max_skills: int(1, 80).default(24) }).default({
      max_lines: 4,
      max_skills: 24,
    }),
    date_format: z.enum(DATE_FORMATS).default('MMM YYYY'),
    photo: z.boolean().default(false),
    banned_words: words.default([]),
    first_person: z.boolean().default(false),
  }).superRefine((v, ctx) => {
    for (const s of v.sections_required) {
      if (!v.sections_order.includes(s))
        ctx.addIssue({
          code: 'custom',
          path: ['sections_required'],
          message: `required section "${s}" is missing from sections_order`,
        });
    }
  });

  const coverLetter = O({
    version: z.literal(1),
    page_limit: int(1, 2).default(1),
    words: range(50, 1500, 230, 350).default({ min: 230, max: 350 }),
    paragraphs: range(1, 12, 3, 4).default({ min: 3, max: 4 }),
    salutation_fallback: z.string().trim().min(1).max(80).default('Dear Hiring Team,'),
    closing: z.string().trim().min(1).max(80).default('Kind regards,'),
    /** Place before the date ("Berlin, 26.11.2026"); empty = the city in the profile location. */
    place: z.string().trim().max(80).default(''),
    date_format: z.enum(LETTER_DATE_FORMATS).default('DD.MM.YYYY'),
    /** Subject line; {role} is the job title. */
    subject: z.string().trim().min(1).max(160).default('Application for the position of {role}'),
    banned_phrases: words.default([]),
    first_person: z.boolean().default(true),
  });

  const skillsPolicy = O({
    version: z.literal(1),
    min_level_to_list: int(1, 5).default(2),
    allow_learning_skills: z.boolean().default(false),
    learning_label: z.string().trim().min(1).max(30).default('(learning)'),
    recency_cutoff_years: int(1, 50).default(5),
    max_skills_listed: int(1, 80).default(24),
    always_pin: words.default([]),
    never_show: words.default([]),
    adjacent_skill_prompt: z.boolean().default(true),
    ghost_skill_policy: z.enum(['block', 'warn']).default('block'),
  });

  const referralMessage = O({
    version: z.literal(1),
    connection_note: O({ max_chars: int(50, 1000).default(300) }).default({ max_chars: 300 }),
    message: O({
      words: range(20, 500, 60, 140).default({ min: 60, max: 140 }),
      subject_max_chars: int(10, 200).default(70),
    }).default({ words: { min: 60, max: 140 }, subject_max_chars: 70 }),
    match_language: z.boolean().default(true),
    must_include: z
      .array(z.enum(MESSAGE_MUST_INCLUDE))
      .max(MESSAGE_MUST_INCLUDE.length)
      .superRefine(uniq)
      .default([...MESSAGE_MUST_INCLUDE]),
    banned_phrases: words.default([]),
    first_person: z.boolean().default(true),
  });

  return {
    resume,
    'cover-letter': coverLetter,
    'skills-policy': skillsPolicy,
    'referral-message': referralMessage,
  } as const;
}

export const lenientSchemas = build(false);
export const strictSchemas = build(true);

export type ResumeRules = z.infer<typeof lenientSchemas.resume>;
export type CoverLetterRules = z.infer<(typeof lenientSchemas)['cover-letter']>;
export type SkillsPolicy = z.infer<(typeof lenientSchemas)['skills-policy']>;
export type ReferralMessageRules = z.infer<(typeof lenientSchemas)['referral-message']>;
export interface RulesConfigs {
  resume: ResumeRules;
  'cover-letter': CoverLetterRules;
  'skills-policy': SkillsPolicy;
  'referral-message': ReferralMessageRules;
}
