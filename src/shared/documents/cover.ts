import { z } from 'zod';
import { escapeLatex, fillTemplate, parseTemplate } from '../latex/template';
import type { Profile } from '../profile';
import type { CoverLetterRules } from '../rules';
import { FIRST_PERSON, escapeRe, words } from './lint';
import { MONTHS, arg, args, headerArg } from './render';
import {
  BulletSchema,
  CompileSummarySchema,
  LintReportSchema,
  ResumeMetaSchema,
  TruthReportSchema,
  type LintIssue,
  type LintReport,
} from './schemas';
import { texToText } from './texread';

/** One cover-letter paragraph; `source_ids` are the profile entries its facts come from. */
export const CoverParagraphSchema = BulletSchema;

/**
 * What `cover.generate` / `cover.revise` return (docs/phases/phase-6-plan.md C1). Never LaTeX: code renders the
 * header, recipient and date from the profile and the job. A null salutation or closing uses the rules' value.
 */
export const CoverContentSchema = z.object({
  salutation: z.string().nullable(),
  paragraphs: z.array(CoverParagraphSchema),
  closing: z.string().nullable(),
});
export type CoverContent = z.infer<typeof CoverContentSchema>;

export const CoverChecksSchema = z.object({
  /** Null for a manually edited version: the truth check is not applied to hand-written tex. */
  truth: TruthReportSchema.nullable(),
  lint: LintReportSchema,
  compile: CompileSummarySchema.nullable(),
});
export type CoverChecks = z.infer<typeof CoverChecksSchema>;

export const CoverDocumentSchema = z.object({
  /** Null for a manually edited version (only tex exists). */
  content: CoverContentSchema.nullable(),
  tex: z.string(),
  checks: CoverChecksSchema,
  meta: ResumeMetaSchema,
});
export type CoverDocument = z.infer<typeof CoverDocumentSchema>;

/** `cover:list` row. */
export const CoverVersionSummarySchema = z.object({
  meta: ResumeMetaSchema,
  truthOk: z.boolean().nullable(),
  truthViolations: z.number().int(),
  lintErrors: z.number().int(),
  words: z.number().int(),
  pages: z.number().nullable(),
  compileOk: z.boolean().nullable(),
  /** profile, rules or template changed since this version was made. */
  stale: z.boolean(),
});
export type CoverVersionSummary = z.infer<typeof CoverVersionSummarySchema>;

/** What the recipient block says about the job. */
export interface CoverJob {
  company: string;
  title: string;
  /** "Berlin, Germany", "Remote" or "". */
  location: string;
}

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** Indices of the paragraphs the renderer prints (empty ones are dropped). */
export const keptParagraphs = (c: CoverContent): number[] =>
  c.paragraphs.flatMap((p, i) => (oneLine(p.text) === '' ? [] : [i]));

/** "19 November 2026". */
export const letterDate = (d: Date): string =>
  `${String(d.getDate())} ${MONTHS[d.getMonth()] ?? ''} ${String(d.getFullYear())}`;

/**
 * Builds the cover letter .tex from structured content. Pure. The header, recipient and date come from the
 * profile and the job, every model string is escaped, and a lone word that spells a pre-check primitive is
 * protected by the same `arg` helper the resume uses.
 */
export function renderCover(
  content: CoverContent,
  profile: Profile,
  job: CoverJob,
  template: string,
  rules: CoverLetterRules,
  today = new Date(),
): string {
  const f = profile.frontMatter;
  const esc = escapeLatex;
  const slots: Record<string, string> = {};
  slots.header = `\\letterHeader${args(
    esc(f.name),
    esc(f.location),
    headerArg(f.email, 'email'),
    esc(f.phone),
    headerArg(f.links.linkedin, 'url'),
  )}`;
  const role = job.title.trim() === '' ? 'Hiring Team' : `Hiring Team, ${job.title.trim()}`;
  slots.recipient = `\\letterRecipient${args(esc(letterDate(today)), esc(oneLine(job.company)), esc(oneLine(role)))}${
    job.location.trim() === '' ? '{~}' : arg(esc(oneLine(job.location)))
  }`;
  const salutation = oneLine(content.salutation ?? '').slice(0, 80) || rules.salutation_fallback;
  const paragraphs = content.paragraphs.map((p) => oneLine(p.text)).filter((t) => t !== '');
  slots.body = [salutation, ...paragraphs].map(esc).join('\n\n');
  const closing = oneLine(content.closing ?? '').slice(0, 80) || rules.closing;
  slots.closing = `${esc(closing)}\\\\[14pt]\n${esc(f.name)}`;
  return fillTemplate(template, slots);
}

