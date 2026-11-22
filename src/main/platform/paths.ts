import { homedir } from 'node:os';
import { join } from 'node:path';

export interface AppPaths {
  /** Electron userData: settings.json, app-internal state. */
  userData: string;
  /** User-visible data folder (profile, rules, applications, DB). */
  dataDir: string;
  logsDir: string;
  /** Bundled default profile/rules/templates, copied into dataDir on first run. */
  seedDir: string;
  /** Empty working dir for Claude CLI runs; must be outside any project tree (docs/04 §1). */
  aiCwd: string;
}

export interface PathInputs {
  defaultUserData: string;
  /** App root in dev (repo root); `process.resourcesPath` when packaged. */
  resourcesRoot: string;
}

/**
 * Resolves app paths. `STELLIO_USER_DATA` and `STELLIO_DATA_DIR` override the defaults so
 * tests never touch the real ~/.config/Stellio or ~/Stellio.
 */
export function resolvePaths(
  { defaultUserData, resourcesRoot }: PathInputs,
  env: NodeJS.ProcessEnv = process.env,
): AppPaths {
  const userData = env.STELLIO_USER_DATA || defaultUserData;
  const dataDir = env.STELLIO_DATA_DIR || join(homedir(), 'Stellio');
  return {
    userData,
    dataDir,
    logsDir: join(userData, 'logs'),
    seedDir: join(resourcesRoot, 'seed'),
    aiCwd: join(userData, 'ai-cwd'),
  };
}
