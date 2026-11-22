import { AnalyzeOutputSchema, type AnalysisResult, type AnalyzeOutput, type Jd } from '@shared/jobs/schemas';
import { profileForPrompt, type Profile } from '@shared/profile';
import type { TaskConfig } from '@shared/settings/ai';
import { loadPrompt } from '../prompts';
import type { ClaudeRunner, RunResult } from '../runner';
import { wrapData } from '../wrap';
import { MAX_JD_CHARS } from './jdParse';

export interface JobAnalyzeRequest {
  profile: Profile;
  jd: Jd | null;
  /** Raw posting Markdown. */
  descriptionMd: string;
  config: TaskConfig;
  signal?: AbortSignal;
}

export function analyzeJob(runner: ClaudeRunner, req: JobAnalyzeRequest): Promise<RunResult<AnalyzeOutput>> {
  const prompt = loadPrompt('job.analyze');
  return runner.run({
    task: 'job.analyze',
    model: req.config.model,
    effort: req.config.effort,
    systemPrompt: prompt.system,
    input: [
      wrapData('profile', profileForPrompt(req.profile)),
      wrapData('job_structured', JSON.stringify(req.jd)),
      wrapData('job_description', req.descriptionMd.slice(0, MAX_JD_CHARS)),
    ].join('\n\n'),
    schema: AnalyzeOutputSchema,
    jsonSchema: prompt.jsonSchema,
    timeoutMs: req.config.timeoutMs,
    signal: req.signal,
    priority: 'user',
    promptVersion: prompt.version,
  });
}

/** The prompt's one exception: a match backed by a profile header field cites no entry id. */
const HEADER_FIELD = /languages?[ _]spoken|spoken languages?|work[ _]authori[sz]ation|location/i;

/**
 * Never trusts model-cited evidence: ids that are not profile entries are dropped and recorded in `warnings`.
 * A match left with no valid evidence (and not header-based) moves to `unverified` and flags the score; when a
 * third or more of the matches are unverified, an "apply" verdict is capped at "stretch".
 * Also flags a verdict that contradicts the score bands in the prompt.
 */
export function validateAnalysis(out: AnalyzeOutput, profileIds: ReadonlySet<string>): AnalysisResult {
  const warnings: string[] = [];
  const matched: AnalyzeOutput['matched'] = [];
  const unverified: AnalyzeOutput['matched'] = [];
  for (const m of out.matched) {
    const valid = m.evidence_ids.filter((id) => profileIds.has(id));
    for (const id of m.evidence_ids.filter((i) => !profileIds.has(i)))
      warnings.push(`"${m.requirement}": dropped unknown evidence id "${id}"`);
    const item = { ...m, evidence_ids: valid };
    if (valid.length > 0 || (m.evidence_ids.length === 0 && HEADER_FIELD.test(m.note))) matched.push(item);
    else {
      unverified.push(item);
      warnings.push(
        m.evidence_ids.length > 0
          ? `"${m.requirement}": no valid evidence in the profile, moved to unverified`
          : `"${m.requirement}": no evidence cited, moved to unverified`,
      );
    }
  }
  const expected = out.fit_score >= 70 ? 'apply' : out.fit_score >= 45 ? 'stretch' : 'skip';
  if (out.verdict !== expected)
    warnings.push(
      `verdict "${out.verdict}" does not match score ${String(out.fit_score)} (expected "${expected}")`,
    );
  let verdict = out.verdict;
  if (unverified.length > 0) {
    warnings.push(
      `score ${String(out.fit_score)} counts ${String(unverified.length)} of ${String(out.matched.length)} matched requirements that have no valid evidence`,
    );
    if (verdict === 'apply' && unverified.length * 3 >= out.matched.length) {
      verdict = 'stretch';
      warnings.push(
        'verdict capped at "stretch" because a third or more of the matched requirements are unverified',
      );
    }
  }
  return {
    ...out,
    verdict,
    matched,
    unverified,
    score_flag: unverified.length > 0 ? 'unverified_evidence' : null,
    warnings,
  };
}
