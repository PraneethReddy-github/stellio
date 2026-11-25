import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

/** Node versions installed by nvm, newest first. */
function nvmBins(home: string): string[] {
  const root = join(home, '.nvm', 'versions', 'node');
  try {
    return readdirSync(root)
      .sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))
      .map((v) => join(root, v, 'bin'));
  } catch {
    return [];
  }
}

/**
 * PATH plus the per-user folders where the Claude CLI and Tectonic get installed. An app started from a desktop
 * menu (or systemd) does not read `.bashrc`, so these are often missing. Appended: existing entries keep priority.
 */
export function withUserBins(path: string | undefined, home = homedir()): string {
  const bins = [
    join(home, '.local', 'bin'),
    join(home, '.claude', 'local'),
    join(home, '.npm-global', 'bin'),
    join(home, '.bun', 'bin'),
    join(home, '.volta', 'bin'),
    ...nvmBins(home),
    '/usr/local/bin',
    '/home/linuxbrew/.linuxbrew/bin',
  ];
  // An unset PATH means the system default; setting it to our list alone would hide /usr/bin.
  const current = (path || '/usr/bin:/bin').split(delimiter).filter((p) => p !== '');
  return [...new Set([...current, ...bins])].join(delimiter);
}

/**
 * True when the user switched KWallet off. Chromium picks KWallet on every KDE session and never falls back, so
 * `safeStorage` would be unavailable even with GNOME Keyring running. A disabled wallet cannot hold older keys.
 */
export function kwalletDisabled(env: NodeJS.ProcessEnv = process.env, home = homedir()): boolean {
  try {
    const rc = readFileSync(join(env.XDG_CONFIG_HOME || join(home, '.config'), 'kwalletrc'), 'utf8');
    const wallet = /^\[Wallet\][^\S\n]*$([^]*?)(?=^\[|$(?![^]))/m.exec(rc)?.[1] ?? '';
    return /^Enabled=false\s*$/m.test(wallet);
  } catch {
    return false;
  }
}
