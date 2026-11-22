import type { KeywordHit, TruthWarning } from '@shared/documents';
import { ScoreMeter, SectionHeader, StatusDot, Tag } from '../../../ui';
import type { DocView } from '../../../lib/resume';
import {
  ATS_THRESHOLDS,
  FINAL_NOTE_MANUAL,
  checkLabel,
  KEYWORD_LABEL,
  TRUTH_KIND_LABEL,
  keywordState,
  pagesText,
} from './helpers';
import s from './resume.module.css';

const KEYWORD_TONE = { found: 'ok', youHave: 'warn', missing: 'neutral' } as const;

/** Truth, ATS and lint results of one version, as reported by main. */
export function ChecksPanel({ doc }: { doc: DocView }): React.JSX.Element {
  const { truth, lint, compile } = doc.checks;
  const ats = 'ats' in doc.checks ? doc.checks.ats : null; // the cover letter has no ATS check
  const errors = lint.issues.filter((i) => i.severity === 'error').length;
  return (
    <div className={s.panel}>
      <section className={s.section} aria-label="Truth check">
        <SectionHeader title="Truth" level={3} />
        {truth === null ? (
          <p className={s.muted}>{FINAL_NOTE_MANUAL}</p>
        ) : truth.ok ? (
          <>
            <StatusDot tone="ok">Every claim traces to your profile</StatusDot>
            <TruthWarnings warnings={truth.warnings} />
          </>
        ) : (
          <>
            <StatusDot tone="bad">
              {truth.violations.length} {truth.violations.length === 1 ? 'violation' : 'violations'}
            </StatusDot>
            <ul className={s.list}>
              {truth.violations.map((v, i) => (
                <li key={`${String(i)}-${v.path}`} className={`${s.item} ${s.flag}`}>
                  <span className={s.itemText}>
                    <span>
                      {TRUTH_KIND_LABEL[v.kind]}: <span className={s.mono}>{v.text}</span>
                    </span>
                    <span className={s.muted}>{v.detail}</span>
                  </span>
                </li>
              ))}
            </ul>
            <TruthWarnings warnings={truth.warnings} />
          </>
        )}
      </section>

      {ats && (
        <section className={s.section} aria-label="ATS check">
          <SectionHeader title="ATS" level={3} />
          <div className={s.score}>
            <span className={s.scoreNum} aria-hidden="true">
              {Math.round(ats.score)}
            </span>
            <ScoreMeter value={ats.score} thresholds={ATS_THRESHOLDS} label="ATS score" showValue={false} />
          </div>
          <Keywords title="Required keywords" hits={ats.required} />
          <Keywords title="Preferred keywords" hits={ats.preferred} />
          {ats.format.length > 0 && (
            <ul className={s.list} aria-label="Format checks">
              {ats.format.map((f) => (
                <li key={f.check} className={s.item}>
                  <span className={s.itemText}>
                    <StatusDot tone={f.ok ? 'ok' : 'warn'}>{checkLabel(f.check)}</StatusDot>
                    {!f.ok && <span className={s.muted}>{f.detail}</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section className={s.section} aria-label="Lint">
        <SectionHeader title="Lint" level={3} />
        {lint.issues.length === 0 ? (
          <StatusDot tone="ok">No issues</StatusDot>
        ) : (
          <>
            <p className={s.muted}>
              {errors} {errors === 1 ? 'error' : 'errors'}, {lint.issues.length - errors}{' '}
              {lint.issues.length - errors === 1 ? 'warning' : 'warnings'}
            </p>
            <ul className={s.list}>
              {lint.issues.map((i, k) => (
                <li key={`${String(k)}-${i.rule}`} className={s.item}>
                  <span className={s.itemText}>
                    <StatusDot tone={i.severity === 'error' ? 'bad' : 'warn'}>{i.message}</StatusDot>
                    <span className={s.muted}>
                      <span className={s.mono}>{i.rule}</span>
                      {i.path && <span className={s.mono}> · {i.path}</span>}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section className={s.section} aria-label="Compile">
        <SectionHeader title="Compile" level={3} />
        {compile === null ? (
          <p className={s.muted}>Not compiled: no LaTeX engine found.</p>
        ) : (
          <>
            <StatusDot tone={compile.ok ? 'ok' : 'bad'}>
              {compile.ok ? 'Compiled' : 'Failed'} · {pagesText(compile.pages)}
              {compile.overfull > 0 && ` · ${String(compile.overfull)} overfull`}
            </StatusDot>
            {compile.errors.length > 0 && (
              <ul className={s.list} aria-label="Compile errors">
                {compile.errors.map((e, i) => (
                  <li key={i} className={`${s.item} ${s.flag}`}>
                    <span className={s.mono}>
                      {e.line !== undefined && `line ${String(e.line)}: `}
                      {e.message}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>
    </div>
  );
}

function Keywords({ title, hits }: { title: string; hits: KeywordHit[] }): React.JSX.Element | null {
  if (hits.length === 0) return null;
  return (
    <>
      <h4 className={s.micro}>{title}</h4>
      <ul className={s.list} aria-label={title}>
        {hits.map((h) => {
          const st = keywordState(h);
          return (
            <li key={h.term} className={s.item}>
              <span>{h.term}</span>
              <Tag tone={KEYWORD_TONE[st]}>{KEYWORD_LABEL[st]}</Tag>
            </li>
          );
        })}
      </ul>
    </>
  );
}

/** Names, places or products Stellio could not find in the cited entries: worth a look, not blocking. */
function TruthWarnings({ warnings }: { warnings: TruthWarning[] }): React.JSX.Element | null {
  if (warnings.length === 0) return null;
  return (
    <>
      <StatusDot tone="warn">
        {warnings.length} {warnings.length === 1 ? 'term to check' : 'terms to check'}
      </StatusDot>
      <ul className={s.list}>
        {warnings.map((w, i) => (
          <li key={`${String(i)}-${w.path}`} className={s.item}>
            <span className={s.itemText}>
              <span className={s.mono}>{w.text}</span>
              <span className={s.muted}>{w.detail}</span>
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}
