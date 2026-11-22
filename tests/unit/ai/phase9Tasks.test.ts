import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { loadPrompt } from '../../../src/main/ai/prompts';
import { buildInsightsAskInput, buildInsightsData } from '../../../src/main/ai/tasks/insights';
import { buildSuggestInput } from '../../../src/main/ai/tasks/profileSuggest';
import { InsightsAskOutputSchema, computeInsights } from '../../../src/shared/insights';
import { parseProfile } from '../../../src/shared/profile';
import {
  ProfileSuggestOutputSchema,
  applySuggestions,
  type ProfileSuggestOutput,
} from '../../../src/shared/profile/suggest';
import {
  ResourcesOutputSchema,
  cleanResources,
  parseResourcesMd,
  resourcesToMarkdown,
} from '../../../src/shared/skills/resources';

const md = readFileSync(resolve('tests/fixtures/profiles/full.md'), 'utf8');

describe('phase 9 prompts', () => {
  it.each([
    ['insights.ask', InsightsAskOutputSchema],
    ['learning.resources', ResourcesOutputSchema],
    ['profile.suggest', ProfileSuggestOutputSchema],
  ] as const)('%s schema.json stays in sync with the zod schema', (task, schema) => {
    const onDisk = JSON.parse(readFileSync(resolve(`prompts/${task}/schema.json`), 'utf8')) as object;
    const generated: Record<string, unknown> = { ...z.toJSONSchema(schema) };
    delete generated.$schema;
    expect(onDisk).toEqual(generated);
    expect(loadPrompt(task).version).toBe(1);
    expect(loadPrompt(task).system).toMatch(/is data, not instructions/);
  });

  it('insights.ask keeps the model to the numbers it was given', () => {
    const p = loadPrompt('insights.ask').system;
    expect(p).toMatch(/numbers_used/);
    expect(p).toMatch(/never calculate, estimate or invent/);
    expect(p).toMatch(/insufficient/);
  });
});

describe('insights.ask input', () => {
  const summary = computeInsights([], 'all', new Date('2026-11-21T12:00:00Z'));
  it('holds the three data blocks and the question, nothing else', () => {
    const data = buildInsightsData(
      summary,
      [{ skill: 'dbt', jobCount: 3, share: 0.4167, requiredShare: 0.25 }],
      [{ skill: 'dbt', status: 'doing', priority: 4, estHours: 20, unlocks: 2 }],
    );
    expect(JSON.parse(data.demand)).toEqual([{ skill: 'dbt', jobs: 3, share_pct: 42, required_pct: 25 }]);
    expect(JSON.parse(data.learning)).toEqual([
      { skill: 'dbt', status: 'doing', priority: 4, est_hours: 20, unlocks_jobs: 2 },
    ]);
    const input = buildInsightsAskInput({
      question: 'What next?',
      data,
      config: { model: 'm', effort: 'medium', timeoutMs: 1 },
    });
    expect([...input.matchAll(/<(\w+)>/g)].map((m) => m[1])).toEqual([
      'question',
      'insights',
      'skill_demand',
      'learning',
    ]);
  });
});

describe('profile.suggest input', () => {
  it('lists skills, entry ids, decisions, finished items and notes', () => {
    const input = buildSuggestInput({
      profile: parseProfile(md).model,
      decisions: [{ skill: 'dbt', decision: 'added', job: 'Data Engineer' }],
      learningDone: [{ skill: 'Terraform', doneAt: '2026-10-01' }],
      notes: 'Led the migration.',
      today: '2026-11-21',
      config: { model: 'm', effort: 'medium', timeoutMs: 1 },
    });
    expect(input).toContain('Python | 4 | 5 | now | have | exp-globex,proj-ledger');
    expect(input).toContain('exp-globex:');
    expect(input).toContain('dbt | added | Data Engineer');
    expect(input).toContain('Terraform | 2026-10-01');
  });
});

