// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from '@renderer/ui';

afterEach(cleanup);

function setup(): { onConfirm: () => void; onOpenChange: (o: boolean) => void } {
  const onConfirm = vi.fn();
  const onOpenChange = vi.fn();
  render(
    <ConfirmDialog
      open
      onOpenChange={onOpenChange}
      title="Delete file?"
      description="Cannot be undone."
      confirmLabel="Delete"
      onConfirm={onConfirm}
    />,
  );
  return { onConfirm, onOpenChange };
}

describe('ConfirmDialog', () => {
  it('is a named, described dialog', () => {
    setup();
    const dialog = screen.getByRole('dialog', { name: 'Delete file?' });
    expect(dialog.getAttribute('aria-describedby')).toBeTruthy();
  });

  it('confirm runs the action and closes', () => {
    const { onConfirm, onOpenChange } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('cancel closes without running the action', () => {
    const { onConfirm, onOpenChange } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
