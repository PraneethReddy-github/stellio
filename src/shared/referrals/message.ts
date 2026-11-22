import { escapeRe, words } from '../documents/lint';
import { checkCoverTruth } from '../documents/truth';
import type { Profile } from '../profile';
import { profileEntryIds } from '../profile';
import type { ReferralMessageRules, SkillsPolicy } from '../rules';
import type { GroundItem } from './rank';
import type { MessageChecks, MessageOutput } from './schemas';
import { fold } from './validate';

// Lint and truth check of a drafted referral message (docs/14 §2 step 4, §3). Pure.

export interface MessageIssue {
  rule: string;
  message: string;
}

export interface MessageContext {
  /** The exact job title. */
  roleTitle: string;
  /** The company: its name and the role words are not shared ground. */
  company: string;
  /** Accepted job references: the posting link and/or its id. */
  jobRefs: readonly string[];
  /** The person's cited public facts, plus their title and location. */
  personFacts: readonly string[];
  /** What the profile can share with a person (education, employers, languages, city, projects). */
  ground: readonly GroundItem[];
  /** 'de' when the person's public pages are German; null when unknown. */
  expectedLanguage: Language | null;
}

export type Language = 'en' | 'de';

const EN_WORDS = new Set(
  'the and for with that this from have are you your our will was were their about into more which been has not but can would should could what when where who how also its they them than then there these those over such only other some any most very'.split(
    ' ',
  ),
);
const DE_WORDS = new Set(
  'der die das und ist nicht mit für von den dem des ein eine einer eines auf als auch sich wir ich sie ihr ihre bei aus nach zum zur wird werden wurde haben hat sind oder wie über unter bis nur noch mehr aber dass sein seine unser unsere'
    .split(' ')
    .map(fold),
);

/** "de" or "en" by common function words; null when the text is too short to tell. */
export function detectLanguage(text: string): Language | null {
  const toks = fold(text).split(' ').filter(Boolean);
  let d = 0;
  let e = 0;
  for (const t of toks) {
    if (DE_WORDS.has(t)) d++;
    else if (EN_WORDS.has(t)) e++;
  }
  if (d + e < 3) return null;
  return d > e * 1.3 ? 'de' : e > d * 1.3 ? 'en' : null;
}

export const normLanguage = (l: string): Language | null =>
  /^(de|german|deutsch)/i.test(l.trim()) ? 'de' : /^(en|english|englisch)/i.test(l.trim()) ? 'en' : null;

const ASK =
  /\b(would you be open to|are you open to|would you (?:be willing|mind|consider)|could you (?:please )?(?:refer|share|tell|point|let me know)|can you (?:refer|share|tell)|would it be possible|open to (?:refer|sharing|telling)|refer(?:ring)? me|a referral|referral|tell(?:ing)? me whether|share (?:a |your )?(?:quick |short )?(?:view|thoughts|perspective|take)|let me know whether|offen dafur|konnten sie|konntest du|wurden sie|wurdest du|empfehlen|empfehlung|einschatzung|ob sie|ob du)\b/;
const ATTACHMENT = /\b(attached|attachment|enclosed|anbei|im anhang|angehangt)\b/;
const FIRST_PERSON_EN = /(?<![\p{L}'])(I|I'm|I've|I'd|my)(?![\p{L}])/u;
const FIRST_PERSON_DE = /\b(ich|mein|meine|meinen|meinem|meiner|mir|mich)\b/i;

const sentences = (text: string): string[] =>
  text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);

const content = (s: string): Set<string> =>
  new Set(
    fold(s)
      .split(' ')
      .filter((w) => w.length >= 4 && !EN_WORDS.has(w) && !DE_WORDS.has(w)),
  );

const hasPhrase = (text: string, phrase: string): boolean => ` ${fold(text)} `.includes(` ${fold(phrase)} `);

const urlish = (s: string): string =>
  s
    .toLowerCase()
    .replace(/^https?:\/\/(www\.)?/, '')
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '');

