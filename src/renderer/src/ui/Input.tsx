import {
  forwardRef,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type InputHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import s from './controls.module.css';
import { cx } from './cx';

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  size?: 'md' | 'sm';
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { size = 'md', className, ...rest },
  ref,
) {
  return <input ref={ref} className={cx(s.control, size === 'sm' && s.sm, className)} {...rest} />;
});

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** Grows with its content instead of scrolling. */
  autoGrow?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { autoGrow, className, rows = 3, ...rest },
  ref,
) {
  const inner = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(ref, () => inner.current as HTMLTextAreaElement);
  useLayoutEffect(() => {
    const el = inner.current;
    if (!autoGrow || !el) return;
    el.style.height = 'auto';
    el.style.height = `${String(el.scrollHeight + 2)}px`;
  });
  return (
    <textarea
      ref={inner}
      rows={rows}
      className={cx(s.control, s.textarea, autoGrow && s.grow, className)}
      {...rest}
    />
  );
});
