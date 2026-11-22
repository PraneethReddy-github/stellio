import { z } from 'zod';

export const SKILL_CATEGORIES = [
  'language',
  'framework',
  'tool',
  'cloud',
  'data',
  'practice',
  'domain',
  'soft',
] as const;
export const SKILL_STATUSES = ['have', 'learning', 'want'] as const;
/** Sections made of `### Title {#id}` blocks; the value is also the key in `Profile`. */
export const ENTRY_SECTIONS = [
  'experience',
  'projects',
  'education',
  'certifications',
  'awards',
  'publications',
  'languages',
] as const;
export type EntrySection = (typeof ENTRY_SECTIONS)[number];

/** Recognized `## Heading`s in canonical file order. Anything else is kept as an unknown section. */
export const SECTION_KINDS = [
  'summary',
  'skills',
  'experience',
  'projects',
  'education',
  'certifications',
  'awards',
  'publications',
  'languages',
  'notes',
] as const;
export type SectionKind = (typeof SECTION_KINDS)[number];

const str = z.string().default('');
const strList = z.array(z.string()).default([]);

// The schemas below are structural. Semantic rules (enums, ranges, ids, dates) live in `validateProfile`,
// so a hand-edited file with `level: 9` still yields a model plus a diagnostic instead of nothing.
export const FrontMatterSchema = z.object({
  name: str,
  headline: str,
  email: str,
  phone: str,
  location: str,
  links: z.object({ linkedin: str, github: str, portfolio: str }).prefault({}),
  work_authorization: str,
  notice_period: str,
  languages_spoken: z.array(z.object({ language: z.string(), level: str })).default([]),
  preferences: z
    .object({
      roles: strList,
      seniority: strList,
      locations: strList,
      remote: z.string().default('any'),
      salary_floor: z.number().nullable().default(null),
      currency: str,
      industries_prefer: strList,
      industries_avoid: strList,
      companies_avoid: strList,
    })
    .prefault({}),
  last_reviewed: str,
});
export type FrontMatter = z.infer<typeof FrontMatterSchema>;

export const SkillRowSchema = z.object({
  skill: z.string(),
  category: z.string(),
  level: z.number().nullable(),
  years: z.number().nullable(),
  last_used: z.string(),
  evidence: z.array(z.string()),
  status: z.string(),
  aliases: z.array(z.string()),
});
export type SkillRow = z.infer<typeof SkillRowSchema>;

export const EntrySchema = z.object({
  id: z.string(),
  title: z.string(),
  meta: z.record(z.string(), z.string()),
  bullets: z.array(z.string()),
});
export type Entry = z.infer<typeof EntrySchema>;

const entries = z.array(EntrySchema).default([]);
export const ProfileSchema = z.object({
  frontMatter: FrontMatterSchema.prefault({}),
  summary: str,
  skills: z.array(SkillRowSchema).default([]),
  experience: entries,
  projects: entries,
  education: entries,
  certifications: entries,
  awards: entries,
  publications: entries,
  languages: entries,
  notes: str,
});
export type Profile = z.infer<typeof ProfileSchema>;

export const DiagnosticSchema = z.object({
  severity: z.enum(['error', 'warning']),
  code: z.string(),
  message: z.string(),
  /** 1-based line in the file; null when the problem is not tied to a line (model-level checks). */
  line: z.number().int().nullable(),
});
export type Diagnostic = z.infer<typeof DiagnosticSchema>;

/**
 * Lossless document: the file split after every "\n" (so each line keeps its own terminator, "\r\n"
 * included). `lines.join('') === original text` for any input. Structure is derived on demand from the lines.
 */
export interface ProfileDoc {
  readonly lines: readonly string[];
}
