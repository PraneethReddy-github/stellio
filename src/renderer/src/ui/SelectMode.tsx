import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from './Button';
import { ConfirmDialog } from './Dialog';
import s from './SelectMode.module.css';

export interface SelectMode {
  on: boolean;
  ids: ReadonlySet<string>;
  setIds: (ids: ReadonlySet<string>) => void;
  start: () => void;
  stop: () => void;
  /** For `<Table checked>`; undefined while the mode is off. */
  checked: { ids: ReadonlySet<string>; onChange: (ids: ReadonlySet<string>) => void } | undefined;
}

const NONE: ReadonlySet<string> = new Set();

/** Off by default: lists show no checkboxes until the user presses Select. Escape leaves the mode. */
export function useSelectMode(): SelectMode {
  const [ids, setIds] = useState<ReadonlySet<string> | null>(null);
  const on = ids !== null;
  useEffect(() => {
    if (!on) return;
    const onKey = (e: KeyboardEvent): void => {
      // An open dialog or menu takes Escape first.
      if (e.key === 'Escape' && !e.defaultPrevented) setIds(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [on]);
  return {
    on,
    ids: ids ?? NONE,
    setIds,
    start: () => setIds(new Set()),
    stop: () => setIds(null),
    checked: ids ? { ids, onChange: setIds } : undefined,
  };
}

/** "Select", or in select mode: the count, Delete and Cancel. `count` is of rows still listed. */
export function SelectControls({
  mode,
  count,
  disabled,
  busy,
  confirmTitle,
  confirmText,
  onDelete,
}: {
  mode: SelectMode;
  count: number;
  /** Nothing to select. */
  disabled: boolean;
  busy: boolean;
  confirmTitle: string;
  confirmText: ReactNode;
  onDelete: () => void;
}): React.JSX.Element {
  const [confirm, setConfirm] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const wasOn = useRef(mode.on);
  // The pressed button is replaced by others: keep keyboard focus here.
  useEffect(() => {
    if (wasOn.current === mode.on) return;
    wasOn.current = mode.on;
    root.current?.querySelector<HTMLElement>('[data-focus]')?.focus();
  }, [mode.on]);
  return (
    <div ref={root} className={s.controls}>
      {mode.on ? (
        <>
          <span role="status" className={s.count}>
            {count} selected
          </span>
          <Button
            size="sm"
            variant="danger"
            disabled={count === 0}
            busy={busy}
            onClick={() => setConfirm(true)}
          >
            Delete…
          </Button>
          <Button size="sm" variant="ghost" data-focus="" onClick={mode.stop}>
            Cancel
          </Button>
        </>
      ) : (
        <Button size="sm" variant="ghost" data-focus="" disabled={disabled} onClick={mode.start}>
          Select
        </Button>
      )}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={confirmTitle}
        description={confirmText}
        confirmLabel="Delete"
        danger
        onConfirm={onDelete}
      />
    </div>
  );
}
