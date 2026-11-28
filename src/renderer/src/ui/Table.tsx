import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { Checkbox } from './Choice';
import s from './Table.module.css';
import { cx } from './cx';

export interface Column<T> {
  id: string;
  header: string;
  cell: (row: T) => ReactNode;
  /** Any CSS grid track size, e.g. '120px' or 'minmax(0, 2fr)'. Default `minmax(0, 1fr)`. */
  width?: string;
  align?: 'left' | 'right';
  sortable?: boolean;
  mono?: boolean;
}

export interface SortState {
  id: string;
  dir: 'asc' | 'desc';
}

export interface TableProps<T> {
  columns: Column<T>[];
  /** Already sorted by the caller; the table only shows the sort state. */
  rows: T[];
  getRowId: (row: T) => string;
  /** Click or Enter on the active row. */
  onRowClick?: (row: T) => void;
  /** Controlled selection. Leave undefined to let the table track it. */
  selectedId?: string;
  onSelectedChange?: (id: string) => void;
  sort?: SortState;
  onSortChange?: (sort: SortState) => void;
  /** Multi-select mode: a checkbox column appears; click, Enter or Space toggles a row instead of opening it. */
  checked?: { ids: ReadonlySet<string>; onChange: (ids: ReadonlySet<string>) => void };
  empty?: ReactNode;
  ariaLabel: string;
}

/** Above this many rows only the visible window is rendered. */
export const VIRTUALIZE_ABOVE = 200;
const OVERSCAN = 8;
const FALLBACK_ROW = 32;

/** Fixed-row-height window: which rows [start, end) to render for a scroll position. */
export function windowRange(
  scrollTop: number,
  viewport: number,
  rowHeight: number,
  count: number,
  overscan = OVERSCAN,
): { start: number; end: number } {
  const start = Math.min(count, Math.max(0, Math.floor(scrollTop / rowHeight) - overscan));
  const end = Math.min(count, Math.ceil((scrollTop + viewport) / rowHeight) + overscan);
  return { start, end };
}

