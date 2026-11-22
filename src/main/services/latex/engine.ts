import { execFile } from 'node:child_process';
import { delimiter, join } from 'node:path';

export interface Engine {
  kind: 'tectonic';
  path: string;
  version: string;
}

function probe(path: string): Promise<Engine | null> {
  return new Promise((resolve) => {
    execFile(path, ['--version'], { timeout: 10_000 }, (err, stdout) => {
      const m = err ? null : /Tectonic\s+(\S+)/i.exec(stdout);
      resolve(m ? { kind: 'tectonic', path, version: m[1] ?? '' } : null);
    });
  });
}

export interface DetectOptions {
  /** Path from Settings → LaTeX. */
  override?: string;
  /** Electron userData; the installer puts the binary in `<userData>/bin`. */
  userDataDir?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Finds a working Tectonic: STELLIO_TECTONIC_BIN (tests), settings override, `<userData>/bin/tectonic`, PATH.
 * Each candidate must answer `--version`, so a stale or non-executable file is skipped.
 */
export async function detectEngine(opts: DetectOptions = {}): Promise<Engine | null> {
  const env = opts.env ?? process.env;
  const candidates = [
    env.STELLIO_TECTONIC_BIN,
    opts.override,
    opts.userDataDir ? join(opts.userDataDir, 'bin', 'tectonic') : undefined,
    ...(env.PATH ?? '')
      .split(delimiter)
      .filter(Boolean)
      .map((d) => join(d, 'tectonic')),
  ].filter((c): c is string => !!c);
  for (const path of new Set(candidates)) {
    const engine = await probe(path);
    if (engine) return engine;
  }
  return null;
}
