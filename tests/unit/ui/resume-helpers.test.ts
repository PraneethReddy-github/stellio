import { describe, expect, it } from 'vitest';
import {
  checkLabel,
  effectiveVersion,
  keywordState,
  modelLabel,
  reviseBlocker,
  stageLabel,
  versionLabel,
} from '../../../src/renderer/src/features/workspace/resume/helpers';
import type { ResumeSummary } from '../../../src/renderer/src/lib/resume';

const row = (version: number, extra: Partial<ResumeSummary['meta']> = {}): ResumeSummary => ({
  meta: {
    profileHash: 'p',
    rulesHash: 'r',
    templateHash: 't',
    model: 'claude-sonnet-5-5',
    promptVersion: 'resume.generate@v1',
    jobId: 'j',
    version,
    createdAt: '2026-11-20T10:00:00Z',
    parentVersion: null,
    instruction: null,
    userEdited: false,
    isFinal: false,
    ...extra,
  },
  truthOk: true,
  truthViolations: 0,
  atsScore: 80,
  lintErrors: 0,
  pages: 1,
  compileOk: true,
  stale: false,
});

describe('resume tab helpers', () => {
  it('names the model readably', () => {
    expect(modelLabel('claude-sonnet-5-5')).toBe('Sonnet 5.5');
    expect(modelLabel('claude-opus-5-5')).toBe('Opus 5.5');
    expect(modelLabel('my-model')).toBe('my-model');
  });

  it('labels the running stage', () => {
    expect(stageLabel(null)).toBe('Starting');
    expect(stageLabel({ stage: 'drafting' })).toBe('Drafting');
    expect(stageLabel({ stage: 'compiling' })).toBe('Compiling');
    expect(stageLabel({ stage: 'fixing', issues: 1 })).toBe('Fixing 1 issue');
    expect(stageLabel({ stage: 'fixing', issues: 2 })).toBe('Fixing 2 issues');
    expect(stageLabel({ stage: 'fixing' })).toBe('Fixing issues');
  });

  it('labels versions with Final and edited', () => {
    expect(versionLabel(row(2))).toBe('v2');
    expect(versionLabel(row(3, { isFinal: true }))).toBe('v3 · Final');
    expect(versionLabel(row(4, { userEdited: true, isFinal: true }))).toBe('v4 · Final · edited');
  });

  it('picks the shown version: the picked one while it exists, else the newest', () => {
    const list = [row(1), row(2), row(3)];
    expect(effectiveVersion(list, null)).toBe(3);
    expect(effectiveVersion(list, 2)).toBe(2);
    expect(effectiveVersion(list, 9)).toBe(3);
    expect(effectiveVersion([], 1)).toBeNull();
  });

  it('tells a fixable missing keyword from a missing one', () => {
    expect(keywordState({ term: 'SQL', found: true, youHave: true })).toBe('found');
    expect(keywordState({ term: 'dbt', found: false, youHave: true })).toBe('youHave');
    expect(keywordState({ term: 'Spark', found: false, youHave: false })).toBe('missing');
  });

  it('reads format check ids', () => {
    expect(checkLabel('single_column')).toBe('Single column');
    expect(checkLabel('no_icons')).toBe('No icons');
  });

  it('says why Revise cannot run', () => {
    const base = { hasVersion: true, manual: false, dirty: false, running: false };
    expect(reviseBlocker(base)).toBeNull();
    expect(reviseBlocker({ ...base, dirty: true })).toMatch(/Save your edits/);
    expect(reviseBlocker({ ...base, manual: true })).toMatch(/edited by hand/);
    expect(reviseBlocker({ ...base, manual: true, running: true })).toBeNull();
    expect(reviseBlocker({ ...base, hasVersion: false })).toBeNull();
  });
});
