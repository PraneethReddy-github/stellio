import { resolveSkill, withoutSkill } from '@shared/skills/audit';
import { z } from 'zod';
import {
  AtsReportSchema,
  CompileSummarySchema,
  LintReportSchema,
  ResumeContentSchema,
  TruthReportSchema,
  checkAts,
  checkTruth,
  lintContent,
  lintResume,
  renderResume,
  type ResumeChecks,
  type ResumeContent,
  type ResumeDocument,
  type ResumeVersionSummary,
} from '@shared/documents';
import { AnalysisResultSchema, JdSchema, type Jd } from '@shared/jobs/schemas';
import { parseTemplate } from '@shared/latex/template';
import type { Profile } from '@shared/profile';
import { requireRealProfile } from '../profile/guard';
import { lintRules, type ResumeRules, type SkillsPolicy } from '@shared/rules';
import type { ClaudeRunner } from '../../ai/runner';
import { runResumeTask, type ResumeTask } from '../../ai/tasks/resume';
import type { Db } from '../../db/database';
import {
  approvedSkillsForJob,
  removedSkillsForJob,
  getDocumentVersion,
  insertDocumentVersion,
  listDocumentVersions,
  setFinalVersion,
  updateDocument,
  type DocumentRow,
} from '../../db/repos/documents';
import { getJob, latestAnalysis } from '../../db/repos/jobs';
import { UserError } from '../../ipc/dispatch';
import { hashText } from '../datafolder/files';
import { pdfText } from '../latex/compile';
import type { LatexService } from '../latex/service';
import {
  allowedSkills,
  createDocFiles,
  draftWithRepair,
  withoutExcluded,
  type PickSavePath,
  type StageListener,
} from './common';
import type { ProfileService } from '../profile/service';
import type { RulesService } from '../rules/service';
import type { AiSettingsService } from '../settings/ai';
import { lastPageNearlyFull } from './pagefill';

/** What the `*_report_json` columns hold (plan B1 §7: content JSON plus reports, no new columns). */
const StoredTruth = z.object({
  content: ResumeContentSchema.nullable(),
  truth: TruthReportSchema.nullable(),
});
const StoredChecks = z.object({
  ats: AtsReportSchema,
  lint: LintReportSchema,
  compile: CompileSummarySchema.nullable(),
  parentVersion: z.number().int().nullable(),
  instruction: z.string().nullable(),
  changeLog: z.array(z.string()).default([]),
});

export type ResumeView = ResumeDocument & { pdfBase64?: string };
export type { PickSavePath, StageListener };
export { exportFileName, noWorse, overleafForm, sweepOverleafForms } from './common';

export interface DocumentsServiceDeps {
  db: Db;
  runner: ClaudeRunner;
  settings: AiSettingsService;
  profile: ProfileService;
  rules: RulesService;
  latex: LatexService;
  dataDir: string;
}

interface Inputs {
  profile: Profile;
  profileHash: string;
  resumeRulesText: string;
  policyText: string;
  rules: ResumeRules;
  policy: SkillsPolicy;
  template: string;
  rulesHash: string;
  templateHash: string;
}

interface Evaluated {
  content: ResumeContent;
  tex: string;
  checks: ResumeChecks;
  pdf: Buffer | null;
  issues: string[];
  /** Lower is better, compared in order: [truth violations, lint errors + page overflow]. */
  rank: [number, number];
}

