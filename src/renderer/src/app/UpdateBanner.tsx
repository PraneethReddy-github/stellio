import { X } from 'lucide-react';
import { useState } from 'react';
import { dismissUpdate, readDismissedUpdate, useUpdateStatus } from '../lib/updates';
import { IconButton } from '../ui/Button';
import s from './Banner.module.css';

/** Shown when GitHub has a newer release. Opens the release page; nothing is downloaded by Stellio. */
export function UpdateBanner(): React.JSX.Element | null {
  const update = useUpdateStatus().data?.available;
  const [dismissed, setDismissed] = useState(readDismissedUpdate);
  if (!update || update.version === dismissed) return null;
  return (
    <div className={s.banner} data-tone="info" role="status">
      <p>
        Stellio {update.version} is available.{' '}
        <a href={update.url} target="_blank" rel="noreferrer noopener" className={s.link}>
          Download
        </a>
      </p>
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
