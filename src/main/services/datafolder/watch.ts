import { watch, type FSWatcher } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { hashText, noteOwnWrite, ownWrites } from './files';
import { WATCHED_DIRS } from './layout';

export { noteOwnWrite };

const DEBOUNCE_MS = 300;
// Editor scratch files (vim swap, emacs lock/backup, our own atomic-write temp files).
const IGNORED = /(^\.|~$|\.(tmp|swp|swx)$)/;

/**
 * Watches profile/, rules/, templates/ (non-recursive; the directory watch survives
 * rename-style saves). `onChange` gets the posix relative path after a 300 ms per-path debounce,
 * unless the file's content hash equals the last own write. Returns a disposer.
 */
export function watchDataFolder(dataDir: string, onChange: (relPath: string) => void): () => void {
  const watchers: FSWatcher[] = [];
  const timers = new Map<string, NodeJS.Timeout>();
  let closed = false;

  const settle = async (rel: string): Promise<void> => {
    const abs = resolve(dataDir, rel);
    let hash: string | null;
    try {
      hash = hashText(await readFile(abs, 'utf8'));
    } catch {
      hash = null; // deleted (or mid-rename): report it, the consumer re-reads
    }
    if (closed) return;
    if (hash !== null && ownWrites.get(abs) === hash) return;
    ownWrites.delete(abs);
    onChange(rel);
  };

  for (const d of WATCHED_DIRS) {
    try {
      const w = watch(join(dataDir, d), { persistent: false }, (_ev, name) => {
        if (!name || IGNORED.test(name)) return;
        const rel = `${d}/${name}`;
        clearTimeout(timers.get(rel));
        timers.set(
          rel,
          setTimeout(() => {
            timers.delete(rel);
            void settle(rel);
          }, DEBOUNCE_MS),
        );
      });
      w.on('error', () => undefined); // shortcut: a removed watched dir stops reporting until the app restarts
      watchers.push(w);
    } catch {
      // directory missing: nothing to watch
    }
  }

  return () => {
    closed = true;
    watchers.forEach((w) => w.close());
    timers.forEach(clearTimeout);
    timers.clear();
  };
}