/** True when `text` mentions the reference: a link (scheme and "www." ignored) or an id as a whole token. */
function mentions(text: string, ref: string): boolean {
  const r = ref.trim();
  if (r === '') return false;
  if (/^https?:\/\//i.test(r)) {
    const want = urlish(r);
    return text
      .toLowerCase()
      .split(/\s+/)
      .some((t) => urlish(t.replace(/^[(<"']+|[),.;>"']+$/g, '')) === want);
  }
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(r)}(?![\\p{L}\\p{N}])`, 'iu').test(text);
}

/** Lint of the drafted message against `rules/referral-message.md` (every rule is an error). */
export function lintMessage(
  msg: MessageOutput,
  rules: ReferralMessageRules,
  ctx: MessageContext,
): MessageIssue[] {
  const issues: MessageIssue[] = [];
  const add = (rule: string, message: string): void => void issues.push({ rule, message });
  const note = msg.connection_note.trim();
  const body = msg.body.trim();
  const subject = msg.subject.trim();

  if (note === '') add('connection_note', 'The connection note is empty');
  else if (note.length > rules.connection_note.max_chars)
    add(
      'connection_note',
      `The connection note has ${String(note.length)} characters; the limit is ${String(rules.connection_note.max_chars)}`,
    );
  const n = words(body);
  const { min, max } = rules.message.words;
  if (n < min || n > max)
    add('message_words', `The message has ${String(n)} words; it must have ${String(min)} to ${String(max)}`);
  if (subject === '') add('subject', 'The subject is empty');
  else if (subject.length > rules.message.subject_max_chars)
    add(
      'subject',
      `The subject has ${String(subject.length)} characters; the limit is ${String(rules.message.subject_max_chars)}`,
    );

  for (const phrase of rules.banned_phrases) {
    const re = new RegExp(
      `(?<![\\p{L}\\p{N}])${escapeRe(phrase).replace(/'/g, "['’]")}(?![\\p{L}\\p{N}])`,
      'iu',
    );
    for (const [field, text] of [
      ['connection note', note],
      ['subject', subject],
      ['message', body],
    ] as const)
      if (re.test(text)) add('banned_phrases', `Uses the banned phrase "${phrase}" in the ${field}`);
  }
  if (ATTACHMENT.test(fold(`${note} ${body}`)))
    add(
      'attachments',
      'Mentions an attachment; the first message carries none (offer to send the resume instead)',
    );
  if (rules.first_person && body !== '' && !FIRST_PERSON_EN.test(body) && !FIRST_PERSON_DE.test(body))
    add('first_person', 'The message must be written in the first person');

  const must = new Set(rules.must_include);
  // A link may contain the title ("data-engineer-42"): only the prose counts.
  const prose = body.replace(/https?:\/\/\S+/g, ' ');
  if (must.has('role_title') && !hasPhrase(prose, ctx.roleTitle))
    add('role_title', `The message must name the exact job title "${ctx.roleTitle}"`);
  if (must.has('job_reference') && !ctx.jobRefs.some((r) => mentions(body, r)))
    add('job_reference', `The message must include the job link or id (${ctx.jobRefs.join(' or ')})`);
  if (must.has('small_ask') && !ASK.test(fold(body)))
    add(
      'small_ask',
      'The message must contain a small, clear ask (for example "would you be open to referring me?")',
    );
  if (must.has('shared_ground')) {
    const mine = ctx.ground.filter((g) => hasPhrase(body, g.label));
    const common = new Set(fold(`${ctx.roleTitle} ${ctx.company}`).split(' '));
    const facts = ctx.personFacts.map((f) => new Set([...content(f)].filter((w) => !common.has(w))));
    const referencesFact = sentences(body).some((s) => {
      const c = content(s);
      return facts.some((f) => [...f].filter((w) => c.has(w)).length >= 3);
    });
    if (mine.length === 0 && !referencesFact)
      add(
        'shared_ground',
        'The message must contain one sentence with a specific shared point: something from their cited facts or your profile (university, ex-employer, city, project, talk)',
      );
  }

  if (rules.match_language && ctx.expectedLanguage) {
    const lang = detectLanguage(body) ?? normLanguage(msg.language);
    if (lang && lang !== ctx.expectedLanguage)
      add(
        'language',
        `Their public pages are in ${ctx.expectedLanguage === 'de' ? 'German' : 'English'}; write the message in that language`,
      );
  }
  return issues;
}

export interface MessageTruthInput {
  policy: SkillsPolicy;
  jobTitle: string;
  jobCompany: string;
  jobLocation: string;
  person: { name: string; title: string; location: string; facts: readonly string[] };
}

/**
 * Truth of the message. Claims about the user go through the cover-letter prose check against the profile (any
 * non-excluded entry may be cited). Claims about the person may only use their cited facts: organisations,
 * numbers and skills named in the message must be in the profile, the job, or those facts.
 */
export function checkMessageTruth(
  msg: MessageOutput,
  profile: Profile,
  input: MessageTruthInput,
): MessageChecks['truth'] {
  const ids = [...profileEntryIds(profile)];
  const bodyParas = msg.body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const labels = ['connection_note', 'subject', ...bodyParas.map((_, i) => `body[${String(i)}]`)];
  const parts = [msg.connection_note, msg.subject, ...bodyParas];
  const facts = input.person.facts.join('\n');
  const report = checkCoverTruth(
    {
      salutation: null,
      closing: null,
      paragraphs: parts.map((text) => ({ text, source_ids: ids })),
    },
    profile,
    {
      policy: input.policy,
      jd: null,
      company: [
        input.jobTitle,
        input.jobCompany,
        input.jobLocation,
        input.person.name,
        input.person.title,
        input.person.location,
        facts,
      ].join('\n'),
      extraSources: facts,
    },
  );
  return report.violations.map((v) => ({
    kind: v.kind,
    text: v.text,
    detail: `${v.detail} (${labels[Number(/\[(\d+)\]/.exec(v.path)?.[1] ?? -1)] ?? v.path})`,
  }));
}

/** Lint and truth together; `ok` when neither found anything. */
export function checkMessage(
  msg: MessageOutput,
  rules: ReferralMessageRules,
  profile: Profile,
  ctx: MessageContext,
  truthInput: MessageTruthInput,
): MessageChecks {
  const lint = lintMessage(msg, rules, ctx);
  const truth = checkMessageTruth(msg, profile, truthInput);
  return { ok: lint.length === 0 && truth.length === 0, lint, truth, warnings: [] };
}
