// Pure helpers for the Rules screen. No React, no IPC: unit-tested.
import type { Diagnostic } from '@shared/profile';
import type { RulesFile } from '@shared/rules';
import type { CompileResult } from '../../lib/latex';
import { countDiagnostics } from '../profile/helpers';

/** "resume.md" */
export const fileName = (path: RulesFile): string => path.split('/')[1] ?? path;

/** Commit message for a save: "rules: edit resume.md". */
export const saveMessage = (path: RulesFile): string => `rules: edit ${fileName(path)}`;

export const languageOf = (path: RulesFile): 'markdown' | 'latex' =>
  path.endsWith('.tex') ? 'latex' : 'markdown';

/** The one quiet line above the editor: when the file takes effect. */
export function effectNote(path: RulesFile): string {
  switch (path) {
    case 'rules/resume.md':
      return 'Stellio reads this file every time it drafts a resume.';
    case 'rules/cover-letter.md':
      return 'Stellio reads this file every time it drafts a cover letter.';
    case 'rules/skills-policy.md':
      return 'Stellio reads this file when it decides which skills a draft may claim.';
    case 'rules/referral-message.md':
      return 'Stellio reads this file every time it drafts a referral request.';
    case 'templates/resume.tex':
      return 'Stellio fills the marked slots of this template every time it drafts a resume.';
    case 'templates/cover-letter.tex':
      return 'Stellio fills the marked slots of this template every time it drafts a cover letter.';
  }
}

/** Errors first, then warnings; by line within a severity. */
export function sortByLine(list: readonly Diagnostic[]): Diagnostic[] {
  const rank = (d: Diagnostic): number => (d.severity === 'error' ? 0 : 1);
  return [...list].sort((a, b) => rank(a) - rank(b) || (a.line ?? Infinity) - (b.line ?? Infinity));
}

/** "1 page", "2 pages", or a dash when the engine did not get that far. */
export const pagesLabel = (pages: number | null): string =>
  pages === null ? '–' : `${String(pages)} ${pages === 1 ? 'page' : 'pages'}`;

export const durationLabel = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

export const warningLabel: Record<CompileResult['warnings'][number]['kind'], string> = {
  overfull: 'Overfull',
  underfull: 'Underfull',
  other: 'Warning',
};

export { countDiagnostics };
