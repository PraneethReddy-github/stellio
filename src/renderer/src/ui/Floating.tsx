import { DropdownMenu as RM, Popover as RP, Tooltip as RT } from 'radix-ui';
import type { ReactNode } from 'react';
import { Kbd } from './Kbd';
import s from './Floating.module.css';
import { cx } from './cx';

/** `trigger` must be a single element that accepts a ref (Button, IconButton). */
export function Popover({
  trigger,
  children,
  align = 'start',
}: {
  trigger: ReactNode;
  children: ReactNode;
  align?: 'start' | 'center' | 'end';
}): React.JSX.Element {
  return (
    <RP.Root>
      <RP.Trigger asChild>{trigger}</RP.Trigger>
      <RP.Portal>
        <RP.Content className={cx(s.layer, s.popover)} align={align} sideOffset={4}>
          {children}
        </RP.Content>
      </RP.Portal>
    </RP.Root>
  );
}

export type MenuEntry =
  | {
      label: string;
      onSelect: () => void;
      shortcut?: string;
      danger?: boolean;
      disabled?: boolean;
    }
  | 'separator';

export function DropdownMenu({
  trigger,
  items,
  align = 'start',
}: {
  trigger: ReactNode;
  items: MenuEntry[];
  align?: 'start' | 'center' | 'end';
}): React.JSX.Element {
  return (
    <RM.Root>
      <RM.Trigger asChild>{trigger}</RM.Trigger>
      <RM.Portal>
        <RM.Content className={cx(s.layer, s.menu)} align={align} sideOffset={4}>
          {items.map((it, i) =>
            it === 'separator' ? (
              <RM.Separator key={`sep${String(i)}`} className={s.separator} />
            ) : (
              <RM.Item
                key={it.label}
                className={cx(s.item, it.danger && s.danger)}
                disabled={it.disabled}
                onSelect={it.onSelect}
              >
                <span>{it.label}</span>
                {it.shortcut && <Kbd keys={it.shortcut} />}
              </RM.Item>
            ),
          )}
        </RM.Content>
      </RM.Portal>
    </RM.Root>
  );
}

/** Supplementary only: never the sole place information lives (docs/09 §2). */
export function Tooltip({ label, children }: { label: string; children: ReactNode }): React.JSX.Element {
  return (
    <RT.Provider delayDuration={400} skipDelayDuration={200}>
      <RT.Root>
        <RT.Trigger asChild>{children}</RT.Trigger>
        <RT.Portal>
          <RT.Content className={s.tooltip} sideOffset={6}>
            {label}
          </RT.Content>
        </RT.Portal>
      </RT.Root>
    </RT.Provider>
  );
}
