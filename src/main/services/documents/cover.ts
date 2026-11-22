import { z } from 'zod';
import {
  CompileSummarySchema,
  CoverContentSchema,
  LintReportSchema,
  TruthReportSchema,
  checkCoverTruth,
  keptParagraphs,
  lintCover,
  readCover,
  renderCover,
  type CoverContent,
  type CoverChecks,
  type CoverDocument,
  type CoverJob,
  type CoverVersionSummary,
} from '@shared/documents';
import { AnalysisResultSchema, JdSchema, type Jd } from '@shared/jobs/schemas';
import { parseTemplate } from '@shared/latex/template';
import type { Profile } from '@shared/profile';
import { requireRealProfile } from '../profile/guard';
import { lintRules, type CoverLetterRules, type SkillsPolicy } from '@shared/rules';
import type { ClaudeRunner } from '../../ai/runner';
import { runCoverTask, type CoverTask } from '../../ai/tasks/cover';
import type { Db } from '../../db/database';
import {
  approvedSkillsForJob,
  getDocumentVersion,
  insertDocumentVersion,
  listDocumentVersions,
  setFinalVersion,
  updateDocument,
  type DocumentRow,
} from '../../db/repos/documents';
import { getJob, getJobSummary, latestAnalysis } from '../../db/repos/jobs';
import { UserError } from '../../ipc/dispatch';
import { hashText } from '../datafolder/files';
import type { LatexService } from '../latex/service';
import type { ProfileService } from '../profile/service';
import type { RulesService } from '../rules/service';
import type { AiSettingsService } from '../settings/ai';
import {
  allowedSkills,
  createDocFiles,
  draftWithRepair,
  withoutExcluded,
  type PickSavePath,
  type StageListener,
} from './common';

const TEMPLATE = 'templates/cover-letter.tex';

/** What the `*_report_json` columns hold for a cover letter (same layout as the resume, no ATS). */
const StoredTruth = z.object({
  content: CoverContentSchema.nullable(),
  truth: TruthReportSchema.nullable(),
});
const StoredChecks = z.object({
  lint: LintReportSchema,
  compile: CompileSummarySchema.nullable(),
  parentVersion: z.number().int().nullable(),
  instruction: z.string().nullable(),
});

export type CoverView = CoverDocument & { pdfBase64?: string };

export interface CoverServiceDeps {
  db: Db;
  runner: ClaudeRunner;
  settings: AiSettingsService;
  profile: ProfileService;
  rules: RulesService;
  latex: LatexService;
  dataDir: string;
  /** Letter date; tests pin it. */
  now?: () => Date;
}

interface Inputs {
  profile: Profile;
  profileHash: string;
  coverRulesText: string;
  policyText: string;
  rules: CoverLetterRules;
  policy: SkillsPolicy;
  template: string;
  rulesHash: string;
  templateHash: string;
}

interface Evaluated {
  content: CoverContent;
  tex: string;
  checks: CoverChecks;
  pdf: Buffer | null;
  issues: string[];
  /** Lower is better, compared in order: [truth violations, lint errors + page overflow]. */
  rank: [number, number];
}

