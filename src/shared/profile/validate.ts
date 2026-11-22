import { profilePlaceholders } from './placeholders';
import { skillKeys } from './skills';
import { ENTRY_SECTIONS, SKILL_CATEGORIES, SKILL_STATUSES, type Diagnostic, type Profile } from './types';

const DAY_MS = 86_400_000;
const STALE_DAYS = 30;
const DATE = /^(\d{4}(-(0[1-9]|1[0-2]))?|present|now)$/;
const LAST_USED = /^(\d{4}|now)$/;
const DATE_KEYS = ['start', 'end', 'date'];

/** Semantic checks on a model. Pure; `today` is injectable so staleness is testable. */
export function validateProfile(model: Profile, opts: { today?: Date } = {}): Diagnostic[] {
  const out: Diagnostic[] = [];
  const add = (severity: Diagnostic['severity'], code: string, message: string): void => {
    out.push({ severity, code, message, line: null });
  };
  const fm = model.frontMatter;
  if (fm.name.trim() === '') add('error', 'profile_name_missing', 'Front matter "name" is required');
  if (fm.email.trim() === '') add('error', 'profile_email_missing', 'Front matter "email" is required');

  // Name and email have their own codes above; the rest is example content from the seed.
  for (const p of profilePlaceholders(model))
    if (p.kind === 'entry') add('error', 'profile_placeholder', p.message);

  const today = opts.today ?? new Date();
  if (fm.last_reviewed !== '') {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(fm.last_reviewed);
    const at = m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : NaN;
    if (Number.isNaN(at)) {
      add(
        'warning',
        'last_reviewed_malformed',
        `"last_reviewed" should look like YYYY-MM-DD, got "${fm.last_reviewed}"`,
      );
    } else if ((today.getTime() - at) / DAY_MS > STALE_DAYS) {
      add(
        'warning',
        'profile_stale',
        `Profile was last reviewed on ${fm.last_reviewed}; review it (over ${STALE_DAYS} days ago)`,
      );
    }
  }

  const ids = new Map<string, number>();
  for (const section of ENTRY_SECTIONS) {
    for (const e of model[section]) {
      const label = `${section} entry "${e.title}"`;
      if (e.id === '') add('error', 'entry_id_missing', `${label} has no {#id}`);
      else ids.set(e.id, (ids.get(e.id) ?? 0) + 1);
      if (e.bullets.length === 0) add('warning', 'entry_no_bullets', `${label} has no bullet facts`);
      for (const key of DATE_KEYS) {
        const v = e.meta[key];
        if (v !== undefined && v !== '' && !DATE.test(v)) {
          add('error', 'date_malformed', `${label}: "${key}: ${v}" is not YYYY-MM, YYYY, present or now`);
        }
      }
    }
  }
  for (const [id, n] of ids) if (n > 1) add('error', 'id_duplicate', `Id "${id}" is used by ${n} entries`);

  const owner = new Map<string, number>();
  model.skills.forEach((s, i) => {
    const label = `Skill "${s.skill}"`;
    if (s.skill.trim() === '') add('error', 'skill_name_missing', `Skill row ${i + 1} has no name`);
    if (s.level === null || !Number.isInteger(s.level) || s.level < 1 || s.level > 5) {
      add('error', 'skill_level_range', `${label}: level must be an integer from 1 to 5`);
    }
    if (!(SKILL_CATEGORIES as readonly string[]).includes(s.category)) {
      add('error', 'skill_category_unknown', `${label}: unknown category "${s.category}"`);
    }
    if (!(SKILL_STATUSES as readonly string[]).includes(s.status)) {
      add('error', 'skill_status_unknown', `${label}: unknown status "${s.status}"`);
    }
    if (s.last_used !== '' && !LAST_USED.test(s.last_used)) {
      add(
        'error',
        'skill_last_used_invalid',
        `${label}: last_used must be YYYY or "now", got "${s.last_used}"`,
      );
    }
    for (const id of s.evidence) {
      if (!ids.has(id)) add('error', 'evidence_unknown_id', `${label}: evidence "${id}" matches no entry id`);
    }
    if (s.status === 'have' && s.evidence.length === 0) {
      add('warning', 'skill_have_no_evidence', `${label} is marked "have" but cites no evidence`);
    }
    for (const key of skillKeys(s)) {
      const other = owner.get(key);
      if (other === undefined) owner.set(key, i);
      else if (other !== i) {
        const o = model.skills[other];
        add(
          'error',
          'skill_duplicate',
          `${label} clashes with "${o?.skill ?? ''}" on "${key}" (name or alias)`,
        );
      }
    }
  });
  return out;
}
