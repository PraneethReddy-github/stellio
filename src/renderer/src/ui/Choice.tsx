import { Checkbox as RC, RadioGroup as RR, Switch as RSw } from 'radix-ui';
import { Check, Minus } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import s from './controls.module.css';
import { cx } from './cx';

/** Checkbox with its own visible label. Pass `checked="indeterminate"` for a mixed state. */
export function Checkbox({
  label,
  className,
  ...rest
}: { label: ReactNode } & Omit<ComponentProps<typeof RC.Root>, 'children'>): React.JSX.Element {
  return (
    <label className={cx(s.choice, className)}>
      <RC.Root className={s.box} {...rest}>
        <RC.Indicator>
          {rest.checked === 'indeterminate' ? <Minus aria-hidden="true" /> : <Check aria-hidden="true" />}
        </RC.Indicator>
      </RC.Root>
      {label}
    </label>
  );
}

/** On/off setting that applies immediately. */
export function Switch({
  label,
  className,
  ...rest
}: { label: ReactNode } & Omit<ComponentProps<typeof RSw.Root>, 'children'>): React.JSX.Element {
  return (
    <label className={cx(s.choice, className)}>
      <RSw.Root className={s.switch} {...rest}>
        <RSw.Thumb className={s.thumb} />
      </RSw.Root>
      {label}
    </label>
  );
}

export interface RadioOption {
  value: string;
  label: ReactNode;
  disabled?: boolean;
}

export function RadioGroup({
  options,
  horizontal,
  className,
  ...rest
}: { options: RadioOption[]; horizontal?: boolean } & Omit<
  ComponentProps<typeof RR.Root>,
  'children'
>): React.JSX.Element {
  return (
    <RR.Root className={cx(s.group, horizontal && s.groupRow, className)} {...rest}>
      {options.map((o) => (
        <label key={o.value} className={s.choice}>
          <RR.Item value={o.value} disabled={o.disabled} className={s.radio}>
            <RR.Indicator className={s.radioDot} />
          </RR.Item>
          {o.label}
        </label>
      ))}
    </RR.Root>
  );
}
