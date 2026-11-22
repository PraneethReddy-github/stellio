import { create } from 'zustand';

type Mode = 'link' | 'text';

/** Palette commands ask the intake panel for a mode. A request counts for a moment only, so it cannot replay on a later visit. */
export const useIntakeIntent = create<{ mode: Mode; at: number; ask: (m: Mode) => void }>((set) => ({
  mode: 'link',
  at: 0,
  ask: (mode) => set({ mode, at: Date.now() }),
}));

const FRESH_MS = 2000;
/** The mode a just-mounted panel should start in. */
export const freshIntent = (): Mode | null => {
  const { mode, at } = useIntakeIntent.getState();
  return Date.now() - at < FRESH_MS ? mode : null;
};
