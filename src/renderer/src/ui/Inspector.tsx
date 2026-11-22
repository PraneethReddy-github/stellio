import { useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { IconButton } from './Button';
import s from './Inspector.module.css';

export const INSPECTOR_MIN = 280;
export const INSPECTOR_MAX = 560;
/** Matches `--inspector` in tokens.css; what the separator reports until the user resizes. */
const INSPECTOR_DEFAULT = 360;
const KEY = 'stellio.inspector.width';

export const clampInspectorWidth = (w: number): number =>
  Math.min(INSPECTOR_MAX, Math.max(INSPECTOR_MIN, Math.round(w)));

function loadWidth(): number | null {
  try {
    const n = Number(localStorage.getItem(KEY));
    return n > 0 ? clampInspectorWidth(n) : null;
  } catch {
    return null;
  }
}

function saveWidth(w: number): void {
  try {
    localStorage.setItem(KEY, String(w));
  } catch {
    /* storage unavailable: width just resets next launch */
  }
}

/** Right-hand detail panel. Drag the left edge (or use Left/Right keys on it) to resize. Esc closes. */
export function Inspector({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}): React.JSX.Element {
  const ref = useRef<HTMLElement>(null);
  const drag = useRef<{ x: number; w: number }>(null);
  const [width, setWidth] = useState(loadWidth);

  const current = (): number => ref.current?.getBoundingClientRect().width ?? INSPECTOR_MIN;
  const apply = (w: number, persist: boolean): void => {
    const next = clampInspectorWidth(w);
    setWidth(next);
    if (persist) saveWidth(next);
  };

  const onPointerMove = (e: PointerEvent): void => {
    if (drag.current) apply(drag.current.w + drag.current.x - e.clientX, false);
  };

  return (
    <aside
      ref={ref}
      className={s.inspector}
      style={width ? { width } : undefined}
      aria-label={title}
      onKeyDown={(e: KeyboardEvent) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      <div
        className={s.handle}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize inspector"
        aria-valuemin={INSPECTOR_MIN}
        aria-valuemax={INSPECTOR_MAX}
        aria-valuenow={width ?? INSPECTOR_DEFAULT}
        tabIndex={0}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { x: e.clientX, w: current() };
        }}
        onPointerMove={onPointerMove}
        onPointerUp={() => {
          drag.current = null;
          if (width) saveWidth(width);
        }}
        onKeyDown={(e) => {
          const step = e.key === 'ArrowLeft' ? 16 : e.key === 'ArrowRight' ? -16 : 0;
          if (!step) return;
          e.preventDefault();
          e.stopPropagation();
          apply(current() + step, true);
        }}
      />
      <header className={s.header}>
        <h2 className={s.title}>{title}</h2>
        <IconButton label="Close inspector" size="sm" icon={<X />} onClick={onClose} />
      </header>
      <div className={s.body}>{children}</div>
    </aside>
  );
}

/** Main content plus an optional inspector beside it. */
export function SplitView({
  inspector,
  children,
}: {
  inspector?: ReactNode;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <div className={s.split}>
      <div className={s.main}>{children}</div>
      {inspector}
    </div>
  );
}
