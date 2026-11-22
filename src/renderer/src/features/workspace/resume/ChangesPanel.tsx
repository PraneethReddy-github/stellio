import { useMemo } from 'react';
import { DiffView, ErrorState, Loading, SectionHeader, diffLines } from '../../../ui';
import { useDocDiff, type DocKind, type DocView } from '../../../lib/resume';
import s from './resume.module.css';

/** What the model changed (change_log) and the tex diff against the version this one came from. */
export function ChangesPanel({
  kind,
  jobId,
  doc,
}: {
  kind: DocKind;
  jobId: string;
  doc: DocView;
}): React.JSX.Element {
  const { parentVersion, version, instruction } = doc.meta;
  const diff = useDocDiff(kind, jobId, parentVersion, version);
  const hunks = useMemo(() => (diff.data ? diffLines(diff.data.a, diff.data.b) : null), [diff.data]);
  const content = doc.content;
  const log = content && 'change_log' in content ? content.change_log : null; // the cover letter keeps no change log
  return (
    <div className={s.panel}>
      {instruction && (
        <section className={s.section} aria-label="Instruction">
          <SectionHeader title="Instruction" level={3} />
          <p>{instruction}</p>
        </section>
      )}
      {log && (
        <section className={s.section} aria-label="Change log">
          <SectionHeader title="What changed" level={3} />
          {log.length > 0 ? (
            <ul className={s.list}>
              {log.map((c, i) => (
                <li key={`${String(i)}-${c}`} className={s.item}>
                  {c}
                </li>
              ))}
            </ul>
          ) : (
            <p className={s.muted}>{doc.content ? 'The model reported no changes.' : 'Edited by hand.'}</p>
          )}
        </section>
      )}
      <section className={s.section} aria-label="Diff">
        <SectionHeader
          title={parentVersion === null ? 'Diff' : `Diff against v${String(parentVersion)}`}
          level={3}
        />
        {parentVersion === null ? (
          <p className={s.muted}>This is the first version. Nothing to compare.</p>
        ) : diff.isPending ? (
          <Loading what="Reading both versions" />
        ) : diff.isError ? (
          <ErrorState title="Could not compare" message={diff.error.message} />
        ) : (
          <div className={s.diffBox}>
            <DiffView
              diff={hunks ?? []}
              ariaLabel={`Changes from v${String(parentVersion)} to v${String(version)}`}
              leftLabel="Before"
              rightLabel="After"
            />
          </div>
        )}
      </section>
    </div>
  );
}