export function createCoverService(deps: CoverServiceDeps) {
  const { db, runner, settings } = deps;
  const files = createDocFiles(deps);
  const { storePdf, readPdf } = files;
  const compile = (tex: string) => files.compile(tex, TEMPLATE);
  const now = deps.now ?? (() => new Date());

  async function loadInputs(): Promise<Inputs> {
    const snap = await deps.profile.get();
    const [cover, policy, template] = await Promise.all([
      deps.rules.get('rules/cover-letter.md'),
      deps.rules.get('rules/skills-policy.md'),
      deps.rules.get(TEMPLATE),
    ]);
    const rules = lintRules('cover-letter', cover.content).config;
    if (!rules) throw new UserError('rules/cover-letter.md has errors. Fix them in Rules first.');
    const pol = lintRules('skills-policy', policy.content).config;
    if (!pol) throw new UserError('rules/skills-policy.md has errors. Fix them in Rules first.');
    if (parseTemplate(template.content, 'cover-letter').diagnostics.some((d) => d.severity === 'error'))
      throw new UserError('templates/cover-letter.tex has errors. Fix them in Rules first.');
    return {
      profile: snap.model,
      profileHash: snap.hash,
      coverRulesText: cover.content,
      policyText: policy.content,
      rules,
      policy: pol,
      template: template.content,
      rulesHash: hashText(`${cover.hash}\n${policy.hash}`),
      templateHash: template.hash,
    };
  }

  function requireJob(jobId: string) {
    const job = getJob(db, jobId);
    if (!job) throw new UserError('That job no longer exists.');
    return job;
  }

  function requireVersion(jobId: string, version: number): DocumentRow {
    const row = getDocumentVersion(db, jobId, 'cover_letter', version);
    if (!row) throw new UserError(`Cover letter version ${String(version)} does not exist.`);
    return row;
  }

  /** Recipient block data: the structured posting first, the job row as fallback. */
  function jobInfo(jobId: string, jd: Jd | null): CoverJob {
    const s = getJobSummary(db, jobId);
    const place = [jd?.location.city, jd?.location.country].filter(Boolean).join(', ');
    return {
      company: jd?.company ?? s?.company ?? '',
      title: jd?.title ?? s?.title ?? '',
      location: place || s?.locationText || (s?.remote === 'remote' ? 'Remote' : ''),
    };
  }

  /** render → truth → lint → compile; `issues` are the blocking ones the repair round must fix. */
  async function evaluate(
    content: CoverContent,
    ctx: { jd: Jd | null; job: CoverJob; descriptionMd: string; inputs: Inputs; approved: string[] },
    onStage: StageListener,
  ): Promise<Evaluated> {
    const { inputs } = ctx;
    onStage('checking');
    const tex = renderCover(content, inputs.profile, ctx.job, inputs.template, inputs.rules, now());
    const truth = checkCoverTruth(content, inputs.profile, {
      policy: inputs.policy,
      jd: ctx.jd,
      approvedSkills: ctx.approved,
      company: [ctx.descriptionMd, ctx.job.company, ctx.job.title, inputs.profile.notes].join('\n'),
    });
    const lint = lintCover(tex, inputs.rules, ctx.job.company, keptParagraphs(content));
    onStage('compiling');
    const compiled = await compile(tex);
    const issues = [
      ...truth.violations.map((v) => `Truth (${v.kind}) at ${v.path}: "${v.text}" — ${v.detail}`),
      ...lint.issues.map((i) => `Rules (${i.rule})${i.path ? ` at ${i.path}` : ''}: ${i.message}`),
    ];
    const pages = compiled?.summary.pages ?? null;
    const overflow = pages !== null && pages > inputs.rules.page_limit;
    if (overflow)
      issues.push(
        `Length: the letter is ${String(pages)} pages; the limit is ${String(inputs.rules.page_limit)}. Shorten it.`,
      );
    return {
      content,
      tex,
      checks: { truth, lint, compile: compiled?.summary ?? null },
      pdf: compiled?.pdf ?? null,
      issues,
      rank: [truth.violations.length, lint.issues.length + (overflow ? 1 : 0)],
    };
  }

  async function runPipeline(
    task: CoverTask,
    jobId: string,
    opts: {
      instruction: string | null;
      previous?: CoverContent;
      parentVersion: number | null;
      signal?: AbortSignal;
      onStage?: StageListener;
    },
  ): Promise<CoverView> {
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
    const config = settings.forTask(task);
    const ctx = { jd, job: jobInfo(jobId, jd), descriptionMd: job.descriptionMd, inputs, approved };
    const base = {
      task,
      profile: withoutExcluded(m),
      jd,
      descriptionMd: job.descriptionMd,
      analysis,
      coverRules: inputs.coverRulesText,
      skillsPolicy: inputs.policyText,
      allowedSkills: allowedSkills(m, inputs.policy, jd, approved),
      instruction: opts.instruction,
      config,
      signal: opts.signal,
    };

    onStage('drafting');
    const { best, model } = await draftWithRepair<CoverContent, Evaluated>({
      db,
      jobId,
      model: config.model,
      onStage,
      run: (repair) =>
        runCoverTask(runner, {
          ...base,
          previous: repair?.previous ?? opts.previous,
          repairIssues: repair?.issues,
        }),
      evaluate: (content) => evaluate(content, ctx, onStage),
    });

    const row = insertDocumentVersion(db, {
      jobId,
      kind: 'cover_letter',
      tex: best.tex,
      profileHash: inputs.profileHash,
      rulesHash: inputs.rulesHash,
      templateHash: inputs.templateHash,
      model,
      promptVersion: `${task}@v1`,
      truthReportJson: { content: best.content, truth: best.checks.truth },
      atsReportJson: {
        lint: best.checks.lint,
        compile: best.checks.compile,
        parentVersion: opts.parentVersion,
        instruction: opts.instruction,
      },
      userEdited: false,
    });
    await storePdf(row, best.pdf);
    return view(requireVersion(jobId, row.version));
  }

  function toDocument(row: DocumentRow): CoverDocument {
    const truth = StoredTruth.safeParse(row.truthReportJson).data ?? { content: null, truth: null };
    const checks = StoredChecks.parse(row.atsReportJson);
    return {
      content: truth.content,
      tex: row.tex,
      checks: { truth: truth.truth, lint: checks.lint, compile: checks.compile },
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

  async function view(row: DocumentRow): Promise<CoverView> {
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

  async function list(jobId: string): Promise<CoverVersionSummary[]> {
    requireJob(jobId);
    const now = await currentHashes();
    return listDocumentVersions(db, jobId, 'cover_letter').map((row) => {
      const d = toDocument(row);
      const t = d.checks.truth;
      return {
        meta: d.meta,
        truthOk: t ? t.ok : null,
        truthViolations: t?.violations.length ?? 0,
        lintErrors: d.checks.lint.issues.filter((i) => i.severity === 'error').length,
        words: readCover(row.tex).words,
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

  /** Company name the lint counts mentions of, for a stored version's job. */
  function companyOf(jobId: string): string {
    return jobInfo(jobId, JdSchema.safeParse(requireJob(jobId).structuredJson).data ?? null).company;
  }

  return {
    generate(
      jobId: string,
      opts: { instruction?: string | null; signal?: AbortSignal; onStage?: StageListener } = {},
    ): Promise<CoverView> {
      return runPipeline('cover.generate', jobId, {
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
    ): Promise<CoverView> {
      const from = toDocument(requireVersion(jobId, fromVersion));
      if (!from.content)
        throw new UserError(
          `Version ${String(fromVersion)} is a manual edit. Revise works on drafted versions; edit the LaTeX directly instead.`,
        );
      return runPipeline('cover.revise', jobId, {
        instruction: instruction.trim(),
        previous: from.content,
        parentVersion: fromVersion,
        ...opts,
      });
    },

    list,

    async get(jobId: string, version: number): Promise<CoverView> {
      return view(requireVersion(jobId, version));
    },

    /** A hand-edited tex becomes a new version: lint re-runs, truth not applied (flagged in the UI). */
    async saveManual(jobId: string, fromVersion: number, tex: string): Promise<CoverView> {
      const parent = requireVersion(jobId, fromVersion);
      const inputs = await loadInputs();
      // compile runs the static pre-check first; its errors come back as compile errors.
      const compiled = await compile(tex);
      const row = insertDocumentVersion(db, {
        jobId,
        kind: 'cover_letter',
        tex,
        profileHash: parent.profileHash,
        rulesHash: parent.rulesHash,
        templateHash: parent.templateHash,
        model: null,
        promptVersion: null,
        truthReportJson: { content: null, truth: null },
        atsReportJson: {
          lint: lintCover(tex, inputs.rules, companyOf(jobId)),
          compile: compiled?.summary ?? null,
          parentVersion: fromVersion,
          instruction: null,
        },
        userEdited: true,
      });
      await storePdf(row, compiled?.pdf ?? null);
      return view(requireVersion(jobId, row.version));
    },

    /** Re-compiles a stored version (e.g. after installing the engine). */
    async compile(jobId: string, version: number): Promise<CoverView> {
      const row = requireVersion(jobId, version);
      const compiled = await compile(row.tex);
      if (!compiled) throw new UserError('No LaTeX engine found. Install Tectonic in Settings → LaTeX.');
      updateDocument(db, row.id, {
        atsReportJson: { ...StoredChecks.parse(row.atsReportJson), compile: compiled.summary },
      });
      await storePdf(requireVersion(jobId, version), compiled.pdf);
      return view(requireVersion(jobId, version));
    },

    async markFinal(jobId: string, version: number): Promise<CoverVersionSummary[]> {
      if (!setFinalVersion(db, jobId, 'cover_letter', version))
        throw new UserError(`Cover letter version ${String(version)} does not exist.`);
      return list(jobId);
    },

    /** File name rule: Firstname_Lastname_CoverLetter_<Company>. */
    export(jobId: string, version: number, format: 'tex' | 'pdf', pick: PickSavePath) {
      return files.export(requireVersion(jobId, version), 'CoverLetter', format, pick);
    },

    openOverleaf(jobId: string, version: number, open: (url: string) => Promise<void>) {
      return files.openOverleaf(requireVersion(jobId, version), open);
    },

    dispose: () => {
      files.dispose();
    },
  };
}

export type CoverService = ReturnType<typeof createCoverService>;
