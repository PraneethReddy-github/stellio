import { profileForPrompt, type Profile } from '@shared/profile';
import {
  MessageOutputSchema,
  SearchOutputSchema,
  type GroundItem,
  type MessageOutput,
  type SearchExclude,
  type SearchHints,
  type SearchOutput,
} from '@shared/referrals';
import type { TaskConfig } from '@shared/settings/ai';
import { loadPrompt } from '../prompts';
import type { ClaudeRunner, RunResult } from '../runner';
import { wrapData } from '../wrap';

// ---- referrals.search ------------------------------------------------------------------------------------

export interface ReferralSearchRequest {
  company: string;
  role: string;
  location: string;
  hints: SearchHints;
  /** Already found: the model is asked for different people. */
  exclude?: SearchExclude;
  /** The user's shared-ground facts. Never contact data. */
  ground: readonly GroundItem[];
  limit: number;
  today: string;
  config: TaskConfig;
  signal?: AbortSignal;
}

export function buildSearchInput(req: ReferralSearchRequest): string {
  const h = req.hints;
  const target = [
    `company: ${req.company}`,
    `role keywords: ${req.role}`,
    `location: ${req.location || 'any'}`,
    h.team && `team or product area: ${h.team}`,
    h.seniority && `seniority: ${h.seniority}`,
    h.alumni?.length && `prefer alumni of: ${h.alumni.join('; ')}`,
    h.languages?.length && `shared languages: ${h.languages.join(', ')}`,
  ]
    .filter(Boolean)
    .join('\n');
  const ground = req.ground.map((g) => `${g.kind}: ${g.label}`).join('\n') || '(none)';
  const ex = req.exclude;
  const exclude =
    ex && (ex.names.length > 0 || ex.profileUrls.length > 0)
      ? wrapData(
          'exclude',
          [...ex.names.map((n) => `name: ${n}`), ...ex.profileUrls.map((u) => `url: ${u}`)].join('\n'),
        )
      : null;
  return [
    wrapData('target', target),
    ...(exclude ? [exclude] : []),
    wrapData('shared_ground', ground),
    `<limit>${String(req.limit)}</limit>`,
    `<date>${req.today}</date>`,
  ].join('\n');
}

/** One `referrals.search` run: web search and fetch only, public pages (docs/14 §1). */
export function searchReferrals(
  runner: ClaudeRunner,
  req: ReferralSearchRequest,
): Promise<RunResult<SearchOutput>> {
  const prompt = loadPrompt('referrals.search');
  return runner.run({
    task: 'referrals.search',
    model: req.config.model,
    effort: req.config.effort,
    systemPrompt: prompt.system,
    input: buildSearchInput(req),
    schema: SearchOutputSchema,
    jsonSchema: prompt.jsonSchema,
    timeoutMs: req.config.timeoutMs,
    signal: req.signal,
    priority: 'user',
    promptVersion: prompt.version,
    tools: 'WebSearch,WebFetch',
  });
}

// ---- referrals.message -----------------------------------------------------------------------------------

export interface ReferralMessageRequest {
  /** Excluded entries already removed. */
  profile: Profile;
  /** Raw `rules/referral-message.md`, embedded verbatim as USER RULES (docs/04 §4). */
  rulesText: string;
  job: { title: string; company: string; location: string; reference: string };
  person: {
    name: string;
    title: string;
    company: string;
    location: string;
    facts: { text: string; source_url: string }[];
  };
  language: 'en' | 'de';
  previous?: MessageOutput;
  /** Exact check failures for the one repair round. */
  repairIssues?: string[];
  config: TaskConfig;
  signal?: AbortSignal;
}

export function buildMessageInput(req: ReferralMessageRequest): string {
  const { job, person } = req;
  const blocks = [
    'USER RULES — follow exactly; they override style defaults, never override truth rules.',
    wrapData('referral_rules', req.rulesText),
    wrapData('profile', profileForPrompt({ ...req.profile, notes: '' })),
    wrapData(
      'job',
      [
        `title: ${job.title}`,
        `company: ${job.company}`,
        job.location && `location: ${job.location}`,
        `link or id to include: ${job.reference}`,
      ]
        .filter(Boolean)
        .join('\n'),
    ),
    wrapData(
      'person',
      [
        `name: ${person.name}`,
        `title: ${person.title}`,
        `company: ${person.company}`,
        person.location && `location: ${person.location}`,
        'facts (each with its public source):',
        ...person.facts.map((f) => `- ${f.text} [${f.source_url}]`),
      ]
        .filter(Boolean)
        .join('\n'),
    ),
    wrapData('language', req.language),
  ];
  if (req.previous) blocks.push(wrapData('previous_draft', JSON.stringify(req.previous, null, 1)));
  if (req.repairIssues?.length)
    blocks.push(wrapData('repair_issues', req.repairIssues.map((i) => `- ${i}`).join('\n')));
  return blocks.join('\n\n');
}

/** One `referrals.message` run (also the repair round). The checks run in code (`checkMessage`). */
export function draftReferralMessage(
  runner: ClaudeRunner,
  req: ReferralMessageRequest,
): Promise<RunResult<MessageOutput>> {
  const prompt = loadPrompt('referrals.message');
  return runner.run({
    task: 'referrals.message',
    model: req.config.model,
    effort: req.config.effort,
    systemPrompt: prompt.system,
    input: buildMessageInput(req),
    schema: MessageOutputSchema,
    jsonSchema: prompt.jsonSchema,
    timeoutMs: req.config.timeoutMs,
    signal: req.signal,
    priority: 'user',
    promptVersion: prompt.version,
  });
}
