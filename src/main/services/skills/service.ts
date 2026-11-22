import type { ResumeContent } from '@shared/documents';
import { JdSchema, type Jd } from '@shared/jobs/schemas';
import {
  canonicalSkillKey,
  matchesSkill,
  parseProfile,
  profilePlaceholders,
  serializeProfile,
  upsertSkill,
  type SkillRow,
} from '@shared/profile';
import { lintRules, type SkillsPolicy } from '@shared/rules';
import { buildSkillAudit, jdImportance, resolveSkill, withoutSkill } from '@shared/skills/audit';
import { demandPriority } from '@shared/skills/demand';
import { lookupSkill } from '@shared/skills';
import type {
  GapRow,
  LearningItem,
  LedgerRow,
  ProfilePreview,
  SkillAuditRow,
  DemandShare,
} from '@shared/skills/schemas';
import { aiFailureMessage } from '../../ai/failure';
import type { ClaudeRunner } from '../../ai/runner';
import { rowsNeedingWording, runSkillsAudit, validateWording } from '../../ai/tasks/skillsAudit';
import type { Db } from '../../db/database';
import { setAiRunRelated } from '../../db/repos/aiRuns';
import {
  approvedSkillsForJob,
  getDocumentVersion,
  listDocumentVersions,
  type DocumentRow,
} from '../../db/repos/documents';
import { getJob } from '../../db/repos/jobs';
import {
  countLearnJobs,
  demandMap,
  findLearningItem,
  getAuditWording,
  getLearningItem,
  insertLearningItem,
  listAuditRows,
  listLearningItems,
  setAuditDecision,
  storedRecommendation,
  setAuditWording,
  updateLearningItem,
  upsertAuditRows,
  type LearningPatch,
  type LearningRow,
} from '../../db/repos/skills';
import { UserError } from '../../ipc/dispatch';
import type { DocumentsService } from '../documents/service';
import type { ProfileService } from '../profile/service';
import type { RulesService } from '../rules/service';
import type { AiSettingsService } from '../settings/ai';

export interface SkillsServiceDeps {
  db: Db;
  runner: ClaudeRunner;
  settings: AiSettingsService;
  profile: ProfileService;
  rules: RulesService;
  documents: DocumentsService;
}

export type SkillDecision = 'keep' | 'remove' | 'learn' | 'add_to_profile';
export interface AuditResult {
  rows: SkillAuditRow[];
  /** The wording task failed (the rows are still complete); null when it ran or was not needed. */
  aiWarning: string | null;
}
export interface DecideResult {
  audit: SkillAuditRow[];
  newVersion?: number;
  profilePreview?: ProfilePreview;
}

const LEARN_TARGET_LEVEL = 3;
const storedFields = (r: SkillAuditRow) => ({
  origin: r.origin,
  jdImportance: r.jdImportance,
  recommendation: storedRecommendation(r.recommendation),
});
const pct = (x: number): string => `${String(Math.round(x * 100))}%`;

