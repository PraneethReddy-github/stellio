import { join } from 'node:path';
import { pruneAiLogs } from './ai/logs';
import { createClaudeRunner, type ClaudeRunner } from './ai/runner';
import { dailyBackupIfDue, prepareDatabase, type Db } from './db/database';
import { markStaleRuns } from './db/repos/aiRuns';
import type { Logger } from './platform/logger';
import type { AppPaths } from './platform/paths';
import { createDbRecorder } from './services/ai/recorder';
import { initDataFolder } from './services/datafolder/init';
import { watchDataFolder } from './services/datafolder/watch';
import { createRunsService, type RunsService } from './services/ai/runs';
import {
  createDocumentsService,
  sweepOverleafForms,
  type DocumentsService,
} from './services/documents/service';
import { createCoverService, type CoverService } from './services/documents/cover';
import { createJobsService, type JobsService } from './services/jobs/service';
import { createSkillsService, type SkillsService } from './services/skills/service';
import { createLearningService, type LearningService } from './services/skills/learning';
import { createInsightsService, type InsightsService } from './services/insights/service';
import { createTaskRegistry, type TaskRegistry } from './services/tasks/registry';
import { createAiSettings, type AiSettingsService } from './services/settings/ai';
import {
  createNotificationSettings,
  type NotificationSettingsService,
} from './services/settings/notifications';
import { createUpdatesService, type UpdatesDeps, type UpdatesService } from './services/updates/service';
import { createSetupSettings, type SetupSettingsService } from './services/settings/setup';
import { createBackupsService, type BackupsService } from './services/backups/service';
import { createLatexService, type LatexService } from './services/latex/service';
import { createProfileService, type ProfileService } from './services/profile/service';
import { createRulesService, type RulesService } from './services/rules/service';
// --- D1 discovery
import { createDiscoveryService, type DiscoveryService } from './services/discovery/service';
import { createKeyStore, type SecretCrypto } from './services/discovery/keystore';
import { createDiscoveryState } from './services/discovery/state';
import { scanCommand as defaultScanCommand } from './services/discovery/systemd';
// --- end D1
// --- T1 tracker
import { createDigest, type Digest, type Notice } from './services/tracker/digest';
import { createTrackerService, type TrackerService } from './services/tracker/service';
// --- end T1
import { createReferralsService, type ReferralsService } from './services/referrals/service';

const NO_CRYPTO: SecretCrypto = {
  isEncryptionAvailable: () => false,
  encryptString: () => Buffer.alloc(0),
  decryptString: () => '',
};

export interface AppContext {
  paths: AppPaths;
  logger: Logger;
  db: Db;
  /** False when `git` is not installed: the app works, but without history/undo. */
  gitAvailable: boolean;
  runner: ClaudeRunner;
  profile: ProfileService;
  rules: RulesService;
  latex: LatexService;
  aiSettings: AiSettingsService;
  notificationSettings: NotificationSettingsService;
  setup: SetupSettingsService;
  updates: UpdatesService;
  backups: BackupsService;
  jobs: JobsService;
  documents: DocumentsService;
  skills: SkillsService;
  learning: LearningService;
  insights: InsightsService;
  // --- C1 cover letter
  cover: CoverService;
  // --- end C1
  // --- T1 tracker
  tracker: TrackerService;
  /** Daily follow-up notification; `start()` it once the app is up. */
  digest: Digest;
  // --- end T1
  // --- D1 discovery
  discovery: DiscoveryService;
  // --- end D1
  referrals: ReferralsService;
  runs: RunsService;
  tasks: TaskRegistry;
  /** Stops watchers and closes the DB. */
  dispose(): void;
}

export interface BootstrapHooks {
  /** Called when a watched data file changes outside the app. */
  onExternalChange(relPath: string): void;
  /** A Claude run hit the subscription usage limit. */
  onUsageLimit(info: { message: string }): void;
  /** This version, how it was installed, and whether (and where) to look for a newer one. */
  updates: Pick<UpdatesDeps, 'current' | 'autoAllowed' | 'install' | 'apiUrl' | 'downloadsUrl'>;
  // --- T1 tracker
  /** Shows a desktop notification (the daily follow-up digest). */
  notify(notice: Notice): void;
  // --- end T1
  // --- D1 discovery
  /** OS keyring wrapper (Electron `safeStorage`); without it API keys cannot be saved. */
  secretCrypto?: SecretCrypto;
  /** What the systemd timer runs: this app with `--scan`. */
  scanCommand?: () => string[];
  // --- end D1
}

/**
 * Startup order matters: data folder first (creates .stellio/), then DB (migrations run before any window opens).
 * Throws on failure; the caller shows the error and quits without touching data further.
 */
