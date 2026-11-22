import { Select as RS } from 'radix-ui';
import { Check, ChevronDown } from 'lucide-react';
import s from './controls.module.css';
import { cx } from './cx';
import { cspNonce } from './nonce';
import type { FieldControlProps } from './Field';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends Partial<FieldControlProps> {
  options: SelectOption[];
  value?: string;
  onValueChange?: (value: string) => void;
  placeholder?: string;
  size?: 'md' | 'sm';
  disabled?: boolean;
  name?: string;
  /** For a Select without a visible label (a table cell). */
  'aria-label'?: string;
}

export function Select({
  options,
  value,
  onValueChange,
  placeholder,
  size = 'md',
  disabled,
  name,
  ...aria
}: SelectProps): React.JSX.Element {
  return (
    <RS.Root value={value} onValueChange={onValueChange} disabled={disabled} name={name}>
      <RS.Trigger className={cx(s.control, s.trigger, size === 'sm' && s.sm)} {...aria}>
        <RS.Value placeholder={placeholder} />
        <RS.Icon>
          <ChevronDown aria-hidden="true" />
        </RS.Icon>
      </RS.Trigger>
      <RS.Portal>
        <RS.Content className={s.content} position="popper" sideOffset={4}>
          <RS.Viewport className={s.viewport} nonce={cspNonce()}>
            {options.map((o) => (
              <RS.Item key={o.value} value={o.value} disabled={o.disabled} className={s.option}>
                <RS.ItemText>{o.label}</RS.ItemText>
                <RS.ItemIndicator>
                  <Check aria-hidden="true" />
                </RS.ItemIndicator>
              </RS.Item>
            ))}
          </RS.Viewport>
        </RS.Content>
      </RS.Portal>
    </RS.Root>
  );
}
