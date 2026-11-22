import { useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { NAV } from './nav';

/** True when keystrokes belong to a text field or editor, so global shortcuts must stay quiet. */
export function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return (
    el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || !!el.closest('.cm-editor')
  );
}

/** Ctrl+K palette; `G <key>` navigation (docs/09 §5). */
export function useGlobalShortcuts(setPaletteOpen: (open: boolean) => void): void {
  const navigate = useNavigate();
  useEffect(() => {
    let gPressedAt = 0;
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen(true);
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
      const key = e.key.toLowerCase();
      if (key === 'g') {
        gPressedAt = Date.now();
        return;
      }
      if (Date.now() - gPressedAt < 1000) {
        const item = NAV.find((n) => n.key === key);
        gPressedAt = 0;
        if (item) {
          e.preventDefault();
          void navigate({ to: item.to });
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate, setPaletteOpen]);
}
