// @vitest-environment jsdom
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Table,
  VIRTUALIZE_ABOVE,
  windowRange,
  type Column,
  type SortState,
} from '../../../src/renderer/src/ui/Table';

afterEach(cleanup);

interface Job {
  id: string;
  title: string;
  score: number;
}
const columns: Column<Job>[] = [
  { id: 'title', header: 'Title', cell: (r) => r.title, sortable: true },
  { id: 'score', header: 'Score', cell: (r) => r.score, sortable: true, mono: true, align: 'right' },
];
const make = (n: number): Job[] =>
  Array.from({ length: n }, (_, i) => ({ id: `j${String(i)}`, title: `Role ${String(i)}`, score: i }));

function Harness({ rows, onRowClick }: { rows: Job[]; onRowClick?: (r: Job) => void }): React.JSX.Element {
  const [sel, setSel] = useState<string>();
  return (
    <Table
      ariaLabel="Jobs"
      columns={columns}
      rows={rows}
      getRowId={(r) => r.id}
      selectedId={sel}
      onSelectedChange={setSel}
      onSortChange={() => undefined}
      onRowClick={onRowClick}
    />
  );
}

const selectedText = (): string | undefined =>
  screen.queryAllByRole('row').find((r) => r.getAttribute('aria-selected') === 'true')?.textContent ??
  undefined;

describe('Table keyboard', () => {
  it('moves selection with arrows and J/K, clamps at the ends, Enter opens', () => {
    const onRowClick = vi.fn();
    render(<Harness rows={make(3)} onRowClick={onRowClick} />);
    const grid = screen.getByRole('grid');
    fireEvent.keyDown(grid, { key: 'ArrowDown' });
    expect(selectedText()).toContain('Role 0');
    fireEvent.keyDown(grid, { key: 'j' });
    fireEvent.keyDown(grid, { key: 'ArrowDown' });
    fireEvent.keyDown(grid, { key: 'ArrowDown' });
    expect(selectedText()).toContain('Role 2');
    fireEvent.keyDown(grid, { key: 'k' });
    expect(selectedText()).toContain('Role 1');
    fireEvent.keyDown(grid, { key: 'Enter' });
    expect(onRowClick).toHaveBeenCalledWith({ id: 'j1', title: 'Role 1', score: 1 });
  });

  it('focusing the grid with no active row selects the first, so Enter works at once', () => {
    const onRowClick = vi.fn();
    render(<Harness rows={make(3)} onRowClick={onRowClick} />);
    const grid = screen.getByRole('grid');
    fireEvent.focus(grid);
    expect(selectedText()).toContain('Role 0');
    fireEvent.keyDown(grid, { key: 'Enter' });
    expect(onRowClick).toHaveBeenCalledWith({ id: 'j0', title: 'Role 0', score: 0 });
  });

  it('keeps the active row when the grid is focused again', () => {
    render(<Harness rows={make(3)} />);
    const grid = screen.getByRole('grid');
    fireEvent.keyDown(grid, { key: 'End' });
    fireEvent.focus(grid);
    expect(selectedText()).toContain('Role 2');
  });

  it('ignores keys that come from a header button', () => {
    const onRowClick = vi.fn();
    render(<Harness rows={make(2)} onRowClick={onRowClick} />);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Title' }), { key: 'Enter' });
    expect(onRowClick).not.toHaveBeenCalled();
  });
});

describe('Table sorting', () => {
  it('toggles direction and exposes aria-sort', () => {
    const onSortChange = vi.fn();
    const { rerender } = render(
      <Table
        ariaLabel="Jobs"
        columns={columns}
        rows={make(2)}
        getRowId={(r) => r.id}
        onSortChange={onSortChange}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Score' }));
    expect(onSortChange).toHaveBeenLastCalledWith({ id: 'score', dir: 'asc' });
    const sort: SortState = { id: 'score', dir: 'asc' };
    rerender(
      <Table
        ariaLabel="Jobs"
        columns={columns}
        rows={make(2)}
        getRowId={(r) => r.id}
        sort={sort}
        onSortChange={onSortChange}
      />,
    );
    expect(screen.getByRole('columnheader', { name: 'Score' }).getAttribute('aria-sort')).toBe('ascending');
    expect(screen.getByRole('columnheader', { name: 'Title' }).getAttribute('aria-sort')).toBe('none');
    fireEvent.click(screen.getByRole('button', { name: 'Score' }));
    expect(onSortChange).toHaveBeenLastCalledWith({ id: 'score', dir: 'desc' });
  });
});

describe('Table virtualization', () => {
  it('renders every row up to the threshold and a window above it', () => {
    const { unmount } = render(<Harness rows={make(VIRTUALIZE_ABOVE)} />);
    expect(screen.getAllByRole('row')).toHaveLength(VIRTUALIZE_ABOVE + 1);
    unmount();
    render(<Harness rows={make(500)} />);
    const rendered = screen.getAllByRole('row').length;
    expect(rendered).toBeGreaterThan(5);
    expect(rendered).toBeLessThan(60);
    expect(screen.getByRole('grid').getAttribute('aria-rowcount')).toBe('501');
  });

  it('keeps scrolling when several scroll events land in one batch (regression: currentTarget was read lazily)', () => {
    render(<Harness rows={make(500)} />);
    const grid = screen.getByRole('grid');
    act(() => {
      for (const top of [320, 640, 1280]) {
        grid.scrollTop = top;
        fireEvent.scroll(grid);
      }
    });
    expect(screen.getByRole('grid')).toBe(grid);
    expect(screen.getAllByRole('row').length).toBeLessThan(60);
  });

  it('windowRange covers the viewport plus overscan and clamps to the data', () => {
    expect(windowRange(0, 320, 32, 500, 8)).toEqual({ start: 0, end: 18 });
    expect(windowRange(3200, 320, 32, 500, 8)).toEqual({ start: 92, end: 118 });
    expect(windowRange(99999, 320, 32, 500, 8)).toEqual({ start: 500, end: 500 });
    expect(windowRange(0, 320, 32, 0, 8)).toEqual({ start: 0, end: 0 });
  });
});
