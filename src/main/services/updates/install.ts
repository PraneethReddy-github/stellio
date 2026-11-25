import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { chmod, mkdir, rename, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { UpdateProgress } from '@shared/settings/updates';
import { UserError } from '../../ipc/dispatch';

/** How this copy of Stellio was installed: that decides how it can be replaced. */
export type InstallKind = { kind: 'deb' } | { kind: 'appimage'; file: string } | { kind: 'manual' };

export function detectInstall(
  env: NodeJS.ProcessEnv,
  execPath: string,
  exists: (p: string) => boolean = existsSync,
): InstallKind {
  if (env.APPIMAGE && exists(env.APPIMAGE)) return { kind: 'appimage', file: env.APPIMAGE };
  if (
    execPath.startsWith('/opt/Stellio/') &&
    exists('/var/lib/dpkg/info/stellio.list') &&
    exists('/usr/bin/pkexec') &&
    exists('/usr/bin/apt-get')
  )
    return { kind: 'deb' };
  return { kind: 'manual' };
}

/** The release file for an install kind (x86_64 only: nothing else is built). */
export const assetName = (kind: InstallKind['kind'], version: string): string | null =>
  kind === 'deb'
    ? `Stellio-${version}-amd64.deb`
    : kind === 'appimage'
      ? `Stellio-${version}-x86_64.AppImage`
      : null;

export interface Download {
  url: string;
  sha256: string;
  size: number;
}
export interface InstallDeps {
  fetchFn: typeof fetch;
  onProgress: (p: UpdateProgress) => void;
  signal: AbortSignal;
  /** No data for this long = give up. */
  stallMs?: number;
}

async function hashFile(file: string): Promise<string> {
  const h = createHash('sha256');
  await pipeline(createReadStream(file), h);
  return h.digest('hex');
}

/** Streams `d` to `dest`; the file is removed unless its size and SHA-256 are exactly as published. */
export async function downloadVerified(d: Download, dest: string, o: InstallDeps): Promise<void> {
  const stall = new AbortController();
  const signal = AbortSignal.any([o.signal, stall.signal]);
  let timer: NodeJS.Timeout | undefined;
  const alive = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => stall.abort(), o.stallMs ?? 60_000);
  };
  let received = 0;
  let lastShown = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      alive();
      received += chunk.length;
      if (received > d.size) return cb(new Error('more data than published'));
      if (received - lastShown > 500_000 || received === d.size) {
        lastShown = received;
        o.onProgress({ phase: 'download', received, total: d.size });
      }
      cb(null, chunk);
    },
  });
  try {
    alive();
    o.onProgress({ phase: 'download', received: 0, total: d.size });
    const res = await o.fetchFn(d.url, { headers: { 'User-Agent': 'Stellio' }, signal });
    if (!res.ok || !res.body) throw new Error(`the server answered ${String(res.status)}`);
    await pipeline(Readable.fromWeb(res.body), meter, createWriteStream(dest, { mode: 0o600 }), { signal });
    o.onProgress({ phase: 'verify', received, total: d.size });
    if (received !== d.size || (await hashFile(dest)) !== d.sha256)
      throw new UserError(
        'The download does not match the published checksum, so it was discarded. Nothing was installed.',
      );
  } catch (e) {
    await rm(dest, { force: true });
    if (o.signal.aborted) throw new UserError('Update cancelled.');
    if (e instanceof UserError) throw e;
    throw new UserError(
      `Could not download the update (${stall.signal.aborted ? 'the connection stalled' : e instanceof Error ? e.message : String(e)}). Nothing was installed.`,
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Runs a program without a shell; resolves with its exit code and the end of its output. */
export type RunProgram = (file: string, args: string[]) => Promise<{ code: number | null; output: string }>;
const run: RunProgram = (file, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const add = (b: Buffer): void => {
      output = (output + b.toString('utf8')).slice(-4000);
    };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output }));
  });

/** The system asks for the password (polkit); apt also resolves new dependencies. */
export async function installDeb(file: string, runProgram: RunProgram = run): Promise<void> {
  const { code, output } = await runProgram('/usr/bin/pkexec', [
    '/usr/bin/apt-get',
    'install',
    '-y',
    '--',
    file,
  ]);
  if (code === 0) return;
  if (code === 126 || code === 127)
    throw new UserError('The password prompt was closed or refused. Nothing was installed.');
  const last = output
    .trim()
    .split('\n')
    .filter((l) => l.startsWith('E:'))
    .join(' ');
  throw new UserError(`The package could not be installed. ${last || `apt-get ended with ${String(code)}.`}`);
}

export interface InstallRequest {
  install: InstallKind;
  download: Download;
  version: string;
  /** Private folder for the .deb. */
  workDir: string;
  runProgram?: RunProgram;
}

export async function downloadAndInstall(r: InstallRequest, o: InstallDeps): Promise<void> {
  if (r.install.kind === 'deb') {
    await rm(r.workDir, { recursive: true, force: true });
    await mkdir(r.workDir, { recursive: true, mode: 0o700 });
    const file = join(r.workDir, `Stellio-${r.version}-amd64.deb`);
    try {
      await downloadVerified(r.download, file, o);
      o.onProgress({ phase: 'install', received: r.download.size, total: r.download.size });
      await installDeb(file, r.runProgram);
    } finally {
      await rm(r.workDir, { recursive: true, force: true });
    }
  } else if (r.install.kind === 'appimage') {
    // Same folder, so the swap is one atomic rename. The name stays: shortcuts keep working.
    const target = r.install.file;
    const tmp = join(dirname(target), `.${basename(target)}.update`);
    await downloadVerified(r.download, tmp, o);
    o.onProgress({ phase: 'install', received: r.download.size, total: r.download.size });
    try {
      await chmod(tmp, 0o755);
      await rename(tmp, target);
    } catch (e) {
      await rm(tmp, { force: true });
      throw new UserError(
        `Could not replace ${target}: ${e instanceof Error ? e.message : String(e)}. Nothing was changed.`,
      );
    }
  } else throw new UserError('This copy of Stellio cannot update itself. Use the release page.');
}
