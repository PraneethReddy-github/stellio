import { z } from 'zod';
import type { TaskConfig } from '@shared/settings/ai';
import type { ClaudeRunner, RunResult } from '../runner';
import { loadPrompt } from '../prompts';

// Mirrors the profile model in docs/03 §1 (front matter, skills table, entry blocks, summary, notes).
// Preferences and last_reviewed are not imported: the user sets those. The lead reconciles this with
// src/shared/profile/types.ts.
const Category = z.enum(['language', 'framework', 'tool', 'cloud', 'data', 'practice', 'domain', 'soft']);
const SkillStatus = z.enum(['have', 'learning', 'want']);
// Ids and meta keys are written into markdown (`{#id}`, `- key: value`) and aliases into a comma list, so keep them plain.
const Slug = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);
const MetaKey = z.string().regex(/^[a-z_]+$/);

export const ProfileImportSkill = z.object({
  skill: z.string().min(1),
  category: Category,
  level: z.number().int().min(1).max(5),
  years: z.number().min(0),
  /** YYYY, or "now", or "" when unknown. */
  last_used: z.string(),
  /** Ids of entries below that prove the skill. */
  evidence: z.array(Slug),
  status: SkillStatus,
  aliases: z.array(z.string().regex(/^[^,\s]([^,]*[^,\s])?$/)),
});

export const ProfileImportEntry = z.object({
  /** `exp-<company-slug>`, `proj-<slug>`, `edu-<slug>`, `cert-<slug>`, `award-<slug>`, `pub-<slug>`. */
  id: Slug,
  /** "Job Title — Company" for experience, project name, "Degree, Field — University", etc. */
  title: z.string().min(1),
  /** start/end/location/type for experience; dates/link/stack for projects; and so on. */
  meta: z.record(MetaKey, z.string()),
  bullets: z.array(z.string()),
});

export const ProfileImportOutput = z.object({
  front: z.object({
    name: z.string(),
    headline: z.string(),
    email: z.string(),
    phone: z.string(),
    location: z.string(),
    links: z.object({ linkedin: z.string(), github: z.string(), portfolio: z.string() }),
    work_authorization: z.string(),
    notice_period: z.string(),
    languages_spoken: z.array(z.object({ language: z.string(), level: z.string() })),
  }),
  summary: z.string(),
  skills: z.array(ProfileImportSkill),
  experience: z.array(ProfileImportEntry),
  projects: z.array(ProfileImportEntry),
  education: z.array(ProfileImportEntry),
  certifications: z.array(ProfileImportEntry),
  awards: z.array(ProfileImportEntry),
  publications: z.array(ProfileImportEntry),
  notes: z.string(),
});
export type ProfileImportOutput = z.infer<typeof ProfileImportOutput>;

export interface ProfileImportRequest {
  resumeText: string;
  /** Model, effort and timeout from settings (docs/04 §2). */
  config: TaskConfig;
  signal?: AbortSignal;
  priority?: 'user' | 'background';
}

/** Turns an old resume's text into a profile draft for the user to review. */
export function importProfile(
  runner: ClaudeRunner,
  req: ProfileImportRequest,
): Promise<RunResult<ProfileImportOutput>> {
  const prompt = loadPrompt('profile.import');
  return runner.run({
    task: 'profile.import',
    model: req.config.model,
    effort: req.config.effort,
    systemPrompt: prompt.system,
    // A closing tag inside the resume must not end the data block early.
    input: `<resume_text>\n${req.resumeText.replace(/<\/(resume_text)/gi, '<\\/$1')}\n</resume_text>`,
    schema: ProfileImportOutput,
    jsonSchema: prompt.jsonSchema,
    timeoutMs: req.config.timeoutMs,
    signal: req.signal,
    priority: req.priority ?? 'user',
    promptVersion: prompt.version,
  });
}
