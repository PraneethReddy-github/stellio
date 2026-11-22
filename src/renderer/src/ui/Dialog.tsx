import { Dialog as RD } from 'radix-ui';
import { useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react';
import { Button } from './Button';
import s from './Dialog.module.css';
import { cx } from './cx';

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  /** Action buttons, right-aligned. */
  footer?: ReactNode;
  /** Focus goes here on close instead of the element that was focused on open (e.g. its opener is disabled while busy). */
  returnFocus?: RefObject<HTMLElement | null>;
  children?: ReactNode;
}

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  size = 'md',
  footer,
  returnFocus,
  children,
}: DialogProps): React.JSX.Element {
  // Radix only restores focus to a Dialog.Trigger, and ours are opened from anywhere: remember the opener.
  const opener = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (open) opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }, [open]);
  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <RD.Portal>
        <RD.Overlay className={s.overlay} />
        {/* Explicit undefined tells Radix there is intentionally no description. */}
        <RD.Content
          className={cx(s.panel, s[size])}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            const el = returnFocus?.current ?? opener.current;
            if (el?.isConnected && !(el instanceof HTMLButtonElement && el.disabled)) el.focus();
          }}
          {...(description ? {} : { 'aria-describedby': undefined })}
        >
          <div className={s.head}>
            <RD.Title className={s.title}>{title}</RD.Title>
            {description && <RD.Description className={s.description}>{description}</RD.Description>}
          </div>
          {children && <div className={s.body}>{children}</div>}
          {footer && <div className={s.footer}>{footer}</div>}
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Destructive confirm (red text button). */
  danger?: boolean;
  onConfirm: () => void;
}

/** For deleting files and other irreversible actions. Everything else uses an undo toast. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger,
  onConfirm,
}: ConfirmDialogProps): React.JSX.Element {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      size="sm"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>{cancelLabel}</Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            onClick={() => {
              onConfirm();
              onOpenChange(false);
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    />
  );
}
