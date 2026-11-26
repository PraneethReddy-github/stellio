import { Button, ErrorState, Loading, SectionHeader, useToast } from '../../ui';
import { useChoosePhoto, useClearPhoto, usePhoto } from '../../lib/profile';
import s from './profile.module.css';

/** The resume photo: shown on resumes from template format 2 when rules/resume.md has `photo: true`. */
export function PhotoSection(): React.JSX.Element {
  const { toast } = useToast();
  const photo = usePhoto();
  const choose = useChoosePhoto();
  const clear = useClearPhoto();
  const fail = (title: string) => (e: Error) => toast({ title, description: e.message, tone: 'bad' });

  return (
    <section className={s.section} aria-label="Resume photo">
      <SectionHeader title="Resume photo" />
      {photo.isPending && <Loading what="Reading the photo" />}
      {photo.isError && (
        <ErrorState
          title="Could not read the photo"
          message={photo.error.message}
          action={<Button onClick={() => void photo.refetch()}>Try again</Button>}
        />
      )}
      {photo.data && (
        <div className={s.photoRow}>
          {photo.data.dataUrl ? (
            <img className={s.photo} src={photo.data.dataUrl} alt="Your resume photo" />
          ) : (
            <div className={s.photoEmpty} aria-hidden="true" />
          )}
          <div className={s.photoText}>
            <p className={s.muted}>
              {photo.data.present
                ? 'Shown at the top of your resumes while rules/resume.md has photo: true.'
                : 'No photo. Resumes are made without one.'}
            </p>
            <p className={s.note}>PNG or JPEG. Stored as templates/photo.jpg, at most 600 pixels high.</p>
            <div className={s.photoActions}>
              <Button
                busy={choose.isPending}
                onClick={() =>
                  choose.mutate(undefined, {
                    onSuccess: (r) => {
                      if (r.status === 'saved') toast({ title: 'Photo saved' });
                    },
                    onError: fail('Could not use that photo'),
                  })
                }
              >
                {photo.data.present ? 'Change photo…' : 'Choose photo…'}
              </Button>
              {photo.data.present && (
                <Button
                  variant="ghost"
                  busy={clear.isPending}
                  onClick={() =>
                    clear.mutate(undefined, {
                      onSuccess: () => toast({ title: 'Photo removed' }),
                      onError: fail('Could not remove the photo'),
                    })
                  }
                >
                  Remove
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
