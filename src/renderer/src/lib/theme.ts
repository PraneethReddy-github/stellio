export type ThemePref = 'system' | 'dark' | 'light';
const KEY = 'stellio.theme';

export function readThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'dark' || v === 'light' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(pref: ThemePref): void {
  if (pref === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = pref;
  try {
    localStorage.setItem(KEY, pref);
  } catch {
    // Per-viewer convenience only; ignore storage failures.
  }
}
