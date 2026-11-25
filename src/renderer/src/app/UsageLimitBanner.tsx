import { X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { IconButton } from '../ui/Button';
import s from './Banner.module.css';

/** Quiet top banner shown after Claude reports the subscription's usage limit. */
export function UsageLimitBanner(): React.JSX.Element | null {
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => window.stellio.on('ai:usageLimit', (p) => setMessage(p.message)), []);
  if (message === null) return null;
  return (
    <div className={s.banner} role="status">
      <p>
        Claude usage limit reached — {message.replace(/[.\s]+$/, '')}. Background tasks pause until it resets.
      </p>
      <IconButton label="Dismiss" size="sm" icon={<X />} onClick={() => setMessage(null)} />
    </div>
  );
}