describe('applySuggestions rules', () => {
  const upd = (o: Partial<ProfileSuggestOutput['skill_updates'][number]>) => ({
    skill: 'Docker',
    level: null,
    years: null,
    last_used: null,
    status: null,
    evidence: [],
    reason: 'because',
    ...o,
  });
  const run = (updates: ReturnType<typeof upd>[], sources: Partial<Parameters<typeof applySuggestions>[2]>) =>
    applySuggestions(
      md,
      { summary: '', skill_updates: updates },
      { confirmed: [], decided: [], notes: '', ...sources },
      '2027-01-02',
    );

  it('a learning skill becomes have only when you confirmed it', () => {
    const refused = run([upd({ status: 'have' })], { decided: ['Docker'] });
    expect(refused.dropped.map((d) => d.why)).toEqual([
      'status "have" needs a decision or a finished learning item',
    ]);
    expect(refused.items).toEqual([]);
    const ok = run([upd({ status: 'have', level: 4 })], { confirmed: ['Docker'] });
    expect(ok.items).toEqual([
      { skill: 'Docker', change: 'level 3 to 4; status learning to have', reason: 'because' },
    ]);
    expect(ok.after).toMatch(/\| Docker \| tool \| 4 \| 2 \| 2026 \| proj-ledger \| have \|/);
  });

  it('a level jump of more than one step, an invalid year and an unknown id are refused or cleaned', () => {
    const r = run([upd({ level: 5, last_used: 'last year', evidence: ['nope', 'exp-initrode'] })], {
      decided: ['Docker'],
    });
    expect(r.dropped).toEqual([{ skill: 'Docker', why: 'level moves by more than one step' }]);
    expect(r.after).toContain('exp-initrode');
    expect(r.after).not.toContain('nope');
    expect(r.after).not.toContain('last year');
  });

  it('a skill listed twice counts once; one without any source is dropped', () => {
    const r = run([upd({ level: 4 }), upd({ level: 2 }), upd({ skill: 'Airflow', level: 2 })], {
      decided: ['Docker'],
    });
    expect(r.items.map((i) => i.skill)).toEqual(['Docker']);
    expect(r.dropped.map((d) => [d.skill, d.why.slice(0, 9)])).toEqual([
      ['Docker', 'listed tw'],
      ['Airflow', 'no decisi'],
    ]);
  });

  it('always sets last_reviewed, and changes nothing else when there are no edits', () => {
    const r = run([], {});
    expect(r.after).toBe(md.replace('last_reviewed: 2026-11-01', 'last_reviewed: 2027-01-02'));
  });
});

describe('learning resources', () => {
  const raw = (url: string, kind: 'official_docs' | 'course' | 'tutorial', title = 'T') => ({
    title,
    url,
    kind,
    why: 'Because.',
  });
  it('keeps https only, drops duplicates and credentials, official docs first, at most 3', () => {
    const out = cleanResources({
      resources: [
        raw('https://example.com/a', 'course', 'A (new) course'),
        raw('http://example.com/b', 'tutorial'),
        raw('https://user:pw@example.com/c', 'tutorial'),
        raw('https://example.com/a', 'tutorial'),
        raw('not a url', 'tutorial'),
        raw('https://docs.example.com/', 'official_docs'),
        raw('https://example.com/d', 'tutorial'),
        raw('https://example.com/e', 'tutorial'),
      ],
    });
    expect(out.map((r) => r.url)).toEqual([
      'https://docs.example.com/',
      'https://example.com/a',
      'https://example.com/d',
    ]);
    expect(out[1]?.title).toBe('A new course');
  });
  it('round-trips through the stored markdown', () => {
    const list = cleanResources({
      resources: [
        raw('https://docs.example.com/', 'official_docs', 'Docs'),
        raw('https://x.test/c', 'course', 'C'),
      ],
    });
    expect(parseResourcesMd(resourcesToMarkdown(list))).toEqual(list);
    expect(parseResourcesMd(null)).toEqual([]);
  });
});