export interface ReadCover {
  /** First block of the body when it is a one-line greeting ending in , or :. */
  salutation: string | null;
  paragraphs: string[];
  /** Word count of the paragraphs (not the salutation). */
  words: number;
}

/** Reads the body slot of a cover letter .tex back into plain text, so lint works on hand-edited versions too. */
export function readCover(tex: string): ReadCover {
  const body = parseTemplate(tex).slots.find((s) => s.name === 'body')?.content ?? '';
  const blocks = body
    .split(/\n\s*\n/)
    .map((b) => texToText(b.replace(/(^|[^\\])%.*$/gm, '$1')))
    .filter((b) => b !== '');
  const greeting = blocks[0] !== undefined && blocks[0].length <= 80 && /^[^\n]*[,:]$/.test(blocks[0]);
  const paragraphs = greeting ? blocks.slice(1) : blocks;
  return {
    salutation: greeting ? (blocks[0] ?? null) : null,
    paragraphs,
    words: paragraphs.reduce((n, p) => n + words(p), 0),
  };
}

/** Company name without its legal suffix ("Nimbus Analytics GmbH" → "Nimbus Analytics"). */
const coreName = (company: string): string =>
  oneLine(company).replace(
    /[\s,]+(?:Inc|Ltd|LLC|LLP|GmbH|AG|Corp|Corporation|plc|SE|SA|BV|NV|Co|Group|Holdings)\.?$/i,
    '',
  );

/**
 * Cover letter lint over the .tex (cover-letter.md front matter): words and paragraph ranges, banned phrases
 * (case-insensitive, from the start of a word so "leveraged" counts), first person, and at most
 * `MAX_COMPANY_MENTIONS` mentions of the company. The page limit is checked by the compile. `keep` maps the
 * i-th printed paragraph to its index in the content (empty paragraphs are not printed). Pure.
 */
export const MAX_COMPANY_MENTIONS = 3;
export function lintCover(
  tex: string,
  rules: CoverLetterRules,
  company: string,
  keep?: number[],
): LintReport {
  const issues: LintIssue[] = [];
  const add = (rule: string, message: string, path: string | null): void => {
    issues.push({ rule, severity: 'error', message, path });
  };
  const doc = readCover(tex);
  const at = (i: number): string => `paragraphs[${String(keep?.[i] ?? i)}]`;
  if (doc.words < rules.words.min || doc.words > rules.words.max)
    add(
      'words',
      `The letter has ${String(doc.words)} words; it must be ${String(rules.words.min)} to ${String(rules.words.max)} (aim for about ${String(Math.round((rules.words.min + rules.words.max) / 2))})`,
      null,
    );
  const n = doc.paragraphs.length;
  if (n < rules.paragraphs.min || n > rules.paragraphs.max)
    add(
      'paragraphs',
      `The letter has ${String(n)} paragraphs; it must be ${String(rules.paragraphs.min)} to ${String(rules.paragraphs.max)}`,
      null,
    );
  const banned = rules.banned_phrases.map((w) => ({
    w,
    re: new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(w.normalize('NFKC').replace(/’/g, "'"))}`, 'iu'),
  }));
  const core = coreName(company);
  // The whole name or, for a multi-word name, its first word ("Nimbus Analytics" counts once; so does "Nimbus").
  const first = core.split(' ')[0] ?? '';
  const names = [core, ...(first.length >= 4 && first !== core ? [first] : [])].filter(Boolean);
  const companyRe =
    names.length === 0
      ? null
      : new RegExp(`(?<![\\p{L}\\p{N}])(?:${names.map(escapeRe).join('|')})(?![\\p{L}\\p{N}])`, 'giu');
  let mentions = 0;
  doc.paragraphs.forEach((p, i) => {
    const text = p.normalize('NFKC').replace(/’/g, "'");
    for (const b of banned)
      if (b.re.test(text)) add('banned_phrases', `Uses the banned phrase "${b.w}"`, at(i));
    if (!rules.first_person) {
      const m = FIRST_PERSON.exec(p);
      if (m) add('first_person', `Uses first person ("${m[1] ?? ''}")`, at(i));
    }
    mentions += companyRe ? (p.match(companyRe)?.length ?? 0) : 0;
  });
  if (mentions > MAX_COMPANY_MENTIONS)
    add(
      'company_mentions',
      `The company "${core}" is named ${String(mentions)} times; the maximum is ${String(MAX_COMPANY_MENTIONS)}`,
      null,
    );
  return { ok: issues.length === 0, issues };
}
