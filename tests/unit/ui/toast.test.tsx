// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Toaster, useToastStore, type ToastInput } from '@renderer/ui';

beforeEach(() => {
  useToastStore.setState({ items: [] });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const add = (t: ToastInput): void => {
  act(() => {
    useToastStore.getState().push(t);
  });
};

describe('toast queue', () => {
  it('shows a toast with title and description', () => {
    render(<Toaster />);
    add({ title: 'Saved', description: 'Profile written.', tone: 'ok' });
    expect(screen.getByText('Saved')).toBeTruthy();
    expect(screen.getByText('Profile written.')).toBeTruthy();
  });

  it('keeps only the newest four', () => {
    render(<Toaster />);
    for (let i = 1; i <= 6; i++) add({ title: `Toast ${String(i)}` });
    expect(useToastStore.getState().items.map((t) => t.title)).toEqual([
      'Toast 3',
      'Toast 4',
      'Toast 5',
      'Toast 6',
    ]);
  });

  it('runs the action and removes the toast', () => {
    render(<Toaster />);
    const onClick = vi.fn();
    add({ title: 'Rejected', action: { label: 'Undo', onClick } });
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(useToastStore.getState().items).toHaveLength(0);
  });

  it('dismisses with the close button', () => {
    render(<Toaster />);
    add({ title: 'Heads up' });
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(useToastStore.getState().items).toHaveLength(0);
  });

  it('dismisses itself after 5 s', () => {
    vi.useFakeTimers();
    render(<Toaster />);
    add({ title: 'Temporary' });
    act(() => {
      vi.advanceTimersByTime(4900);
    });
    expect(useToastStore.getState().items).toHaveLength(1);
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(useToastStore.getState().items).toHaveLength(0);
  });
});
