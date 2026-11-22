import { execFile } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';

/**
 * OS sandbox for Tectonic (docs/06 §7). TeX can read and write any file the process can (`\input{/abs}`,
 * `\openout` to `../x` or `~/.bashrc`), and `--untrusted` does not stop that, so every compile runs under
 * bubblewrap: an empty tmpfs root with only the binary, the package cache and a fresh work dir mounted.
 */
export interface Sandbox {
  kind: 'bwrap';
  path: string;
}

export type SandboxProbe = { ok: true; sandbox: Sandbox } | { ok: false; reason: string };

export const SANDBOX_MISSING_MESSAGE =
  'Secure LaTeX compile needs bubblewrap (bwrap). Install it: sudo apt install bubblewrap';

/** Where Tectonic 0.17 keeps its bundle and format cache: `$XDG_CACHE_HOME/tectonic` (lowercase), verified. */
export function tectonicCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_CACHE_HOME;
  return join(xdg && isAbsolute(xdg) ? xdg : join(homedir(), '.cache'), 'tectonic');
}

export interface SandboxArgs {
  engine: string;
  /** Host dir mounted read-write at /work (cwd, outdir, HOME); null = empty tmpfs (self-test). */
  workDir: string | null;
  /** Host Tectonic cache dir, mounted at /cache/tectonic; null = empty tmpfs (self-test). */
  cacheDir: string | null;
  /** Warm-up only: shares the network, mounts the cache read-write, and adds DNS + CA certificates. */
  network?: boolean;
}

/** bwrap argv up to and including the in-sandbox tectonic path; append tectonic's own args. */
export function bwrapArgs(a: SandboxArgs): string[] {
  const args = ['--unshare-all', '--die-with-parent', '--new-session', '--clearenv', '--tmpfs', '/'];
  args.push('--dev', '/dev', '--proc', '/proc');
  // Tectonic is a static musl binary: no libraries, loader or /etc are needed to run it.
  args.push('--ro-bind', a.engine, '/usr/bin/tectonic');
  if (a.cacheDir === null) args.push('--tmpfs', '/cache/tectonic');
  else args.push(a.network ? '--bind' : '--ro-bind', a.cacheDir, '/cache/tectonic');
  if (a.network) {
    args.push('--share-net', '--ro-bind', '/etc/resolv.conf', '/etc/resolv.conf');
    for (const d of ['/etc/ssl', '/etc/ca-certificates', '/etc/pki', '/usr/share/ca-certificates'])
      args.push('--ro-bind-try', d, d);
  }
  args.push(...(a.workDir === null ? ['--tmpfs', '/work'] : ['--bind', a.workDir, '/work']));
  args.push('--dir', '/work/home', '--chdir', '/work');
  args.push('--setenv', 'HOME', '/work/home', '--setenv', 'XDG_CACHE_HOME', '/cache');
  args.push('/usr/bin/tectonic');
  return args;
}

async function findOnPath(name: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  for (const dir of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const p = join(dir, name);
    if (
      await access(p, constants.X_OK).then(
        () => true,
        () => false,
      )
    )
      return p;
  }
  return null;
}

const ok = new Map<string, Sandbox>();

/**
 * Finds `bwrap` on PATH and checks it can run this engine in the compile profile (user namespaces can be
 * disabled by the kernel or AppArmor). Only a passing self-test is memoized, so installing bwrap needs no restart.
 */
export async function probeSandbox(
  engine: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SandboxProbe> {
  const hit = ok.get(engine);
  if (hit) return { ok: true, sandbox: hit };
  const bwrap = await findOnPath('bwrap', env);
  if (!bwrap) return { ok: false, reason: SANDBOX_MISSING_MESSAGE };
  const args = [...bwrapArgs({ engine, workDir: null, cacheDir: null }), '--version'];
  return new Promise((resolve) => {
    execFile(bwrap, args, { timeout: 10_000 }, (err, stdout, stderr) => {
      if (!err && /Tectonic\s/i.test(stdout)) {
        const sandbox: Sandbox = { kind: 'bwrap', path: bwrap };
        ok.set(engine, sandbox);
        return resolve({ ok: true, sandbox });
      }
      const why = stderr.trim().split('\n')[0] || (err?.message ?? 'no output');
      resolve({
        ok: false,
        reason: `The LaTeX sandbox (bubblewrap) failed its self-test (${why}), so nothing was compiled.`,
      });
    });
  });
}
