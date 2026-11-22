import { skillBlocker, type ResumeContent } from '../documents';
import type { Jd } from '../jobs/schemas';
import { canonicalSkillKey, matchesSkill, type Profile, type SkillRow } from '../profile';
import type { SkillsPolicy } from '../rules';
import { demandKey } from './demand';
import { findSkills, lookupSkill, skillFamilyMates } from './index';
import type { AuditRecommendation, DemandShare, SkillAuditRow } from './schemas';

type Importance = SkillAuditRow['jdImportance'];

/** A skill name resolved against the profile and the dictionary. `key` is the identity used everywhere. */
export interface ResolvedSkill {
  key: string;
  display: string;
  row: SkillRow | null;
}

/** The profile row for `name`: by the row's own name/aliases, then through the dictionary's other spellings. */
export function resolveSkill(name: string, profile: Profile): ResolvedSkill {
  const dict = lookupSkill(name);
  const row =
    profile.skills.find((r) => matchesSkill(r, name)) ??
    (dict ? profile.skills.find((r) => dict.terms.some((t) => matchesSkill(r, t))) : undefined) ??
    null;
  const display = row?.skill ?? dict?.name ?? name.trim();
  return { key: canonicalSkillKey(display), display, row };
}

export interface RecommendInput {
  /** The profile row, or null when the profile does not list the skill. */
  row: SkillRow | null;
  onResume: boolean;
  importance: Importance;
  /** The user approved the skill for this job (kept or added in an earlier audit). */
  approved: boolean;
  /** Policy `always_pin`. */
  pinned: boolean;
  /** Policy would let the skill appear (`skillBlocker` is null). */
  allowed: boolean;
  /** A close substitute the profile has, when the policy asks about those. */
  adjacent: string | null;
}

/**
 * The docs/07 §2 table, code only. Order matters: a skill on the resume is judged first (keep or remove),
 * then JD skills that are not on it (learn, ask, add to the profile, or bring a skill you have forward).
 */
export function recommendSkill(i: RecommendInput): AuditRecommendation {
  const wanted = i.importance === 'required' || i.importance === 'preferred';
  if (i.onResume) {
    if (!i.allowed && !i.approved) return 'remove'; // truth check blocks it: ghost, never_show, level, recency
    if (i.row === null) return 'add_to_profile'; // approved for this job, but the profile does not list it
    if (i.row.status === 'learning')
      return i.approved || i.pinned || (i.row.level ?? 0) >= 2 ? 'keep' : 'remove';
    if (wanted) return (i.row.level ?? 0) >= 4 ? 'emphasize' : 'keep';
    return i.importance === 'mentioned' || i.approved || i.pinned ? 'keep' : 'remove';
  }
  if (i.row === null) {
    if (i.approved) return 'add_to_profile';
    return i.adjacent !== null ? 'ask_have' : 'learn';
  }
  return i.row.status === 'have' && i.allowed ? 'emphasize' : 'learn';
}

const strengthOf = (row: SkillRow | null): SkillAuditRow['strength'] =>
  row === null ? 'none' : (row.level ?? 0) >= 4 ? 'high' : (row.level ?? 0) === 3 ? 'medium' : 'low';

const originOf = (row: SkillRow | null, approved: boolean): SkillAuditRow['origin'] =>
  row === null
    ? approved
      ? 'unlisted_confirmed'
      : 'jd_only'
    : row.status === 'have'
      ? 'profile_have'
      : 'profile_learning';

const IMPORTANCE_ORDER: Record<Importance, number> = { required: 0, preferred: 1, mentioned: 2, absent: 3 };

