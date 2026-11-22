import { Toast as RT } from 'radix-ui';
import { X } from 'lucide-react';
import { create } from 'zustand';
import s from './Toast.module.css';
import { cx } from './cx';

export interface ToastInput {
  title: string;
  description?: string;
  tone?: 'ok' | 'warn' | 'bad' | 'neutral';
  /** Undo and similar. Clicking runs `onClick` and closes the toast. */
  action?: { label: string; onClick: () => void };
}

interface ToastItem extends ToastInput {
  id: number;
}

const DURATION_MS = 5000;
/** Oldest toast is dropped past this many; bursts must not cover the screen. */
const MAX_VISIBLE = 4;

interface ToastStore {
  items: ToastItem[];
  push: (t: ToastInput) => number;
  dismiss: (id: number) => void;
}

let nextId = 1;

export const useToastStore = create<ToastStore>((set) => ({
  items: [],
  push: (t) => {
    const id = nextId++;
    set((st) => ({ items: [...st.items, { ...t, id }].slice(-MAX_VISIBLE) }));
    return id;
  },
  dismiss: (id) => set((st) => ({ items: st.items.filter((i) => i.id !== id) })),
}));

export function useToast(): { toast: (t: ToastInput) => number; dismiss: (id: number) => void } {
  const push = useToastStore((st) => st.push);
  const dismiss = useToastStore((st) => st.dismiss);
  return { toast: push, dismiss };
}

/** Mount once, in the app shell. */
export function Toaster(): React.JSX.Element {
  const items = useToastStore((st) => st.items);
  const dismiss = useToastStore((st) => st.dismiss);
  return (
    <RT.Provider duration={DURATION_MS} label="Notifications" swipeDirection="right">
      {items.map((t) => (
        <RT.Root
          key={t.id}
          className={s.toast}
          open
          onOpenChange={(open) => {
            if (!open) dismiss(t.id);
          }}
        >
          <span className={cx(s.dot, s[t.tone ?? 'neutral'])} aria-hidden="true" />
          <div className={s.text}>
            <RT.Title className={s.title}>{t.title}</RT.Title>
            {t.description && <RT.Description className={s.description}>{t.description}</RT.Description>}
          </div>
          {t.action && (
            <RT.Action altText={t.action.label} className={s.action} onClick={t.action.onClick}>
              {t.action.label}
            </RT.Action>
          )}
          <RT.Close className={s.close} aria-label="Dismiss">
            <X aria-hidden="true" />
          </RT.Close>
        </RT.Root>
      ))}
      <RT.Viewport className={s.viewport} />
    </RT.Provider>
  );
}
