import { Button, ErrorState, KeyValue, Loading, ProgressLine, SectionHeader, StatusDot } from '../../ui';
import { useElapsedSeconds } from '../../lib/hooks';
import { formatProgress, progressValue, useInstallLatex, useLatexStatus, useWarmUp } from '../../lib/latex';
import s from './settings.module.css';

export function LatexSection(): React.JSX.Element {
  const q = useLatexStatus();
  const install = useInstallLatex();
  const warm = useWarmUp();
  const warmSecs = useElapsedSeconds(warm.isPending);
  const st = q.data;

  return (
    <section id="settings-latex" className={s.section} aria-label="LaTeX">
      <SectionHeader title="LaTeX" level={3} />
      {!st ? (
        q.isError ? (
          <ErrorState
            title="Could not check for a LaTeX engine"
            message={q.error.message}
            action={<Button onClick={() => void q.refetch()}>Retry</Button>}
          />
        ) : (
          <Loading what="Looking for a LaTeX engine" />
        )
      ) : st.engine ? (
        <KeyValue
          items={[
            { key: 'Engine', value: <StatusDot tone="ok">Tectonic {st.engine.version}</StatusDot> },
            { key: 'Path', value: st.engine.path, mono: true },
            {
              key: 'Packages',
              value:
                st.cacheWarm === null ? (
                  'Unknown'
                ) : st.cacheWarm ? (
                  <StatusDot tone="ok">Downloaded</StatusDot>
                ) : (
                  <StatusDot tone="warn">Not downloaded yet</StatusDot>
                ),
            },
          ]}
        />
      ) : (
        <div className={s.stack}>
          <p>
            <StatusDot tone="warn">No LaTeX engine found</StatusDot>
          </p>
          {st.installSupported ? (
            <p className={s.quiet}>
              Tectonic is a small local LaTeX engine. Stellio checks the download against a pinned checksum
              before it runs anything.
            </p>
          ) : (
            <p className={s.quiet}>
              Automatic install works on Linux x86_64 only. Install Tectonic yourself and put it on your PATH.
            </p>
          )}
          {st.installSupported && (
            <Button busy={install.isPending} onClick={() => install.mutate()}>
              {install.isPending ? 'Installing…' : 'Install Tectonic (10 MB, verified download)'}
            </Button>
          )}
          {install.isPending && (
            <div className={s.progress}>
              <ProgressLine
                label="Installing Tectonic"
                value={install.progress ? progressValue(install.progress) : undefined}
              />
              <span className={s.mono}>
                {install.progress ? formatProgress(install.progress) : 'starting'}
              </span>
            </div>
          )}
          {install.isError && <p className={s.error}>{install.error.message}</p>}
        </div>
      )}
      {st?.engine && st.cacheWarm === false && (
        <div className={s.stack}>
          <p className={s.quiet}>
            The first compile needs about 43 MB of TeX packages and takes up to 2 minutes. Once only.
          </p>
          <Button busy={warm.isPending} onClick={() => warm.mutate()}>
            {warm.isPending ? 'Downloading…' : 'Download LaTeX packages'}
          </Button>
          {warm.isPending && (
            <div className={s.progress}>
              <ProgressLine label="Downloading LaTeX packages" />
              <span className={s.mono}>downloading packages · {warmSecs} s</span>
            </div>
          )}
          {warm.isError && <p className={s.error}>{warm.error.message}</p>}
        </div>
      )}
    </section>
  );
}
