import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

/** SHA-256 of text with CRLF normalised to LF and trailing whitespace trimmed per line. */
export function hashText(text: string): string {
  const norm = text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n');
  return createHash('sha256').update(norm).digest('hex');
}

/** Last content hash written by the app, per absolute path. The watcher uses it to ignore own writes. */
export const ownWrites = new Map<string, string>();

export function noteOwnWrite(path: string, hash: string): void {
  ownWrites.set(resolve(path), hash);
}

/** Temp file in the same dir, fsync, rename. Registers the write so the watcher ignores it. */
export async function writeFileAtomic(path: string, content: string | Uint8Array): Promise<void> {
  const target = resolve(path);
  const dir = dirname(target);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${basename(target)}.${randomUUID()}.tmp`);
  try {
    const fh = await open(tmp, 'w');
    try {
      await fh.writeFile(content);
      await fh.sync();
    } finally {
      await fh.close();
    }
    // Registered before rename so the watcher event cannot beat it.
    if (typeof content === 'string') noteOwnWrite(target, hashText(content));
    await rename(tmp, target);
  } catch (e) {
    await unlink(tmp).catch(() => undefined);
    throw e;
  }
}