export function Table<T>({
  columns,
  rows,
  getRowId,
  onRowClick,
  selectedId,
  onSelectedChange,
  sort,
  onSortChange,
  checked,
  empty,
  ariaLabel,
}: TableProps<T>): React.JSX.Element {
  const uid = useId();
  const scroller = useRef<HTMLDivElement>(null);
  const pointer = useRef(false); // a press is under way: the focus it causes is not keyboard focus
  const [internal, setInternal] = useState<string>();
  const [view, setView] = useState({ top: 0, height: 600, row: FALLBACK_ROW });
  const active = selectedId ?? internal;
  const activeIndex = active === undefined ? -1 : rows.findIndex((r) => getRowId(r) === active);

  const measure = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const row = parseFloat(getComputedStyle(el).getPropertyValue('--row')) || FALLBACK_ROW;
    const height = el.clientHeight || 600;
    setView((v) => (v.row === row && v.height === height ? v : { ...v, row, height }));
  }, []);

  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);

  const virtual = rows.length > VIRTUALIZE_ABOVE;
  const { start, end } = virtual
    ? windowRange(view.top, view.height, view.row, rows.length)
    : { start: 0, end: rows.length };

  const select = (i: number): void => {
    const row = rows[i];
    const el = scroller.current;
    if (!row) return;
    const id = getRowId(row);
    setInternal(id);
    onSelectedChange?.(id);
    if (el) {
      // The header is one sticky row tall, so body row i spans [(i + 1) * row, (i + 2) * row).
      const top = i * view.row;
      if (top < el.scrollTop) el.scrollTop = top;
      else if (top + 2 * view.row > el.scrollTop + el.clientHeight)
        el.scrollTop = top + 2 * view.row - el.clientHeight;
    }
  };

  const toggle = (row: T): void => {
    if (!checked) return;
    const next = new Set(checked.ids);
    const id = getRowId(row);
    if (!next.delete(id)) next.add(id);
    checked.onChange(next);
  };
  const activate = (row: T): void => (checked ? toggle(row) : onRowClick?.(row));
  const checkedCount = checked ? rows.filter((r) => checked.ids.has(getRowId(r))).length : 0;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.target !== e.currentTarget || e.ctrlKey || e.metaKey || e.altKey) return;
    const last = rows.length - 1;
    const down = Math.min(last, activeIndex + 1);
    const up = Math.max(0, activeIndex - 1);
    const target: Record<string, number> = {
      ArrowDown: down,
      j: down,
      ArrowUp: up,
      k: up,
      Home: 0,
      End: last,
    };
    if (e.key === 'Enter' || (checked && e.key === ' ')) {
      const row = rows[activeIndex];
      if (row) activate(row);
    } else if (e.key in target && rows.length > 0) {
      select(target[e.key] ?? 0);
    } else return;
    e.preventDefault();
  };

  const rowId = (i: number): string => `${uid}-r${String(i)}`;

  return (
    <div
      ref={scroller}
      className={s.scroller}
      role="grid"
      aria-label={ariaLabel}
      aria-multiselectable={checked ? true : undefined}
      aria-rowcount={rows.length + 1}
      aria-activedescendant={activeIndex >= start && activeIndex < end ? rowId(activeIndex) : undefined}
      tabIndex={0}
      onKeyDown={onKeyDown}
      // Keyboard focus with nothing active starts on the first row, so Enter always has a target.
      // Not on mouse focus: selecting row 0 there scrolls to the top and swallows the click on a lower row.
      onFocus={(e) => {
        if (e.target === e.currentTarget && !pointer.current && activeIndex < 0 && rows.length > 0) select(0);
      }}
      onPointerDown={() => {
        pointer.current = true;
      }}
      onPointerUp={() => {
        pointer.current = false;
      }}
      onBlur={() => {
        pointer.current = false;
      }}
      onScroll={
        virtual
          ? (e) => {
              // Read it now: React may run the updater after the event, when `currentTarget` is already null.
              const top = e.currentTarget.scrollTop;
              setView((v) => ({ ...v, top }));
            }
          : undefined
      }
      style={
        {
          '--cols': [...(checked ? ['40px'] : []), ...columns.map((c) => c.width ?? 'minmax(0, 1fr)')].join(
            ' ',
          ),
        } as React.CSSProperties
      }
    >
      <div role="row" aria-rowindex={1} className={cx(s.row, s.head)}>
        {checked && (
          <div role="columnheader" className={s.check}>
            <Checkbox
              label={<span className="sr-only">Select all</span>}
              disabled={rows.length === 0}
              checked={checkedCount === 0 ? false : checkedCount === rows.length ? true : 'indeterminate'}
              onCheckedChange={(on) => checked.onChange(new Set(on === true ? rows.map(getRowId) : []))}
            />
          </div>
        )}
        {columns.map((c) => {
          const dir = sort?.id === c.id ? sort.dir : undefined;
          const label = (
            <>
              {c.header}
              {dir && (dir === 'asc' ? <ArrowUp aria-hidden="true" /> : <ArrowDown aria-hidden="true" />)}
            </>
          );
          return (
            <div
              key={c.id}
              role="columnheader"
              aria-sort={dir ? (dir === 'asc' ? 'ascending' : 'descending') : c.sortable ? 'none' : undefined}
              className={cx(s.cell, c.align === 'right' && s.right)}
            >
              {c.sortable && onSortChange ? (
                <button
                  type="button"
                  className={s.sortBtn}
                  onClick={() => onSortChange({ id: c.id, dir: dir === 'asc' ? 'desc' : 'asc' })}
                >
                  {label}
                </button>
              ) : (
                <span className={s.sortBtn}>{label}</span>
              )}
            </div>
          );
        })}
      </div>
      {rows.length === 0 && empty ? (
        <div role="row" className={s.emptyRow}>
          <div role="gridcell" aria-colspan={columns.length + (checked ? 1 : 0)}>
            {empty}
          </div>
        </div>
      ) : (
        <div
          role="rowgroup"
          style={
            virtual
              ? { paddingTop: start * view.row, paddingBottom: (rows.length - end) * view.row }
              : undefined
          }
        >
          {rows.slice(start, end).map((row, k) => {
            const i = start + k;
            const isChecked = checked?.ids.has(getRowId(row)) ?? false;
            return (
              <div
                key={getRowId(row)}
                id={rowId(i)}
                role="row"
                aria-rowindex={i + 2}
                aria-selected={checked ? isChecked : i === activeIndex}
                className={cx(s.row, s.body, i === activeIndex && s.selected)}
                onClick={() => {
                  select(i);
                  activate(row);
                }}
              >
                {checked && (
                  // A picture of the row's state: the row itself is the control (aria-selected).
                  <div role="gridcell" className={cx(s.check, s.inert)}>
                    <span aria-hidden="true">
                      <Checkbox label={null} checked={isChecked} tabIndex={-1} />
                    </span>
                  </div>
                )}
                {columns.map((c) => (
                  <div
                    key={c.id}
                    role="gridcell"
                    className={cx(s.cell, c.align === 'right' && s.right, c.mono && s.mono)}
                  >
                    {c.cell(row)}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