export function createDocumentsService(deps: DocumentsServiceDeps) {
  const { db, runner, settings } = deps;
  const files = createDocFiles(deps);
  const { storePdf, readPdf } = files;
  const compile = (tex: string) => files.compile(tex, 'templates/resume.tex');

  async function loadInputs(): Promise<Inputs> {
    const snap = await deps.profile.get();
    const [resume, policy, template] = await Promise.all([
      deps.rules.get('rules/resume.md'),
      deps.rules.get('rules/skills-policy.md'),
      deps.rules.get('templates/resume.tex'),
    ]);
    const rules = lintRules('resume', resume.content).config;
    if (!rules) throw new UserError('rules/resume.md has errors. Fix them in Rules first.');
    const pol = lintRules('skills-policy', policy.content).config;
    if (!pol) throw new UserError('rules/skills-policy.md has errors. Fix them in Rules first.');
    if (parseTemplate(template.content, 'resume').diagnostics.some((d) => d.severity === 'error'))
      throw new UserError('templates/resume.tex has errors. Fix them in Rules first.');
    return {
      profile: snap.model,
      profileHash: snap.hash,
      resumeRulesText: resume.content,
      policyText: policy.content,
      rules,
      policy: pol,
      template: template.content,
      rulesHash: hashText(`${resume.hash}\n${policy.hash}`),
      templateHash: template.hash,
    };
  }

  function requireJob(jobId: string) {
    const job = getJob(db, jobId);
    if (!job) throw new UserError('That job no longer exists.');
    return job;
  }

  function requireVersion(jobId: string, version: number): DocumentRow {
    const row = getDocumentVersion(db, jobId, 'resume', version);
    if (!row) throw new UserError(`Resume version ${String(version)} does not exist.`);
    return row;
  }

  async function atsFor(tex: string, jd: Jd | null, inputs: Inputs, pdf: Buffer | null) {
    return checkAts({
      tex,
      jd,
      profile: inputs.profile,
      rules: inputs.rules,
      ...(pdf ? { pdfText: await pdfText(pdf), pdfBytes: pdf.length } : {}),
    });
  }

  /** render → truth → lint → compile → ATS; `issues` are the blocking ones the repair round must fix. */
  async function evaluate(
    content: ResumeContent,
    jd: Jd | null,
    inputs: Inputs,
    approved: string[],
    onStage: StageListener,
  ): Promise<Evaluated> {
    onStage('checking');
    const tex = renderResume(content, inputs.profile, inputs.template, inputs.rules, inputs.policy);
    const truth = checkTruth(content, inputs.profile, {
      policy: inputs.policy,
      jd,
      approvedSkills: approved,
    });
    const lint = lintContent(tex, inputs.rules, content, inputs.profile);
    onStage('compiling');
    const compiled = await compile(tex);
    // Overleaf compiles with pdfTeX, whose line breaks can differ slightly from Tectonic's (docs/06 §7).
    if (
      compiled?.pdf &&
      compiled.summary.pages === inputs.rules.page_limit &&
      (await lastPageNearlyFull(compiled.pdf))
    )
      lint.issues.push({
        rule: 'overleaf_fit',
        severity: 'warning',
        message: 'May spill onto another page on Overleaf (pdfTeX): the last page is nearly full.',
        path: null,
      });
    const ats = await atsFor(tex, jd, inputs, compiled?.pdf ?? null);
    const issues = [
      ...truth.violations.map((v) => `Truth (${v.kind}) at ${v.path}: "${v.text}" — ${v.detail}`),
      ...lint.issues
        .filter((i) => i.severity === 'error')
        .map((i) => `Rules (${i.rule})${i.path ? ` at ${i.path}` : ''}: ${i.message}`),
    ];
    const pages = compiled?.summary.pages ?? null;
    const overflow = pages !== null && pages > inputs.rules.page_limit;
    if (overflow)
      issues.push(
        `Length: the resume is ${String(pages)} pages; the limit is ${String(inputs.rules.page_limit)}. Cut the least relevant bullets, projects or skills.`,
      );
    return {
      content,
      tex,
      checks: { truth, ats, lint, compile: compiled?.summary ?? null },
      pdf: compiled?.pdf ?? null,
      issues,
      rank: [
        truth.violations.length,
        lint.issues.filter((i) => i.severity === 'error').length + (overflow ? 1 : 0),
      ],
    };
  }

  async function runPipeline(
    task: ResumeTask,
    jobId: string,
    opts: {
      instruction: string | null;
      previous?: ResumeContent;
      parentVersion: number | null;
      signal?: AbortSignal;
      onStage?: StageListener;
    },
  ): Promise<ResumeView> {
    const onStage: StageListener = opts.onStage ?? (() => undefined);
    const job = requireJob(jobId);
    const inputs = await loadInputs();
    const m = inputs.profile;
    if (m.experience.length + m.projects.length + m.skills.length === 0)
      throw new UserError('Your profile has no skills or experience yet. Fill it in first.');
    requireRealProfile(m);
    const jd = JdSchema.safeParse(job.structuredJson).data ?? null;
    const latest = latestAnalysis(db, jobId);
    const analysis = latest ? (AnalysisResultSchema.safeParse(latest.resultJson).data ?? null) : null;
    const approved = approvedSkillsForJob(db, jobId);
    const removed = removedSkillsForJob(db, jobId);
    // The user removed these for this job: never offered to the model, and stripped if it adds them anyway.
    const dropRemoved = (c: ResumeContent): ResumeContent =>
      removed.reduce((acc, skill) => withoutSkill(acc, resolveSkill(skill, m).key, m), c);
    const config = settings.forTask(task);
    const base = {
      task,
      profile: withoutExcluded(m),
      jd,
      descriptionMd: job.descriptionMd,
      analysis,
      resumeRules: inputs.resumeRulesText,
      skillsPolicy: inputs.policyText,
      allowedSkills: allowedSkills(inputs.profile, inputs.policy, jd, approved, removed),
      instruction: opts.instruction,
      config,
      signal: opts.signal,
    };

    onStage('drafting');
    const { best, model } = await draftWithRepair<ResumeContent, Evaluated>({
      db,
      jobId,
      model: config.model,
      onStage,
      run: (repair) =>
        runResumeTask(runner, {
          ...base,
          previous: repair?.previous ?? opts.previous,
          repairIssues: repair?.issues,
        }),
      evaluate: (content) => evaluate(dropRemoved(content), jd, inputs, approved, onStage),
    });

    return storeEvaluated(jobId, best, inputs, {
      model,
      promptVersion: `${task}@v1`,
      parentVersion: opts.parentVersion,
      instruction: opts.instruction,
    });
  }

  /** Stores a checked draft as the next version, with its PDF. */
  async function storeEvaluated(
    jobId: string,
    best: Evaluated,
    inputs: Inputs,
    meta: {
      model: string | null;
      promptVersion: string | null;
      parentVersion: number | null;
      instruction: string | null;
    },
  ): Promise<ResumeView> {
    const row = insertDocumentVersion(db, {
      jobId,
      kind: 'resume',
      tex: best.tex,
      profileHash: inputs.profileHash,
      rulesHash: inputs.rulesHash,
      templateHash: inputs.templateHash,
      model: meta.model,
      promptVersion: meta.promptVersion,
      truthReportJson: { content: best.content, truth: best.checks.truth },
      atsReportJson: {
        ats: best.checks.ats,
        lint: best.checks.lint,
        compile: best.checks.compile,
        parentVersion: meta.parentVersion,
        instruction: meta.instruction,
        changeLog: best.content.change_log,
      },
      userEdited: false,
    });
    await storePdf(row, best.pdf);
    return view(requireVersion(jobId, row.version));
  }

  function toDocument(row: DocumentRow): ResumeDocument {
    const truth = StoredTruth.safeParse(row.truthReportJson).data ?? { content: null, truth: null };
    const checks = StoredChecks.parse(row.atsReportJson);
    return {
      content: truth.content,
      tex: row.tex,
      checks: { truth: truth.truth, ats: checks.ats, lint: checks.lint, compile: checks.compile },
      meta: {
        profileHash: row.profileHash ?? '',
        rulesHash: row.rulesHash ?? '',
        templateHash: row.templateHash ?? '',
        model: row.model,
        promptVersion: row.promptVersion,
        jobId: row.jobId,
        version: row.version,
        createdAt: row.createdAt,
        parentVersion: checks.parentVersion,
        instruction: checks.instruction,
        userEdited: row.userEdited,
        isFinal: row.isFinal,
      },
    };
  }

  async function view(row: DocumentRow): Promise<ResumeView> {
    const pdf = await readPdf(row);
    return { ...toDocument(row), ...(pdf ? { pdfBase64: pdf.toString('base64') } : {}) };
  }

  /** Current input hashes, or null when something cannot be read (then nothing is marked stale). */
  async function currentHashes(): Promise<Pick<Inputs, 'profileHash' | 'rulesHash' | 'templateHash'> | null> {
    try {
      const i = await loadInputs();
      return { profileHash: i.profileHash, rulesHash: i.rulesHash, templateHash: i.templateHash };
    } catch {
      return null;
    }
  }

  async function list(jobId: string): Promise<ResumeVersionSummary[]> {
    requireJob(jobId);
    const now = await currentHashes();
    return listDocumentVersions(db, jobId, 'resume').map((row) => {
      const d = toDocument(row);
      const t = d.checks.truth;
      return {
        meta: d.meta,
        truthOk: t ? t.ok : null,
        truthViolations: t?.violations.length ?? 0,
        atsScore: d.checks.ats.score,
        lintErrors: d.checks.lint.issues.filter((i) => i.severity === 'error').length,
        pages: d.checks.compile?.pages ?? null,
        compileOk: d.checks.compile?.ok ?? null,
        stale:
          now !== null &&
          (now.profileHash !== d.meta.profileHash ||
            now.rulesHash !== d.meta.rulesHash ||
            now.templateHash !== d.meta.templateHash),
      };
    });
  }

  return {
    generate(
      jobId: string,
      opts: { instruction?: string | null; signal?: AbortSignal; onStage?: StageListener } = {},
    ): Promise<ResumeView> {
      return runPipeline('resume.generate', jobId, {
        instruction: opts.instruction?.trim() || null,
        parentVersion: null,
        signal: opts.signal,
        onStage: opts.onStage,
      });
    },

    async revise(
      jobId: string,
      fromVersion: number,
      instruction: string,
      opts: { signal?: AbortSignal; onStage?: StageListener } = {},
    ): Promise<ResumeView> {
      const from = toDocument(requireVersion(jobId, fromVersion));
      if (!from.content)
        throw new UserError(
          `Version ${String(fromVersion)} is a manual edit. Revise works on drafted versions; edit the LaTeX directly instead.`,
        );
      return runPipeline('resume.revise', jobId, {
        instruction: instruction.trim(),
        previous: from.content,
        parentVersion: fromVersion,
        ...opts,
      });
    },

    list,

    async get(jobId: string, version: number): Promise<ResumeView> {
      return view(requireVersion(jobId, version));
    },

    /** A hand-edited tex becomes a new version: lint + ATS re-run, truth not applied (flagged in the UI). */
    async saveManual(jobId: string, fromVersion: number, tex: string): Promise<ResumeView> {
      const parent = requireVersion(jobId, fromVersion);
      const job = requireJob(jobId);
      const inputs = await loadInputs();
      const jd = JdSchema.safeParse(job.structuredJson).data ?? null;
      // compileTex runs the static pre-check first; its errors come back as compile errors.
      const compiled = await compile(tex);
      const row = insertDocumentVersion(db, {
        jobId,
        kind: 'resume',
        tex,
        profileHash: parent.profileHash,
        rulesHash: parent.rulesHash,
        templateHash: parent.templateHash,
        model: null,
        promptVersion: null,
        truthReportJson: { content: null, truth: null },
        atsReportJson: {
          ats: await atsFor(tex, jd, inputs, compiled?.pdf ?? null),
          lint: lintResume(tex, inputs.rules),
          compile: compiled?.summary ?? null,
          parentVersion: fromVersion,
          instruction: null,
          changeLog: ['Manually edited LaTeX'],
        },
        userEdited: true,
      });
      await storePdf(row, compiled?.pdf ?? null);
      return view(requireVersion(jobId, row.version));
    },

    /**
     * A change to the structured content without AI (skill decisions, docs/07 §3): the edit is applied to the
     * parent's content, then it goes through the same render → truth → lint → compile → ATS path as a draft
     * and is stored as the next version. This job's approved skills count for the truth check.
     */
    async editContent(
      jobId: string,
      fromVersion: number,
      edit: (content: ResumeContent) => ResumeContent,
      changeLog: string,
    ): Promise<ResumeView> {
      const parent = requireVersion(jobId, fromVersion);
      const base = toDocument(parent).content;
      if (!base)
        throw new UserError(
          `Version ${String(fromVersion)} is a manual edit. Skill decisions work on drafted versions.`,
        );
      const inputs = await loadInputs();
      const jd = JdSchema.safeParse(requireJob(jobId).structuredJson).data ?? null;
      const best = await evaluate(
        { ...edit(base), change_log: [changeLog] },
        jd,
        inputs,
        approvedSkillsForJob(db, jobId),
        () => undefined,
      );
      return storeEvaluated(jobId, best, inputs, {
        model: parent.model,
        promptVersion: parent.promptVersion,
        parentVersion: fromVersion,
        instruction: null,
      });
    },

    /** Re-compiles a stored version (e.g. after installing the engine); updates compile and ATS. */
    async compile(jobId: string, version: number): Promise<ResumeView> {
      const row = requireVersion(jobId, version);
      const compiled = await compile(row.tex);
      if (!compiled) throw new UserError('No LaTeX engine found. Install Tectonic in Settings → LaTeX.');
      const inputs = await loadInputs();
      const jd = JdSchema.safeParse(requireJob(jobId).structuredJson).data ?? null;
      const stored = StoredChecks.parse(row.atsReportJson);
      updateDocument(db, row.id, {
        atsReportJson: {
          ...stored,
          ats: await atsFor(row.tex, jd, inputs, compiled.pdf),
          compile: compiled.summary,
        },
      });
      await storePdf(requireVersion(jobId, version), compiled.pdf);
      return view(requireVersion(jobId, version));
    },

    async markFinal(jobId: string, version: number): Promise<ResumeVersionSummary[]> {
      if (!setFinalVersion(db, jobId, 'resume', version))
        throw new UserError(`Resume version ${String(version)} does not exist.`);
      return list(jobId);
    },

    /** Writes the .tex or the compiled PDF where the user picks. File name rule: Firstname_Lastname_Resume_<Company>. */
    async export(jobId: string, version: number, format: 'tex' | 'pdf', pick: PickSavePath) {
      return files.export(requireVersion(jobId, version), 'Resume', format, pick);
    },

    openOverleaf(jobId: string, version: number, open: (url: string) => Promise<void>) {
      return files.openOverleaf(requireVersion(jobId, version), open);
    },

    dispose: () => {
      files.dispose();
    },
  };
}

export type DocumentsService = ReturnType<typeof createDocumentsService>;
