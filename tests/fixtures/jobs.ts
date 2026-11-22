import type { AnalyzeOutput, Jd } from '../../src/shared/jobs/schemas';

/** Canned task outputs for tests that run the fake CLI. */
export const sampleJd: Jd = {
  title: 'Data Engineer',
  company: 'Nimbus Analytics GmbH',
  location: { city: 'Berlin', country: 'Germany', remote: 'hybrid' },
  employment_type: 'full_time',
  seniority: 'mid',
  salary: { min: 65000, max: 80000, currency: 'EUR', period: 'year' },
  language: 'en',
  deadline: '2026-12-31',
  requirements: [{ text: 'Strong Python and SQL', kind: 'required', skills: ['Python', 'SQL'] }],
  responsibilities: ['Build pipelines'],
  about: null,
  benefits: [],
};

export const sampleAnalysis: AnalyzeOutput = {
  fit_score: 88,
  verdict: 'apply',
  summary: 'Strong match.',
  verdict_reason: 'Meets all required items.',
  matched: [{ requirement: 'Strong Python and SQL', evidence_ids: ['exp-globex'], note: '5 years' }],
  missing_skills: [{ skill: 'dbt', importance: 'preferred' }],
  missing_experience: [],
  red_flags: [],
  strengths: ['Airflow ownership'],
};
