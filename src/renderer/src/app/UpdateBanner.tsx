import { X } from 'lucide-react';
import { useState } from 'react';
import { dismissUpdate, readDismissedUpdate, useUpdateDialog, useUpdateStatus } from '../lib/updates';
import { Button, IconButton } from '../ui/Button';
import s from './Banner.module.css';

/** Shown when GitHub has a newer release, or one is installed and waits for a restart. Opens the update dialog. */
export function UpdateBanner(): React.JSX.Element | null {
  const status = useUpdateStatus().data;
  const setOpen = useUpdateDialog((st) => st.setOpen);
  const [dismissed, setDismissed] = useState(readDismissedUpdate);
  const update = status?.available;
  if (!update || update.version === dismissed) return null;
  const ready = status.installed === update.version;
  return (
    <div className={s.banner} data-tone="info" role="status">
      <p>
        Stellio {update.version} {ready ? 'is installed. Restart to use it.' : 'is available.'}
      </p>
      <Button size="sm" onClick={() => setOpen(true)}>
        {ready ? 'Restart…' : 'See what is new'}
      </Button>
      <IconButton
        label="Dismiss update"
        size="sm"
        icon={<X />}
        onClick={() => {
          dismissUpdate(update.version);
          setDismissed(update.version);
        }}
      />
    </div>
  );
}
