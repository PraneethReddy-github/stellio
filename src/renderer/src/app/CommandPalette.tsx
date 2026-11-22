import { useNavigate } from '@tanstack/react-router';
import { Command as Cmdk } from 'cmdk';
import { useMemo, useState } from 'react';
import { Kbd } from '../ui/Kbd';
import { applyTheme } from '../lib/theme';
import { useCommandStore, type Command } from './commands';
import { NAV } from './nav';
import s from './CommandPalette.module.css';

export function useCommandPalette(): { open: boolean; setOpen: (open: boolean) => void } {
  const [open, setOpen] = useState(false);
  return { open, setOpen };
}

const SKILLS: string = '/skills';

export function CommandPalette({
  open,
  setOpen,
}: {
  open: boolean;
  setOpen: (o: boolean) => void;
}): React.JSX.Element {
  const navigate = useNavigate();
  const scoped = useCommandStore((st) => st.scoped);

  const commands = useMemo<Command[]>(() => {
    const go: Command[] = NAV.map((n) => ({
      id: `go:${n.to}`,
      label: `Go to ${n.label}`,
      group: 'Navigate',
      hint: n.key ? `G ${n.key.toUpperCase()}` : undefined,
      run: () => void navigate({ to: n.to }),
    }));
    const skills: Command = {
      id: 'skills:open',
      label: 'Open skills',
      group: 'Skills',
      run: () => void navigate({ to: SKILLS }),
    };
    const theme: Command[] = (['dark', 'light', 'system'] as const).map((t) => ({
      id: `theme:${t}`,
      label: `Theme: ${t}`,
      group: 'Appearance',
      run: () => applyTheme(t),
    }));
    return [...Object.values(scoped).flat(), ...go, skills, ...theme];
  }, [scoped, navigate]);

  const groups = [...new Set(commands.map((c) => c.group))];

  return (
    <Cmdk.Dialog
      open={open}
      onOpenChange={setOpen}
      label="Command palette"
      className={s.dialog}
      overlayClassName={s.overlay}
      contentClassName={s.content}
    >
      <Cmdk.Input className={s.input} placeholder="Type a command or page" />
      <Cmdk.List className={s.list}>
        <Cmdk.Empty className={s.empty}>No matching command.</Cmdk.Empty>
        {groups.map((g) => (
          <Cmdk.Group key={g} heading={g} className={s.group}>
            {commands
              .filter((c) => c.group === g)
              .map((c) => (
                <Cmdk.Item
                  key={c.id}
                  value={`${c.group} ${c.label}`}
                  className={s.item}
                  onSelect={() => {
                    setOpen(false);
                    c.run();
                  }}
                >
                  <span>{c.label}</span>
                  {c.hint && <Kbd keys={c.hint} />}
                </Cmdk.Item>
              ))}
          </Cmdk.Group>
        ))}
      </Cmdk.List>
    </Cmdk.Dialog>
  );
}
