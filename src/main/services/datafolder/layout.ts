import { RULE_FILES, TEMPLATE_FILES } from '@shared/rules/files';

export const PROFILE_FILE = 'profile/profile.md';
/** The fixed name used up to 1.2.6 (it carried the author's name); moved to PROFILE_FILE at startup. */
export const LEGACY_PROFILE_FILE = 'profile/praneethreddy.md';
export { RULE_FILES, TEMPLATE_FILES };
/** Files copied from the seed folder when missing. */
export const SEED_FILES: readonly string[] = [PROFILE_FILE, ...RULE_FILES, ...TEMPLATE_FILES];

export const APPLICATIONS_DIR = 'applications';
export const STELLIO_DIRS = ['.stellio/logs', '.stellio/backups', '.stellio/ai'] as const;
/** Directories whose files are user-editable and watched. */
export const WATCHED_DIRS = ['profile', 'rules', 'templates'] as const;
/** Paths whose changes are committed to git. */
export const VERSIONED_PATHS = ['.gitignore', 'profile', 'rules', 'templates', APPLICATIONS_DIR] as const;