/** JD skill name → importance, from the structured requirements (required wins) and mentions in the JD text. */
export function jdImportance(jd: Jd | null): (names: readonly string[]) => Importance {
  const listed = new Map<string, Importance>();
  for (const req of jd?.requirements ?? [])
    for (const s of req.skills) {
      const k = demandKey(s);
      if (req.kind === 'required' || !listed.has(k)) listed.set(k, req.kind);
    }
  const text = jd
    ? [...jd.requirements.map((r) => r.text), ...jd.responsibilities, jd.about ?? ''].join('\n')
    : '';
  const mentioned = new Set(findSkills(text).map((h) => demandKey(h.skill.name)));
  return (names) => {
    const keys = names.map(demandKey);
    return (
      (['required', 'preferred'] as const).find((k) => keys.some((x) => listed.get(x) === k)) ??
      (keys.some((x) => mentioned.has(x)) ? 'mentioned' : 'absent')
    );
  };
}

/**
 * The per-resume skill audit (docs/07 §2): one row for every skill in the resume's skills section or listed
 * under the JD's required/preferred requirements. Recommendations, origin, strength and demand are code;
 * `rationale` and `learnEstimateHours` start null and are filled by the `skills.audit` task. Pure.
 *
 * `approvals` are skills the user kept or added for this job; `demand` is the 90-day window keyed by `demandKey`.
 * Only the skills section counts as "on the resume": that is the part a decision can edit.
 */
export function buildSkillAudit(
  content: ResumeContent | null,
  profile: Profile,
  jd: Jd | null,
  policy: SkillsPolicy,
  approvals: readonly string[],
  demand: ReadonlyMap<string, DemandShare>,
  today = new Date(),
): SkillAuditRow[] {
  const importanceOf = jdImportance(jd);
  const approvedKeys = new Set(approvals.map((a) => resolveSkill(a, profile).key));
  const jdSkills = jd?.requirements.flatMap((r) => r.skills) ?? [];
  const universe = new Map<string, { skill: ResolvedSkill; onResume: boolean }>();
  const add = (name: string, onResume: boolean): void => {
    const skill = resolveSkill(name, profile);
    const prev = universe.get(skill.key);
    universe.set(skill.key, { skill, onResume: onResume || (prev?.onResume ?? false) });
  };
  for (const group of content?.skills ?? []) for (const s of group.skills) add(s, true);
  for (const s of jdSkills) add(s, false);

  const rows = [...universe.values()].map(({ skill, onResume }): SkillAuditRow => {
    const { row, key, display } = skill;
    const approved = approvedKeys.has(key);
    const names = [display, ...(row?.aliases ?? [])];
    const importance = importanceOf(names);
    const pinned = row !== null && policy.always_pin.some((n) => matchesSkill(row, n));
    const mates = policy.adjacent_skill_prompt ? skillFamilyMates(display) : [];
    const adjacent =
      row === null
        ? (profile.skills.find((r) => r.status === 'have' && mates.includes(lookupSkill(r.skill)?.name ?? ''))
            ?.skill ?? null)
        : null;
    const recommendation = recommendSkill({
      row,
      onResume,
      importance,
      approved,
      pinned,
      allowed: row !== null && skillBlocker(row, policy, jdSkills, today) === null,
      adjacent,
    });
    return {
      skill: display,
      origin: originOf(row, approved),
      onResume,
      jdImportance: importance,
      evidenceIds: row?.evidence ?? [],
      strength: strengthOf(row),
      recommendation,
      decision: 'pending',
      demand: names.map((n) => demand.get(demandKey(n))).find((d) => d !== undefined) ?? null,
      adjacentTo: recommendation === 'ask_have' ? adjacent : null,
      rationale: null,
      learnEstimateHours: null,
    };
  });
  return rows.sort(
    (a, b) =>
      IMPORTANCE_ORDER[a.jdImportance] - IMPORTANCE_ORDER[b.jdImportance] ||
      Number(b.onResume) - Number(a.onResume) ||
      a.skill.localeCompare(b.skill),
  );
}

/** `content` without the skill (any spelling); skill lines left empty are dropped. Pure. */
export function withoutSkill(content: ResumeContent, key: string, profile: Profile): ResumeContent {
  return {
    ...content,
    skills: content.skills
      .map((g) => ({ ...g, skills: g.skills.filter((s) => resolveSkill(s, profile).key !== key) }))
      .filter((g) => g.skills.length > 0),
  };
}
