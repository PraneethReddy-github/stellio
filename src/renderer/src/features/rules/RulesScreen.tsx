import { useCallback, useEffect, useRef, useState } from 'react';
import type { RulesFile } from '@shared/rules';
import { Page } from '../../app/Page';
import { Button, ErrorState, Loading, StatusDot, Tag, useToast } from '../../ui';
import {
  useReloadRules,
  useRulesFileWatch,
  useRulesList,
  diagnose,
  type Draft,
  type RulesInfo,
} from '../../lib/rules';
import { RulesEditor } from './RulesEditor';
import { countDiagnostics } from './helpers';
import { useSetSetup } from '../../lib/setup';
import s from './rules.module.css';

type ByPath<T> = Partial<Record<RulesFile, T>>;

const without = <T,>(o: ByPath<T>, path: RulesFile): ByPath<T> =>
  Object.fromEntries(Object.entries(o).filter(([k]) => k !== path));

export default function RulesScreen(): React.JSX.Element {
  const list = useRulesList();
  const reload = useReloadRules();
  const { toast } = useToast();
  // Opening Rules is the "reviewed" step of the first-run checklist.
  const { mutate: markSetup } = useSetSetup();
  useEffect(() => markSetup({ rulesReviewed: true }), [markSetup]);
  const [selected, setSelected] = useState<RulesFile>('rules/resume.md');
  const [drafts, setDrafts] = useState<ByPath<Draft>>({});
  const [stale, setStale] = useState<ByPath<true>>({});

  const draftsRef = useRef(drafts);
  const staleRef = useRef(stale);
  const selectedRef = useRef(selected);
  useEffect(() => {
    draftsRef.current = drafts;
    staleRef.current = stale;
    selectedRef.current = selected;
  });

  const setDraft = useCallback(
    (path: RulesFile, text: string | null, baseHash: string) => {
      if (text === null) {
        setDrafts((d) => (path in d ? without(d, path) : d));
        if (staleRef.current[path]) {
          // The warning was about edits that are gone now: drop it and show the file as it is on disk.
          setStale((st) => without(st, path));
          void reload(path);
        }
        return;
      }
      setDrafts((d) => {
        const prev = d[path];
        if (prev?.text === text) return d;
        return { ...d, [path]: { text, baseHash: prev?.baseHash ?? baseHash } };
      });
    },
    [reload],
  );
  const setStaleFor = useCallback((path: RulesFile, on: boolean) => {
    setStale((st) => {
      if (on === path in st) return st;
      if (on) return { ...st, [path]: true };
      return without(st, path);
    });
  }, []);

  useRulesFileWatch(
    useCallback(
      (path) => {
        if (draftsRef.current[path] !== undefined) setStaleFor(path, true);
        else
          void reload(path).then(() => {
            if (selectedRef.current === path) toast({ title: 'Reloaded — the file changed outside Stellio' });
          });
      },
      [reload, setStaleFor, toast],
    ),
  );

  return (
    <Page fill title="Rules" subtitle="What Stellio follows when it drafts your documents">
      {!list.data ? (
        list.isError ? (
          <ErrorState
            title="Could not read the rules"
            message={list.error.message}
            action={<Button onClick={() => void list.refetch()}>Retry</Button>}
          />
        ) : (
          <Loading what="Reading rules" />
        )
      ) : (
        <div className={s.layout}>
          <FileList files={list.data} selected={selected} drafts={drafts} onSelect={setSelected} />
          <RulesEditor
            key={selected}
            path={selected}
            draft={drafts[selected] ?? null}
            onDraft={(t, baseHash) => setDraft(selected, t, baseHash)}
            stale={selected in stale}
            onStale={(on) => setStaleFor(selected, on)}
          />
        </div>
      )}
    </Page>
  );
}

function FileList({
  files,
  selected,
  drafts,
  onSelect,
}: {
  files: RulesInfo[];
  selected: RulesFile;
  drafts: ByPath<Draft>;
  onSelect: (path: RulesFile) => void;
}): React.JSX.Element {
  return (
    <nav aria-label="Files">
      <ul className={s.files}>
        {files.map((f) => {
          const draft = drafts[f.path];
          // Counts follow the unsaved text while there is any, like the checks panel does.
          const { errors, warnings } =
            draft === undefined ? f : countDiagnostics(diagnose(f.path, draft.text));
          return (
            <li key={f.path}>
              <button
                type="button"
                className={s.file}
                aria-current={f.path === selected ? 'page' : undefined}
                onClick={() => onSelect(f.path)}
              >
                <span className={s.fileName}>
                  <span className={s.mono2}>{f.name}</span>
                  {draft !== undefined && <Tag tone="warn">unsaved</Tag>}
                  {f.modified && <Tag>modified</Tag>}
                </span>
                <span className={s.fileMeta}>
                  <span className={s.micro}>{f.kind}</span>
                  {errors > 0 && (
                    <StatusDot tone="bad">
                      <span className={s.mono}>{errors}</span> {errors === 1 ? 'error' : 'errors'}
                    </StatusDot>
                  )}
                  {warnings > 0 && (
                    <StatusDot tone="warn">
                      <span className={s.mono}>{warnings}</span> {warnings === 1 ? 'warning' : 'warnings'}
                    </StatusDot>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
