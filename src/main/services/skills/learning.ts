import { readResume } from '@shared/documents';
import { JdSchema } from '@shared/jobs/schemas';
import type { Profile } from '@shared/profile';
import { applySuggestions, type ProfileSuggestion } from '@shared/profile/suggest';
import { resolveSkill } from '@shared/skills/audit';
import { demandKey } from '@shared/skills/demand';
import { computeNudges, type Nudge } from '@shared/skills/nudges';
import { cleanResources, resourcesToMarkdown, type Resource } from '@shared/skills/resources';
import {
  normalizePriorities,
  rawPriority,
  roadmapSummary,
  unlockedJobs,
  whatIf,
  type RoadmapItem,
  type RoadmapJob,
  type WhatIf,
} from '@shared/skills/roadmap';
import { lookupSkill, skillFamilyMates } from '@shared/skills';
import type { DemandShare, LearningItem } from '@shared/skills/schemas';
import { aiFailureMessage } from '../../ai/failure';
import type { ClaudeRunner } from '../../ai/runner';
import { suggestResources } from '../../ai/tasks/learning';
import { suggestProfile } from '../../ai/tasks/profileSuggest';
import type { Db } from '../../db/database';
import { openResumes, recentSkillDecisions } from '../../db/repos/documents';
import { listOpenJobs } from '../../db/repos/jobs';
import { applicationEvents, applications } from '../../db/schema';
import { demandMap, getLearningItem, listLearningItems, updateLearningItem } from '../../db/repos/skills';
import { UserError } from '../../ipc/dispatch';
import type { ProfileService } from '../profile/service';
import type { AiSettingsService } from '../settings/ai';
import { toLearning } from './service';

export interface LearningServiceDeps {
  db: Db;
  runner: ClaudeRunner;
  settings: AiSettingsService;
  profile: ProfileService;
  now?: () => Date;
}

const DAY = 86_400_000;
const NOTES_LIMIT = 4000;

/** Open jobs as the roadmap sees them: which required / preferred JD skills the profile does not have. */
function roadmapJobs(rows: ReturnType<typeof listOpenJobs>, profile: Profile): RoadmapJob[] {
  return rows.map((r) => {
    const jd = JdSchema.safeParse(r.structured).data;
    const missing = (kind: 'required' | 'preferred'): string[] => {
      const names = (jd?.requirements ?? []).filter((q) => q.kind === kind).flatMap((q) => q.skills);
      const lacking = names.filter((n) => resolveSkill(n, profile).row?.status !== 'have');
      return [...new Set(lacking.map(demandKey))];
    };
    return {
      id: r.id,
      company: r.company,
      title: r.title,
      fit: r.fit,
      verdict: r.verdict,
      missingRequired: missing('required'),
      missingPreferred: missing('preferred').filter((k) => !missing('required').includes(k)),
    };
  });
}