export async function bootstrap(paths: AppPaths, logger: Logger, hooks: BootstrapHooks): Promise<AppContext> {
  const { created, gitAvailable, gitError } = await initDataFolder(paths.dataDir, paths.seedDir);
  if (created.length > 0) logger.info('datafolder.created', { dataDir: paths.dataDir, created });
  if (!gitAvailable) logger.warn('datafolder.git_unavailable', { error: gitError ?? 'git not installed' });

  const stellioDir = join(paths.dataDir, '.stellio');
  const backupsDir = join(stellioDir, 'backups');
  const db = prepareDatabase(join(stellioDir, 'stellio.db'), backupsDir);
  try {
    const backup = dailyBackupIfDue(db.sqlite, backupsDir);
    if (backup) logger.info('db.backup', { file: backup });
  } catch (err) {
    // A failed backup must not block the app; it is retried next start.
    logger.error('db.backup_failed', { error: err instanceof Error ? err.message : String(err) });
  }

  const stale = markStaleRuns(db);
  if (stale > 0) logger.warn('ai.stale_runs_marked', { count: stale });
  const aiLogDir = join(stellioDir, 'logs', 'ai');
  try {
    const pruned = await pruneAiLogs(aiLogDir);
    if (pruned > 0) logger.info('ai.logs_pruned', { count: pruned });
  } catch (err) {
    logger.warn('ai.logs_prune_failed', { error: err instanceof Error ? err.message : String(err) });
  }

  const aiSettings = createAiSettings(db);
  const notificationSettings = createNotificationSettings(db);
  const setup = createSetupSettings(db);
  const updates = createUpdatesService({
    db,
    logger,
    workDir: join(paths.userData, 'updates'),
    ...hooks.updates,
  });
  const backups = createBackupsService({ db, dbFile: join(stellioDir, 'stellio.db'), backupsDir });
  const runner = createClaudeRunner({
    cwd: paths.aiCwd,
    logger,
    recorder: createDbRecorder(db, (info) => hooks.onUsageLimit(info)),
    logDir: aiLogDir,
    concurrency: () => aiSettings.get().concurrency,
  });
  const profile = createProfileService({
    dataDir: paths.dataDir,
    gitAvailable,
    runner,
    importConfig: () => aiSettings.forTask('profile.import'),
  });

  const rules = createRulesService({ dataDir: paths.dataDir, seedDir: paths.seedDir, gitAvailable });
  const latex = createLatexService({
    userDataDir: paths.userData,
    dataDir: paths.dataDir,
    seedDir: paths.seedDir,
  });

  const jobs = createJobsService({ db, runner, settings: aiSettings, profile });
  const documents = createDocumentsService({
    db,
    runner,
    settings: aiSettings,
    profile,
    rules,
    latex,
    dataDir: paths.dataDir,
  });
  const skills = createSkillsService({ db, runner, settings: aiSettings, profile, rules, documents });
  const learning = createLearningService({ db, runner, settings: aiSettings, profile });
  const insights = createInsightsService({ db, runner, settings: aiSettings, learning });
  // --- C1 cover letter
  const cover = createCoverService({
    db,
    runner,
    settings: aiSettings,
    profile,
    rules,
    latex,
    dataDir: paths.dataDir,
  });
  // --- end C1
  // --- T1 tracker
  const tracker = createTrackerService({
    db,
    dataDir: paths.dataDir,
    gitAvailable,
    gaps: () => skills.gaps('90d'),
    nudges: () => learning.nudges(),
  });
  const digest = createDigest({
    db,
    tracker,
    settings: () => notificationSettings.get(),
    notify: (n) => hooks.notify(n),
    onError: (err) =>
      logger.warn('tracker.digest_failed', { error: err instanceof Error ? err.message : String(err) }),
  });
  // --- end T1
  // --- D1 discovery
  const discovery = createDiscoveryService({
    db,
    runner,
    settings: aiSettings,
    profile,
    jobs,
    logger,
    state: createDiscoveryState(db),
    keys: createKeyStore(join(paths.userData, 'secrets'), hooks.secretCrypto ?? NO_CRYPTO),
    scanCommand:
      hooks.scanCommand ??
      (() => defaultScanCommand({ packaged: false, execPath: process.execPath, appPath: '.' })),
    notify: (n) => {
      if (notificationSettings.get().scanEnabled) hooks.notify(n);
    },
    onError: (err) =>
      logger.warn('discovery.scheduled_scan_failed', {
        error: err instanceof Error ? err.message : String(err),
      }),
  });
  // --- end D1
  const referrals = createReferralsService({
    db,
    runner,
    settings: aiSettings,
    profile,
    rules,
    aiLogDir,
    onError: (err) =>
      logger.warn('referrals.purge_failed', { error: err instanceof Error ? err.message : String(err) }),
  });
  const runs = createRunsService(db, aiLogDir);
  // Overleaf hand-off forms left behind by a crash (they hold the resume source).
  void sweepOverleafForms().catch((err: unknown) => {
    logger.warn('documents.overleaf_sweep_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  const stopWatching = watchDataFolder(paths.dataDir, (relPath) => {
    logger.info('datafolder.external_change', { relPath });
    hooks.onExternalChange(relPath);
  });

  return {
    paths,
    logger,
    db,
    gitAvailable,
    runner,
    profile,
    rules,
    latex,
    aiSettings,
    notificationSettings,
    setup,
    updates,
    backups,
    jobs,
    documents,
    skills,
    learning,
    insights,
    cover,
    // --- T1 tracker
    tracker,
    digest,
    // --- end T1
    // --- D1 discovery
    discovery,
    // --- end D1
    referrals,
    runs,
    tasks: createTaskRegistry(),
    dispose: () => {
      stopWatching();
      digest.stop();
      referrals.stop();
      discovery.scheduler.stop();
      documents.dispose();
      cover.dispose();
      db.sqlite.close();
    },
  };
}
