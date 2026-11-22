import { Tabs as RT } from 'radix-ui';
import type { ComponentProps } from 'react';
import s from './Tabs.module.css';
import { cx } from './cx';

/** Underline tabs. Compose: Tabs > TabsList > TabsTrigger, then one TabsContent per value. */
export const Tabs = RT.Root;

export function TabsList({ className, ...rest }: ComponentProps<typeof RT.List>): React.JSX.Element {
  return <RT.List className={cx(s.list, className)} {...rest} />;
}
export function TabsTrigger({ className, ...rest }: ComponentProps<typeof RT.Trigger>): React.JSX.Element {
  return <RT.Trigger className={cx(s.trigger, className)} {...rest} />;
}
export function TabsContent({ className, ...rest }: ComponentProps<typeof RT.Content>): React.JSX.Element {
  return <RT.Content className={cx(s.content, className)} {...rest} />;
}
