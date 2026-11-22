import { ProfileSchema, type Profile } from '@shared/profile';
import type { ProfileImportOutput } from '../../ai/tasks/profileImport';

/** Maps the AI import result onto the profile model. Preferences stay at defaults: the user sets them. */
export function importToProfile(out: ProfileImportOutput, today: string): Profile {
  return ProfileSchema.parse({
    frontMatter: { ...out.front, last_reviewed: today },
    summary: out.summary,
    skills: out.skills,
    experience: out.experience,
    projects: out.projects,
    education: out.education,
    certifications: out.certifications,
    awards: out.awards,
    publications: out.publications,
    notes: out.notes,
  });
}