export function createLearningService(deps: LearningServiceDeps) {
  const { db, runner, settings, profile } = deps;
  const now = deps.now ?? (() => new Date());

  const demandOf = (map: ReturnType<typeof demandMap>, skill: string): DemandShare | null => {
    const d = map.get(demandKey(skill));
    return d ? { jobCount: d.jobCount, share: d.share, requiredShare: d.requiredShare } : null;
  };

  async function openJobs(): Promise<RoadmapJob[]> {
    return roadmapJobs(listOpenJobs(db), (await profile.get()).model);
  }

  /** Learning items ranked by priority (docs/07 §5). Active items first, then done, then dropped. */
  async function roadmap(): Promise<{ items: RoadmapItem[]; openJobs: number }> {
    const jobs = await openJobs();
    const demand = demandMap(db, '90d');
    const rows = listLearningItems(db).map((l) => {
      const d = demandOf(demand, l.skill);
      const unlocked = unlockedJobs(l.skill, jobs);
      return {
        l,
        d,
        unlocked,
        raw: rawPriority(d, unlocked.length, jobs.length, l.estHours),
        active: l.status === 'todo' || l.status === 'doing',
      };
    });
    const active = rows
      .filter((r) => r.active)
      .sort((a, b) => b.raw - a.raw || a.l.skill.localeCompare(b.l.skill));
    const priorities = normalizePriorities(active.map((r) => r.raw));
    const rest = rows
      .filter((r) => !r.active)
      .sort(
        (a, b) =>
          Number(a.l.status === 'dropped') - Number(b.l.status === 'dropped') ||
          a.l.skill.localeCompare(b.l.skill),
      );
    const item = (r: (typeof rows)[number], priority: number): RoadmapItem => ({
      id: r.l.id,
      skill: r.l.skill,
      status: r.l.status,
      priority,
      estHours: r.l.estHours,
      demand: r.d,
      unlocks: r.unlocked.length,
      unlockJobs: r.unlocked.slice(0, 10).map((j) => ({ jobId: j.id, company: j.company, title: j.title })),
      summary: roadmapSummary(r.l.skill, r.d, r.l.estHours, r.unlocked.length),
      resourcesMd: r.l.resourcesMd,
    });
    return {
      items: [
        ...active.map((r, i) => item(r, priorities[i] ?? 1)),
        ...rest.map((r) => item(r, r.l.priority)),
      ],
      openJobs: jobs.length,
    };
  }

  async function whatIfSkills(skills: readonly string[]): Promise<WhatIf> {
    return whatIf(skills, await openJobs());
  }

  /** On demand, per item: 2-3 suggested resources, stored on the item. The model is never asked automatically. */
  async function resources(id: string, signal?: AbortSignal): Promise<LearningItem> {
    const item = getLearningItem(db, id);
    if (!item) throw new UserError('That learning item no longer exists.');
    const snap = await profile.get();
    const mates = skillFamilyMates(item.skill);
    const category = lookupSkill(item.skill)?.category;
    const related = snap.model.skills
      .filter(
        (s) =>
          s.status === 'have' &&
          (mates.includes(lookupSkill(s.skill)?.name ?? '') ||
            (category !== undefined && lookupSkill(s.skill)?.category === category)),
      )
      .map((s) => s.skill)
      .slice(0, 8);
    const res = await suggestResources(runner, {
      skill: item.skill,
      targetLevel: item.targetLevel,
      estHours: item.estHours,
      related,
      config: settings.forTask('learning.resources'),
      signal,
    });
    if (!res.ok) throw new UserError(aiFailureMessage(res.status, res.error));
    const list: Resource[] = cleanResources(res.data);
    if (list.length === 0)
      throw new UserError(
        'The model gave no usable links (https only). Try again, or search the web yourself.',
      );
    const updated = updateLearningItem(db, id, { resourcesMd: resourcesToMarkdown(list) });
    if (!updated) throw new UserError('That learning item no longer exists.');
    return toLearning(updated);
  }

  /** Staleness nudges for Today (docs/07 §4). Code only. */
  async function nudges(): Promise<Nudge[]> {
    const snap = await profile.get();
    const demand = demandMap(db, '90d');
    const resumeSkills = openResumes(db).flatMap(({ tex }) =>
      readResume(tex).sections.flatMap((s) => s.skillLines.flatMap((l) => l.skills)),
    );
    return computeNudges({
      now: now(),
      lastReviewed: snap.model.frontMatter.last_reviewed,
      skills: snap.model.skills.map((s) => ({ skill: s.skill, lastUsed: s.last_used, status: s.status })),
      resumeSkills,
      doing: listLearningItems(db)
        .filter((l) => l.status === 'doing')
        .map((l) => ({ skill: l.skill, updatedAt: l.updatedAt, demand: demandOf(demand, l.skill) })),
    });
  }

  /**
   * `profile.suggest` (docs/07 §4): reads the last 90 days of skill decisions, finished learning items and the
   * notes you wrote, and returns the profile text that would result as a preview. Never writes: the renderer
   * saves it through `profile:save` with `expectedHash` after you confirm the diff.
   */
  async function suggest(signal?: AbortSignal): Promise<ProfileSuggestion> {
    const snap = await profile.get();
    const at = now();
    const today = at.toISOString().slice(0, 10);
    const decisions = recentSkillDecisions(db, new Date(at.getTime() - 90 * DAY).toISOString());
    const done = listLearningItems(db).filter((l) => l.status === 'done');
    const notes = [
      ...db.orm
        .select({ md: applications.notesMd })
        .from(applications)
        .all()
        .flatMap((a) => (a.md?.trim() ? [a.md.trim()] : [])),
      ...db.orm
        .select({
          type: applicationEvents.type,
          payload: applicationEvents.payloadJson,
          at: applicationEvents.at,
        })
        .from(applicationEvents)
        .all()
        .filter((e) => e.type === 'note' && e.at >= new Date(at.getTime() - 90 * DAY).toISOString())
        .flatMap((e) => {
          const text = (e.payload as { text?: unknown } | null)?.text;
          return typeof text === 'string' && text.trim() ? [text.trim()] : [];
        }),
    ]
      .join('\n---\n')
      .slice(0, NOTES_LIMIT);

    const sources = {
      confirmed: [
        ...decisions.filter((d) => d.decision === 'added').map((d) => d.skill),
        ...done.map((l) => l.skill),
      ],
      decided: decisions.map((d) => d.skill),
      notes,
    };
    const nothing = decisions.length === 0 && done.length === 0 && notes === '';
    if (nothing) {
      const { after } = applySuggestions(snap.markdown, { summary: '', skill_updates: [] }, sources, today);
      return {
        before: snap.markdown,
        after,
        expectedHash: snap.hash,
        summary:
          'Nothing new to base updates on: no skill decisions in the last 90 days, no finished learning items and no notes. Confirming only sets the review date.',
        items: [],
        dropped: [],
      };
    }
    const res = await suggestProfile(runner, {
      profile: snap.model,
      decisions: decisions.map((d) => ({ skill: d.skill, decision: d.decision, job: d.job })),
      learningDone: done.map((l) => ({
        skill: l.skill,
        doneAt: (l.completedAt ?? l.updatedAt).slice(0, 10),
      })),
      notes,
      today,
      config: settings.forTask('profile.suggest'),
      signal,
    });
    if (!res.ok) throw new UserError(aiFailureMessage(res.status, res.error));
    const applied = applySuggestions(snap.markdown, res.data, sources, today);
    return {
      before: snap.markdown,
      expectedHash: snap.hash,
      summary: res.data.summary.replace(/\s+/g, ' ').trim().slice(0, 400),
      ...applied,
    };
  }

  return { roadmap, whatIf: whatIfSkills, resources, nudges, suggest };
}
export type LearningService = ReturnType<typeof createLearningService>;
