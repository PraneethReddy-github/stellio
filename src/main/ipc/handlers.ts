import { basename, join } from 'node:path';
import { app, BrowserWindow, dialog, shell } from 'electron';
import { checkClaude } from '../ai/preflight';
import type { AppContext } from '../bootstrap';
import type { IpcEventName, IpcEvents } from '@shared/ipc/contract';
import { InboxInputSchema } from '@shared/discovery/schemas';
import { UserError, type IpcHandlers } from './dispatch';

/** Relaunches the app (E2E only quits: the test starts it again on the same data folder). */
function restartApp(): void {
  if (process.env.STELLIO_E2E !== '1') {
    app.relaunch(process.env.APPIMAGE ? { execPath: process.env.APPIMAGE, args: [] } : undefined);
  }
  app.quit();
}

export function createHandlers(
  ctx: AppContext,
  emit: <E extends IpcEventName>(event: E, payload: IpcEvents[E]) => void,
): IpcHandlers {
  // A status check spawns a real (tiny) Claude run: share one in-flight check and cache it for 5 minutes.
  let aiStatus: { at: number; result: ReturnType<typeof checkClaude> } | undefined;
  const getAiStatus = (): ReturnType<typeof checkClaude> => {
    if (!aiStatus || Date.now() - aiStatus.at > 5 * 60_000) {
      aiStatus = {
        at: Date.now(),
        result: checkClaude(process.env.STELLIO_CLAUDE_BIN ?? 'claude', { cwd: ctx.paths.aiCwd }),
      };
    }
    return aiStatus.result;
  };

  return {
    'app:getInfo': () => ({
      name: app.getName(),
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
      dataDir: ctx.paths.dataDir,
      gitAvailable: ctx.gitAvailable,
    }),
    'app:ping': ({ message }) => ({ echo: message, at: new Date().toISOString() }),
    'ai:status': () => getAiStatus(),

    'profile:get': () => ctx.profile.get(),
    'profile:save': ({ markdown, expectedHash, message }) =>
      ctx.profile.save(markdown, expectedHash, message ?? 'profile: edit'),
    'profile:history': ({ limit }) => ctx.profile.history(limit),
    'profile:changes': async ({ hash }) => ({ diff: await ctx.profile.changesIn(hash) }),
    'profile:revert': ({ hash }) => ctx.profile.revert(hash),
    'profile:importFromFile': async () => {
      const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      const options = {
        title: 'Import an existing resume',
        properties: ['openFile' as const],
        filters: [{ name: 'Resume', extensions: ['pdf', 'tex', 'txt', 'md'] }],
      };
      const picked = parent
        ? await dialog.showOpenDialog(parent, options)
        : await dialog.showOpenDialog(options);
      const file = picked.filePaths[0];
      if (picked.canceled || !file) return { status: 'cancelled' as const };
      const draft = await ctx.profile.importDraft(file);
      return { status: 'draft' as const, draft, sourceName: basename(file) };
    },

    'rules:list': () => ctx.rules.list(),
    'rules:get': ({ path }) => ctx.rules.get(path),
    'rules:save': ({ path, content, expectedHash, message }) =>
      ctx.rules.save(path, content, expectedHash, message ?? `${path}: edit`),
    'rules:history': ({ path, limit }) => ctx.rules.history(path, limit),
    'rules:changes': async ({ path, hash }) => ({ diff: await ctx.rules.changesIn(path, hash) }),
    'rules:revert': ({ path, hash }) => ctx.rules.revert(path, hash),
    'rules:resetPreview': ({ path }) => ctx.rules.resetPreview(path),
    'rules:reset': ({ path, expectedHash }) => ctx.rules.reset(path, expectedHash),

    'settings:getAi': () => ctx.aiSettings.get(),
    'settings:setAi': (input) => {
      const saved = ctx.aiSettings.set(input);
      ctx.runner.pump(); // a raised concurrency limit applies to runs already queued
      return saved;
    },

    'notifications:get': () => ctx.notificationSettings.get(),
    'notifications:set': (v) => ctx.notificationSettings.set(v),
    'updates:get': () => ctx.updates.get(),
    'updates:set': (v) => ctx.updates.set(v),
    'updates:status': () => ctx.updates.status(),
    'updates:check': () => ctx.updates.checkNow(),
    'setup:get': () => ctx.setup.get(),
    'setup:set': (v) => ctx.setup.set(v),
    'backups:list': () => ctx.backups.list(),
    'backups:create': () => ctx.backups.create(),
    'backups:restore': ({ name }) => {
      try {
        const { snapshot } = ctx.backups.restore(name);
        return { snapshot, restarting: true as const };
      } finally {
        // The live connection is closed once the swap happened: the app must start again on the restored file.
        if (!ctx.db.sqlite.open) setTimeout(() => restartApp(), 400);
      }
    },
    'backups:openFolder': async () => {
      const failure = await shell.openPath(ctx.backups.dir);
      if (failure) throw new UserError('Could not open the folder.');
      return { path: ctx.backups.dir };
    },

    'jobs:intakeUrl': ({ url, requestId }) =>
      ctx.tasks.run(requestId, (signal) => ctx.jobs.intakeUrl(url, signal)),
    'jobs:intakeText': ({ text, url, requestId }) =>
      ctx.tasks.run(requestId, (signal) => ctx.jobs.intakeText(text, { url }, signal)),
    'jobs:list': (input) => ctx.jobs.list(input),
    'jobs:get': ({ id }) => ctx.jobs.get(id),
    'jobs:analyze': async ({ id, requestId }) => ({
      analysis: await ctx.tasks.run(requestId, (signal) => ctx.jobs.analyze(id, signal)),
    }),
    'jobs:delete': ({ id }) => ({ deleted: ctx.jobs.delete(id) }),
    'jobs:setState': ({ id, state }) => ctx.jobs.setState(id, state),
    'ai:runs': ({ limit }) => ctx.runs.list(limit),
    'ai:run': ({ id }) => ctx.runs.get(id),
    'tasks:cancel': ({ requestId }) => ({ cancelled: ctx.tasks.cancel(requestId) }),

    'resume:generate': ({ jobId, instruction, requestId }) =>
      ctx.tasks.run(requestId, (signal) =>
        ctx.documents.generate(jobId, {
          instruction,
          signal,
          onStage: (stage, issues) => emit('resume:progress', { jobId, requestId, stage, issues }),
        }),
      ),
    'resume:revise': ({ jobId, fromVersion, instruction, requestId }) =>
      ctx.tasks.run(requestId, (signal) =>
        ctx.documents.revise(jobId, fromVersion, instruction, {
          signal,
          onStage: (stage, issues) => emit('resume:progress', { jobId, requestId, stage, issues }),
        }),
      ),
    'resume:list': ({ jobId }) => ctx.documents.list(jobId),
    'resume:get': ({ jobId, version }) => ctx.documents.get(jobId, version),
    'resume:saveManual': ({ jobId, fromVersion, tex }) => ctx.documents.saveManual(jobId, fromVersion, tex),
    'resume:compile': ({ jobId, version }) => ctx.documents.compile(jobId, version),
    'resume:markFinal': ({ jobId, version }) => ctx.documents.markFinal(jobId, version),
    'resume:export': ({ jobId, version, format }) =>
      ctx.documents.export(jobId, version, format, async (name, ext) => {
        const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
        const options = {
          title: ext === 'pdf' ? 'Save resume PDF' : 'Save resume LaTeX',
          defaultPath: join(app.getPath('documents'), `${name}.${ext}`),
          filters: [
            ext === 'pdf' ? { name: 'PDF', extensions: ['pdf'] } : { name: 'LaTeX', extensions: ['tex'] },
          ],
        };
        const picked = parent
          ? await dialog.showSaveDialog(parent, options)
          : await dialog.showSaveDialog(options);
        return picked.canceled || !picked.filePath ? null : picked.filePath;
      }),
    'resume:openOverleaf': ({ jobId, version }) =>
      ctx.documents.openOverleaf(jobId, version, (url) => shell.openExternal(url)),
    'resume:diff': async ({ jobId, a, b }) => ({
      a: (await ctx.documents.get(jobId, a)).tex,
      b: (await ctx.documents.get(jobId, b)).tex,
    }),

    // --- C1 cover letter
    'cover:generate': ({ jobId, instruction, requestId }) =>
      ctx.tasks.run(requestId, (signal) =>
        ctx.cover.generate(jobId, {
          instruction,
          signal,
          onStage: (stage, issues) => emit('cover:progress', { jobId, requestId, stage, issues }),
        }),
      ),
    'cover:revise': ({ jobId, fromVersion, instruction, requestId }) =>
      ctx.tasks.run(requestId, (signal) =>
        ctx.cover.revise(jobId, fromVersion, instruction, {
          signal,
          onStage: (stage, issues) => emit('cover:progress', { jobId, requestId, stage, issues }),
        }),
      ),
    'cover:list': ({ jobId }) => ctx.cover.list(jobId),
    'cover:get': ({ jobId, version }) => ctx.cover.get(jobId, version),
    'cover:saveManual': ({ jobId, fromVersion, tex }) => ctx.cover.saveManual(jobId, fromVersion, tex),
    'cover:compile': ({ jobId, version }) => ctx.cover.compile(jobId, version),
    'cover:markFinal': ({ jobId, version }) => ctx.cover.markFinal(jobId, version),
    'cover:export': ({ jobId, version, format }) =>
      ctx.cover.export(jobId, version, format, async (name, ext) => {
        const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
        const options = {
          title: ext === 'pdf' ? 'Save cover letter PDF' : 'Save cover letter LaTeX',
          defaultPath: join(app.getPath('documents'), `${name}.${ext}`),
          filters: [
            ext === 'pdf' ? { name: 'PDF', extensions: ['pdf'] } : { name: 'LaTeX', extensions: ['tex'] },
          ],
        };
        const picked = parent
          ? await dialog.showSaveDialog(parent, options)
          : await dialog.showSaveDialog(options);
        return picked.canceled || !picked.filePath ? null : picked.filePath;
      }),
    'cover:openOverleaf': ({ jobId, version }) =>
      ctx.cover.openOverleaf(jobId, version, (url) => shell.openExternal(url)),
    'cover:diff': async ({ jobId, a, b }) => ({
      a: (await ctx.cover.get(jobId, a)).tex,
      b: (await ctx.cover.get(jobId, b)).tex,
    }),
    // --- end C1

    // --- T1 tracker
    'apps:create': ({ jobId }) => ctx.tracker.create(jobId),
    'apps:forJob': ({ jobId }) => ctx.tracker.forJob(jobId),
    'apps:setStatus': ({ id, status, meta }) => ctx.tracker.setStatus(id, status, meta),
    'apps:update': ({ id, patch }) => ctx.tracker.update(id, patch),
    'apps:note': ({ id, text, kind }) => ctx.tracker.note(id, text, kind),
    'apps:interview:add': ({ applicationId, ...v }) => ctx.tracker.addInterview(applicationId, v),
    'apps:interview:update': ({ id, patch }) => ctx.tracker.updateInterview(id, patch),
    'apps:interview:delete': ({ id }) => ({ deleted: ctx.tracker.deleteInterview(id) }),
    'apps:contact:add': ({ applicationId, ...v }) => ctx.tracker.addContact(applicationId, v),
    'apps:contact:update': ({ id, patch }) => ctx.tracker.updateContact(id, patch),
    'apps:contact:delete': ({ id }) => ({ deleted: ctx.tracker.deleteContact(id) }),
    'apps:contact:link': ({ applicationId, contactId }) => {
      ctx.tracker.linkContact(applicationId, contactId);
      return { linked: true as const };
    },
    'apps:contact:unlink': ({ applicationId, contactId }) => ({
      unlinked: ctx.tracker.unlinkContact(applicationId, contactId),
    }),
    'apps:contact:list': ({ applicationId }) => ctx.tracker.contacts(applicationId),
    'apps:openFolder': async ({ id }) => {
      const path = ctx.tracker.folderPath(id); // already checked to lie inside the data folder
      const failure = await shell.openPath(path);
      if (failure) throw new UserError('Could not open the folder.');
      return { path };
    },
    'tracker:board': () => ctx.tracker.board(),
    'tracker:table': ({ filters, sort }) => ({ rows: ctx.tracker.table(filters, sort) }),
    'tracker:exportCsv': ({ filters, sort }) =>
      ctx.tracker.exportCsv(filters, sort, async (name) => {
        const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
        const options = {
          title: 'Export applications',
          defaultPath: join(app.getPath('documents'), name),
          filters: [{ name: 'CSV', extensions: ['csv'] }],
        };
        const picked = parent
          ? await dialog.showSaveDialog(parent, options)
          : await dialog.showSaveDialog(options);
        return picked.canceled || !picked.filePath ? null : picked.filePath;
      }),
    'tracker:timeline': ({ from, to }) => ({ items: ctx.tracker.timeline(from, to) }),
    'tracker:get': ({ id }) => ctx.tracker.get(id),
    'today:summary': () => ctx.tracker.today(),
    // --- end T1

    // --- D1 discovery
    'discovery:sources': () => ctx.discovery.sources(),
    'discovery:setSourceEnabled': ({ id, enabled }) => {
      ctx.discovery.setSourceEnabled(id, enabled);
      return ctx.discovery.sources();
    },
    'discovery:setApiKey': ({ appId, appKey }) => {
      ctx.discovery.setApiKey(appId, appKey);
      return { keySet: true };
    },
    'discovery:clearApiKey': () => {
      ctx.discovery.clearApiKey();
      return { keySet: false };
    },
    'discovery:profiles': () => ctx.discovery.profiles(),
    'discovery:saveProfile': ({ id, profile }) => ctx.discovery.saveProfile(id, profile),
    'discovery:deleteProfile': ({ id }) => ({ deleted: ctx.discovery.deleteProfile(id) }),
    'discovery:watchlist': () => ctx.discovery.watchlist(),
    'discovery:watchAdd': ({ url, name, requestId }) =>
      ctx.tasks.run(requestId, (signal) => ctx.discovery.watchAdd(url, name, signal)),
    'discovery:watchRemove': ({ id }) => ({ removed: ctx.discovery.watchRemove(id) }),
    'discovery:scanNow': ({ requestId }) =>
      ctx.tasks.run(requestId, (signal) =>
        ctx.discovery.runScan({
          trigger: 'manual',
          signal,
          onProgress: (p) => emit('discovery:progress', { requestId, ...p }),
        }),
      ),
    'discovery:scanRuns': ({ limit }) => ctx.discovery.scanRuns(limit ?? 20),
    'discovery:schedule': () => ctx.discovery.schedule(),
    'discovery:setSchedule': (v) => ctx.discovery.setSchedule(v),
    'discovery:settings': () => ctx.discovery.settings(),
    'discovery:setSettings': (v) => ctx.discovery.setSettings(v),
    'discovery:timerPreview': () => ctx.discovery.timerPreview(),
    'discovery:timerInstall': async () => {
      await ctx.discovery.timerInstall();
      return ctx.discovery.timerStatus();
    },
    'discovery:timerRemove': async () => {
      await ctx.discovery.timerRemove();
      return ctx.discovery.timerStatus();
    },
    'discovery:timerStatus': () => ctx.discovery.timerStatus(),
    'jobs:inbox': (input) => ctx.discovery.inbox(InboxInputSchema.parse(input)),
    'jobs:dismiss': ({ id, reason }) => {
      ctx.discovery.dismiss(id, reason ?? '');
      return { dismissed: true };
    },
    'jobs:shortlist': ({ id }) => ctx.discovery.shortlist(id),
    // --- end D1

    // --- R1 referrals
    'referrals:search': ({ requestId, ...input }) =>
      ctx.tasks.run(requestId, (signal) =>
        ctx.referrals.search(input, {
          signal,
          onProgress: (stage, count) => emit('referrals:progress', { requestId, stage, count }),
        }),
      ),
    'referrals:due': () => ctx.referrals.due(),
    'referrals:list': ({ jobId }) => ctx.referrals.list(jobId),
    'referrals:person': ({ id }) => ctx.referrals.person(id),
    'referrals:draft': ({ personId, jobId, requestId }) =>
      ctx.tasks.run(requestId, (signal) => ctx.referrals.draft(personId, jobId, { signal })),
    'referrals:setStatus': ({ id, status, note }) => ctx.referrals.setStatus(id, status, note),
    'referrals:delete': async ({ personId }) => ({ deleted: await ctx.referrals.deletePerson(personId) }),
    'referrals:deleteAll': async () => ({ deleted: await ctx.referrals.deleteAll() }),
    'referrals:settings': () => ctx.referrals.settings(),
    'referrals:setSettings': (v) => ctx.referrals.setSettings(v),
    // --- end R1

    'latex:status': () => ctx.latex.status(),
    'latex:install': () => ctx.latex.install((p) => emit('latex:installProgress', p)),
    'latex:warmUp': () => ctx.latex.warm(),
    'latex:compileTemplate': ({ path, content }) => ctx.latex.compileTemplate(path, content),

    // ---- skills engine (phase 6 S1) ----
    'skills:audit': ({ jobId, version, requestId, refresh }) =>
      ctx.tasks.run(requestId, (signal) => ctx.skills.audit(jobId, version, { refresh, signal })),
    'skills:decide': ({ jobId, version, skill, decision, profileRow }) =>
      ctx.skills.decide(jobId, version, skill, decision, profileRow),
    'skills:recordApproval': ({ jobId, skill }) => ctx.skills.recordApproval(jobId, skill),
    'skills:ledger': () => ctx.skills.ledger(),
    'skills:gaps': ({ window }) => ctx.skills.gaps(window),
    'learning:list': () => ctx.skills.listLearning(),
    'learning:add': ({ skill }) => ctx.skills.addLearning(skill),
    'learning:update': ({ id, ...patch }) => ctx.skills.updateLearning(id, patch),

    // ---- insights and learning (phase 9)
    'insights:summary': ({ window }) => ctx.insights.summary(window),
    'insights:ask': ({ question, requestId }) =>
      ctx.tasks.run(requestId, (signal) => ctx.insights.ask(question, signal)),
    'learning:roadmap': () => ctx.learning.roadmap(),
    'learning:whatIf': ({ skills }) => ctx.learning.whatIf(skills),
    'learning:resources': ({ id, requestId }) =>
      ctx.tasks.run(requestId, (signal) => ctx.learning.resources(id, signal)),
    'profile:suggest': ({ requestId }) => ctx.tasks.run(requestId, (signal) => ctx.learning.suggest(signal)),
  };
}
