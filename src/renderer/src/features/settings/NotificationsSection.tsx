import { useState } from 'react';
import { NotificationSettingsSchema, type NotificationSettings } from '@shared/settings/notifications';
import { Button, ErrorState, Field, Input, Loading, SectionHeader, Switch, useToast } from '../../ui';
import { useNotificationSettings, useSetNotificationSettings } from '../../lib/backups';
import s from './settings.module.css';

export function NotificationsSection(): React.JSX.Element {
  const q = useNotificationSettings();
  return (
    <section id="settings-notifications" className={s.section} aria-label="Notifications">
      <SectionHeader title="Notifications" level={3} />
      {q.isPending ? (
        <Loading what="Reading notification settings" />
      ) : q.isError ? (
        <ErrorState
          title="Could not read the notification settings"
          message={q.error.message}
          action={<Button onClick={() => void q.refetch()}>Retry</Button>}
        />
      ) : (
        <Form settings={q.data} />
      )}
    </section>
  );
}

function Form({ settings }: { settings: NotificationSettings }): React.JSX.Element {
  const set = useSetNotificationSettings();
  const { toast } = useToast();
  const [time, setTime] = useState(settings.digestTime);
  const save = (next: NotificationSettings): void =>
    set.mutate(next, {
      onError: (e) =>
        toast({ title: 'Could not save the notification settings', description: e.message, tone: 'bad' }),
    });
  const timeOk = NotificationSettingsSchema.shape.digestTime.safeParse(time).success;
  return (
    <div className={s.stack}>
      <Switch
        label="Daily follow-up digest"
        checked={settings.digestEnabled}
        onCheckedChange={(digestEnabled) => save({ ...settings, digestEnabled })}
      />
      <div className={s.fields}>
        <Field
          label="Digest time"
          hint="Local time, 24-hour HH:MM."
          error={timeOk ? undefined : 'Use HH:MM, e.g. 09:00.'}
        >
          {(p) => (
            <Input
              {...p}
              inputMode="numeric"
              placeholder="09:00"
              disabled={!settings.digestEnabled}
              value={time}
              onChange={(e) => {
                setTime(e.target.value);
                if (NotificationSettingsSchema.shape.digestTime.safeParse(e.target.value).success)
                  save({ ...settings, digestTime: e.target.value });
              }}
            />
          )}
        </Field>
      </div>
      <p className={s.quiet}>
        One notification a day, when a follow-up is due, from this time on while Stellio is open.
      </p>
      <Switch
        label="Tell me when a scheduled scan finds new matches"
        checked={settings.scanEnabled}
        onCheckedChange={(scanEnabled) => save({ ...settings, scanEnabled })}
      />
    </div>
  );
}
