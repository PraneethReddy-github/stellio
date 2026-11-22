import s from './misc.module.css';

/** Keyboard hint: `<Kbd keys="Ctrl K" />` renders one chip per key. */
export function Kbd({ keys }: { keys: string }): React.JSX.Element {
  return (
    <span className={s.kbdGroup}>
      {keys.split(' ').map((k) => (
        <kbd key={k} className={s.kbd}>
          {k}
        </kbd>
      ))}
    </span>
  );
}
