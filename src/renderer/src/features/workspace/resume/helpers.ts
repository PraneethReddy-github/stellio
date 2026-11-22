// Pure helpers for the Resume tab. No React, no IPC: unit-tested.
import type { KeywordHit, TruthViolation } from '@shared/documents';
import type { DocKind, DocSummary, ResumeProgress } from '../../../lib/resume';

export const ATS_THRESHOLDS = { ok: 75, warn: 50 } as const;

/** "claude-sonnet-5-5" -> "Sonnet 5.5"; anything else is shown as stored. */
export function modelLabel(model: string): string {
  const m = /^claude-([a-z]+)-(\d+)-(\d+)$/.exec(model);
  return m ? `${(m[1] ?? '').replace(/^./, (c) => c.toUpperCase())} ${m[2] ?? ''}.${m[3] ?? ''}` : model;
}

/** The running line: "Drafting", "Checking", "Compiling", "Fixing 2 issues". */
export function stageLabel(p: Pick<ResumeProgress, 'stage' | 'issues'> | null): string {
  if (!p) return 'Starting';
  switch (p.stage) {
    case 'drafting':
      return 'Drafting';
    case 'checking':
      return 'Checking';
    case 'compiling':
      return 'Compiling';
    case 'fixing':
      return p.issues ? `Fixing ${String(p.issues)} ${p.issues === 1 ? 'issue' : 'issues'}` : 'Fixing issues';
  }
}

/** "v2", "v3 · Final", "v4 · edited". */
export function versionLabel(s: Pick<DocSummary, 'meta'>): string {
  const { version, isFinal, userEdited } = s.meta;
  return [`v${String(version)}`, isFinal && 'Final', userEdited && 'edited'].filter(Boolean).join(' · ');
}

/** The version shown: the picked one while it still exists, else the newest; null when there is none. */
export function effectiveVersion(list: readonly DocSummary[], picked: number | null): number | null {
  if (picked !== null && list.some((s) => s.meta.version === picked)) return picked;
  return list.at(-1)?.meta.version ?? null;
}

export const pagesText = (pages: number | null): string =>
  pages === null ? 'not compiled' : `${String(pages)} ${pages === 1 ? 'page' : 'pages'}`;

export const KEYWORD_LABEL = { found: 'Found', youHave: 'You have it', missing: 'Missing' } as const;
export type KeywordState = keyof typeof KEYWORD_LABEL;

/** A keyword the resume lacks but the profile has is fixable: say so. */
export const keywordState = (k: KeywordHit): KeywordState =>
  k.found ? 'found' : k.youHave ? 'youHave' : 'missing';

export const TRUTH_KIND_LABEL: Record<TruthViolation['kind'], string> = {
  unknown_id: 'Unknown source',
  number_not_in_source: 'Number not in your profile',
  skill_not_allowed: 'Skill not allowed',
  entry_not_in_profile: 'Entry not in your profile',
  unknown_organisation: 'Organisation not in your profile',
  label_not_allowed: 'Skill category not allowed',
  name_not_in_source: 'Name not in the posting',
};

export const FINAL_NOTE_MANUAL = 'Manually edited — truth check not applied.';

/** Why Revise cannot run now, or null. */
export function reviseBlocker(opts: {
  hasVersion: boolean;
  manual: boolean;
  dirty: boolean;
  running: boolean;
}): string | null {
  if (!opts.hasVersion || opts.running) return null;
  if (opts.dirty) return 'Save your edits as a new version before revising.';
  if (opts.manual) return 'This version was edited by hand. Revise works on drafted versions.';
  return null;
}

/** "single_column" -> "Single column". */
export const checkLabel = (check: string): string => {
  const t = check.replace(/_/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
};

/** Words that differ between the resume tab and the cover letter tab. */
export const DOC_COPY: Record<
  DocKind,
  {
    draft: string;
    revise: string;
    empty: string;
    emptyBody: string;
    rules: string;
    task: 'resume.generate' | 'cover.generate';
    latex: string;
    failDraft: string;
    failRevise: string;
  }
> = {
  resume: {
    draft: 'Draft resume',
    revise: 'Revise resume',
    empty: 'No draft yet.',
    emptyBody: 'Writes a resume for this job from your profile. Every claim is checked against it.',
    rules: 'rules/resume.md',
    task: 'resume.generate',
    latex: 'Resume LaTeX',
    failDraft: 'Could not draft the resume',
    failRevise: 'Could not revise the resume',
  },
  cover: {
    draft: 'Draft cover letter',
    revise: 'Revise cover letter',
    empty: 'No letter yet.',
    emptyBody:
      'Writes a cover letter for this job from your profile and the posting. Every claim is checked against them.',
    rules: 'rules/cover-letter.md',
    task: 'cover.generate',
    latex: 'Cover letter LaTeX',
    failDraft: 'Could not draft the cover letter',
    failRevise: 'Could not revise the cover letter',
  },
};
