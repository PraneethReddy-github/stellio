import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Pinned release (spikes/latex/FINDINGS.md). The hash was computed from the tarball downloaded on 2026-11-19. */
export const TECTONIC_RELEASE = {
  version: '0.17.0',
  url: 'https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%400.17.0/tectonic-0.17.0-x86_64-unknown-linux-musl.tar.gz',
  sha256: '8533d07f9ccbd7a65824b9e0459041bca34af1eb33daba48f59215593753a3b7',
} as const;

const MAX_BYTES = 64 * 1024 * 1024;

export interface InstallProgress {
  phase: 'download' | 'verify' | 'extract' | 'done';
  received: number;
  total: number | null;
}

export interface InstallOptions {
  signal?: AbortSignal;
  onProgress?: (p: InstallProgress) => void;
  /** Injected in tests; never download in unit tests. */
  fetchFn?: typeof fetch;
  url?: string;
  sha256?: string;
}

export class InstallError extends Error {
  override name = 'InstallError';
}

/** True when this platform has a pinned build. */
export const installSupported = (): boolean => process.platform === 'linux' && process.arch === 'x64';

async function download(url: string, o: InstallOptions): Promise<Buffer> {
  if (!url.startsWith('https://')) throw new InstallError('Refusing to download over a non-https URL.');
  let res: Response;
  try {
    res = await (o.fetchFn ?? fetch)(url, { signal: o.signal, redirect: 'follow' });
  } catch (e) {
    if (o.signal?.aborted) throw e;
    throw new InstallError(`Download failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (res.url && !res.url.startsWith('https://'))
    throw new InstallError('Refusing a download that was redirected to a non-https URL.');
  if (!res.ok || !res.body) throw new InstallError(`Download failed: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || null;
  if (total !== null && total > MAX_BYTES) throw new InstallError('Download is larger than expected.');
  const chunks: Uint8Array[] = [];
  let received = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    received += chunk.byteLength;
    if (received > MAX_BYTES) throw new InstallError('Download is larger than expected.');
    chunks.push(chunk);
    o.onProgress?.({ phase: 'download', received, total });
  }
  return Buffer.concat(chunks);
}

function tarExtract(archive: string, into: string, member: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Only the named member is extracted, so nothing else in the archive can land on disk.
    execFile('tar', ['-xzf', archive, '-C', into, '--no-same-owner', '--', member], (err, _o, stderr) =>
      err
        ? reject(new InstallError(`Could not unpack the download: ${stderr.trim() || err.message}`))
        : resolve(),
    );
  });
}

/**
 * Downloads the pinned Tectonic tarball, verifies its SHA-256, extracts only the `tectonic` binary into `destDir`.
 * Nothing is executed and nothing is moved into place until the hash matches. Returns the binary path.
 */
export async function installTectonic(destDir: string, o: InstallOptions = {}): Promise<string> {
  const url = o.url ?? TECTONIC_RELEASE.url;
  const expected = (o.sha256 ?? TECTONIC_RELEASE.sha256).toLowerCase();
  if (!o.url && !installSupported())
    throw new InstallError('Automatic install is only available on Linux x86_64. Install Tectonic yourself.');

  const data = await download(url, o);
  const progress = { received: data.length, total: data.length };
  o.onProgress?.({ phase: 'verify', ...progress });
  const actual = createHash('sha256').update(data).digest('hex');
  if (actual !== expected)
    throw new InstallError('The downloaded file does not match the pinned checksum, so it was discarded.');

  await mkdir(destDir, { recursive: true });
  const stage = await mkdtemp(join(destDir, '.install-'));
  try {
    const archive = join(stage, 'download.tar.gz');
    await writeFile(archive, data);
    o.onProgress?.({ phase: 'extract', ...progress });
    await tarExtract(archive, stage, 'tectonic');
    const extracted = join(stage, 'tectonic');
    const st = await lstat(extracted).catch(() => null);
    if (!st?.isFile()) throw new InstallError('The archive does not contain a tectonic binary.');
    await chmod(extracted, 0o755);
    const dest = join(destDir, 'tectonic');
    await rename(extracted, dest);
    o.onProgress?.({ phase: 'done', ...progress });
    return dest;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