export const toLearning = (r: LearningRow): LearningItem => ({
  id: r.id,
  skill: r.skill,
  priority: r.priority,
  reason: r.reason,
  targetLevel: r.targetLevel,
  estHours: r.estHours,
  status: r.status,
  resourcesMd: r.resourcesMd,
  linkedJobs: r.linkedJobs,
  completedAt: r.completedAt,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

export function createSkillsService(deps: SkillsServiceDeps) {
  const { db, runner, settings, profile, rules, documents } = deps;

  async function loadPolicy(): Promise<SkillsPolicy> {
    const file = await rules.get('rules/skills-policy.md');
    const policy = lintRules('skills-policy', file.content).config;
    if (!policy) throw new UserError('rules/skills-policy.md has errors. Fix them in Rules first.');
    return policy;
  }

  function requireJob(jobId: string) {
    const job = getJob(db, jobId);
    if (!job) throw new UserError('That job no longer exists.');
    return { job, jd: JdSchema.safeParse(job.structuredJson).data ?? null };
  }

  async function loadDocument(jobId: string, version: number) {
    const doc = getDocumentVersion(db, jobId, 'resume', version);
    if (!doc) throw new UserError(`Resume version ${String(version)} does not exist.`);
    const view = await documents.get(jobId, version);
    if (!view.content)
      throw new UserError(
        `Version ${String(version)} is a manual edit. The skill audit works on drafted versions.`,
      );
    return { doc, content: view.content };
  }

  /** The code-only audit of a stored version (no AI), with the user's stored decisions laid over it. */
  async function pureRows(jobId: string, doc: DocumentRow, content: ResumeContent): Promise<SkillAuditRow[]> {
    const { jd } = requireJob(jobId);
    const [snap, policy] = [await profile.get(), await loadPolicy()];
    const rows = buildSkillAudit(
      content,
      snap.model,
      jd,
      policy,
      approvedSkillsForJob(db, jobId),
      demandMap(db, '90d'),
    );
    const stored = listAuditRows(db, doc.id);
    return rows.map((r) => {
      const hit = stored.find((s) => canonicalSkillKey(s.skill) === canonicalSkillKey(r.skill));
      return hit ? { ...r, decision: hit.decision } : r;
    });
  }

  /** Overlays cached wording and persists the rows to `skill_audits`. */
  function withWording(doc: DocumentRow, rows: SkillAuditRow[]): SkillAuditRow[] {
    const wording = getAuditWording(db, doc.id) ?? {};
    const merged = rows.map((r) => {
      const w = wording[canonicalSkillKey(r.skill)];
      return w ? { ...r, rationale: w.rationale, learnEstimateHours: w.learnEstimateHours } : r;
    });
    upsertAuditRows(db, doc.id, merged);
    return merged;
  }

  async function audit(
    jobId: string,
    version: number,
    opts: { refresh?: boolean; signal?: AbortSignal } = {},
  ): Promise<AuditResult> {
    const { doc, content } = await loadDocument(jobId, version);
    const { job, jd } = requireJob(jobId);
    const rows = await pureRows(jobId, doc, content);
    const cached = opts.refresh ? {} : (getAuditWording(db, doc.id) ?? {});
    const missing = rowsNeedingWording(rows).filter((r) => cached[canonicalSkillKey(r.skill)] === undefined);
    let aiWarning: string | null = null;
    const snap = missing.length > 0 ? await profile.get() : null;
    const placeholder = snap ? profilePlaceholders(snap.model)[0] : undefined;
    if (placeholder)
      aiWarning = placeholder.message; // rows keep their code-only verdicts, no wording is requested
    else if (snap) {
      const config = settings.forTask('skills.audit');
      const res = await runSkillsAudit(runner, {
        rows: missing,
        profile: snap.model,
        jd,
        config,
        signal: opts.signal,
      });
      if (res.ok) {
        setAiRunRelated(db, res.runId, 'job', job.id);
        const wording = validateWording(missing, res.data);
        const next = { ...cached };
        for (const [key, w] of wording) next[key] = w;
        setAuditWording(db, doc.id, next);
        if (wording.size < missing.length)
          aiWarning = 'The model skipped some rows; they have no explanation.';
      } else if (res.status === 'cancelled') throw new UserError(aiFailureMessage(res.status, res.error));
      else aiWarning = aiFailureMessage(res.status, res.error);
    }
    return { rows: withWording(doc, rows), aiWarning };
  }

  async function profilePreview(row: SkillAuditRow, given: SkillRow | undefined): Promise<ProfilePreview> {
    const snap = await profile.get();
    const next: SkillRow = given ?? {
      skill: row.skill,
      category: lookupSkill(row.skill)?.category ?? 'tool',
      level: null,
      years: null,
      last_used: 'now',
      evidence: [],
      status: 'have',
      aliases: [],
    };
    // The audit's spelling must resolve to the saved row, or the approval would not find it again.
    const saved = matchesSkill(next, row.skill) ? next : { ...next, aliases: [...next.aliases, row.skill] };
    const after = serializeProfile(upsertSkill(parseProfile(snap.markdown).doc, saved));
    return { before: snap.markdown, after, expectedHash: snap.hash };
  }

  function learn(doc: DocumentRow, row: SkillAuditRow, jd: Jd | null): void {
    setAuditDecision(db, doc.id, row.skill, 'learning', storedFields(row));
    const hours = getAuditWording(db, doc.id)?.[canonicalSkillKey(row.skill)]?.learnEstimateHours ?? null;
    const reason = row.demand
      ? `Named in ${pct(row.demand.share)} of your stored jobs (${pct(row.demand.requiredShare)} require it).`
      : `Listed in ${jd?.title ?? 'a'} posting you audited.`;
    const existing = findLearningItem(db, row.skill);
    const patch: LearningPatch = {
      priority: demandPriority(row.demand),
      reason,
      targetLevel: LEARN_TARGET_LEVEL,
      ...(hours === null ? {} : { estHours: hours }),
      linkedJobs: countLearnJobs(db, row.skill),
      ...(existing?.status === 'dropped' ? { status: 'todo' as const, completedAt: null } : {}),
    };
    if (existing) updateLearningItem(db, existing.id, patch);
    else insertLearningItem(db, row.skill, patch);
  }

  async function decide(
    jobId: string,
    version: number,
    skill: string,
    decision: SkillDecision,
    profileRow?: SkillRow,
  ): Promise<DecideResult> {
    const { doc, content } = await loadDocument(jobId, version);
    const { jd } = requireJob(jobId);
    const rows = await pureRows(jobId, doc, content);
    const snap = await profile.get();
    const key = resolveSkill(skill, snap.model).key;
    const row = rows.find((r) => resolveSkill(r.skill, snap.model).key === key);
    if (!row) throw new UserError(`${skill} is not in this audit.`);
    const fallback = storedFields(row);

    if (decision === 'add_to_profile')
      return { audit: withWording(doc, rows), profilePreview: await profilePreview(row, profileRow) };

    if (decision === 'learn') {
      learn(doc, row, jd);
      return { audit: withWording(doc, await pureRows(jobId, doc, content)) };
    }

    if (!row.onResume) throw new UserError(`${row.skill} is not on this resume.`);
    if (decision === 'keep') {
      // The approval has to exist before the new version is checked, so the truth check allows the skill.
      setAuditDecision(db, doc.id, row.skill, 'kept', fallback);
      let view;
      try {
        view = await documents.editContent(jobId, version, (c) => c, `Kept ${row.skill}`);
      } catch (err) {
        setAuditDecision(db, doc.id, row.skill, 'pending', fallback);
        throw err;
      }
      return finishVersion(jobId, view.meta.version);
    }
    const view = await documents.editContent(
      jobId,
      version,
      (c) => withoutSkill(c, key, snap.model),
      `Removed ${row.skill} (your decision)`,
    );
    setAuditDecision(db, doc.id, row.skill, 'removed', fallback);
    return finishVersion(jobId, view.meta.version);
  }

  /** The decision is stored on the old version; the new version's audit is the answer. */
  async function finishVersion(jobId: string, newVersion: number): Promise<DecideResult> {
    const { doc, content } = await loadDocument(jobId, newVersion);
    return { audit: withWording(doc, await pureRows(jobId, doc, content)), newVersion };
  }

  /**
   * Called by the renderer after `profile:save` succeeded for an add-to-profile preview. Only a skill the saved
   * profile really lists can be approved, so a stray call cannot unlock a skill the profile does not back.
   */
  async function recordApproval(jobId: string, skill: string): Promise<{ approved: string[] }> {
    const { jd } = requireJob(jobId);
    const snap = await profile.get();
    const resolved = resolveSkill(skill, snap.model);
    if (!resolved.row) throw new UserError(`Save ${skill} to your profile first.`);
    const latest = listDocumentVersions(db, jobId, 'resume').at(-1);
    if (!latest) throw new UserError('This job has no resume yet.');
    setAuditDecision(db, latest.id, resolved.display, 'added', {
      origin: 'unlisted_confirmed',
      jdImportance: jdImportance(jd)([resolved.display, ...resolved.row.aliases]),
      recommendation: 'add_to_profile',
    });
    return { approved: approvedSkillsForJob(db, jobId) };
  }

  const demandFor = (
    map: Map<string, DemandShare & { skill: string }>,
    names: readonly string[],
  ): DemandShare | null => {
    for (const n of names) {
      const d = map.get(canonicalSkillKey(lookupSkill(n)?.name ?? n));
      if (d) return { jobCount: d.jobCount, share: d.share, requiredShare: d.requiredShare };
    }
    return null;
  };

  async function ledger(): Promise<LedgerRow[]> {
    const snap = await profile.get();
    const demand = demandMap(db, '90d');
    const items = listLearningItems(db);
    return snap.model.skills.map((r) => {
      const item = items.find((l) => canonicalSkillKey(l.skill) === canonicalSkillKey(r.skill));
      return {
        skill: r.skill,
        category: r.category,
        level: r.level,
        years: r.years,
        lastUsed: r.last_used,
        status: r.status,
        demand: demandFor(demand, [r.skill, ...r.aliases]),
        learning: item ? toLearning(item) : null,
      };
    });
  }

  async function gaps(window: '30d' | '90d' | 'all' = '90d'): Promise<GapRow[]> {
    const snap = await profile.get();
    const items = listLearningItems(db);
    const out: GapRow[] = [];
    for (const d of demandMap(db, window).values()) {
      const { row } = resolveSkill(d.skill, snap.model);
      if (row?.status === 'have') continue;
      const item = items.find((l) => canonicalSkillKey(l.skill) === canonicalSkillKey(d.skill));
      out.push({
        skill: d.skill,
        category: lookupSkill(d.skill)?.category ?? null,
        demand: { jobCount: d.jobCount, share: d.share, requiredShare: d.requiredShare },
        priority: demandPriority(d),
        inProfile: row?.status === 'learning' || row?.status === 'want' ? row.status : null,
        learning: item ? toLearning(item) : null,
      });
    }
    const score = (g: GapRow): number =>
      g.demand.requiredShare * 2 + (g.demand.share - g.demand.requiredShare);
    return out.sort((a, b) => score(b) - score(a) || a.skill.localeCompare(b.skill)).slice(0, 100);
  }

  return {
    audit,
    decide,
    recordApproval,
    ledger,
    gaps,
    listLearning: (): LearningItem[] => listLearningItems(db).map(toLearning),
    /** "Learn" on a gap: no job is involved, so the reason cites the demand only. Re-adds a dropped item. */
    addLearning(skill: string): LearningItem {
      const name = lookupSkill(skill)?.name ?? skill.trim();
      const d = demandMap(db, '90d').get(canonicalSkillKey(name));
      const existing = findLearningItem(db, name);
      const patch: LearningPatch = {
        priority: demandPriority(d ?? null),
        reason: d
          ? `Named in ${pct(d.share)} of your stored jobs (${pct(d.requiredShare)} require it).`
          : 'Added from Gaps.',
        targetLevel: LEARN_TARGET_LEVEL,
        linkedJobs: countLearnJobs(db, name),
        ...(existing?.status === 'dropped' ? { status: 'todo' as const, completedAt: null } : {}),
      };
      const row = existing ? updateLearningItem(db, existing.id, patch) : insertLearningItem(db, name, patch);
      if (!row) throw new UserError('That learning item no longer exists.');
      return toLearning(row);
    },
    updateLearning(
      id: string,
      patch: Partial<
        Pick<LearningItem, 'status' | 'priority' | 'reason' | 'targetLevel' | 'estHours' | 'resourcesMd'>
      >,
    ): LearningItem {
      const current = getLearningItem(db, id);
      if (!current) throw new UserError('That learning item no longer exists.');
      const completedAt =
        patch.status === undefined || patch.status === current.status
          ? {}
          : { completedAt: patch.status === 'done' ? new Date().toISOString() : null };
      const updated = updateLearningItem(db, id, { ...patch, ...completedAt });
      if (!updated) throw new UserError('That learning item no longer exists.');
      return toLearning(updated);
    },
  };
}
export type SkillsService = ReturnType<typeof createSkillsService>;
