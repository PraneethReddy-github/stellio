import { useEffect } from 'react';
import { create } from 'zustand';

export interface Command {
  id: string;
  label: string;
  group: string;
  /** Shortcut hint shown in the palette, e.g. "G P". */
  hint?: string;
  run: () => void;
}

interface CommandStore {
  scoped: Record<string, Command[]>;
  set: (scope: string, commands: Command[] | null) => void;
}

/** Screens contribute context commands while mounted; the palette lists them first. */
export const useCommandStore = create<CommandStore>((set) => ({
  scoped: {},
  set: (scope, commands) =>
    set((st) => ({
      scoped: Object.fromEntries([
        ...Object.entries(st.scoped).filter(([k]) => k !== scope),
        ...(commands ? [[scope, commands] as const] : []),
      ]),
    })),
}));

export function useRegisterCommands(scope: string, commands: Command[]): void {
  const set = useCommandStore((st) => st.set);
  useEffect(() => {
    set(scope, commands);
    return () => set(scope, null);
  }, [scope, commands, set]);
}
