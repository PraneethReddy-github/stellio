import { useEffect, useMemo, useRef, useState } from 'react';
import { CHANGED_ON_DISK } from '@shared/messages';
import { isTemplateFile, type RulesFile } from '@shared/rules';
import {
  Button,
  CodeEditor,
  ConfirmDialog,
  ErrorState,
  Inspector,
  Loading,
  SectionHeader,
  SplitView,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  useToast,
} from '../../ui';
import { useRegisterCommands, type Command } from '../../app/commands';
import { useGitAvailable } from '../../lib/profile';
import { useCompileTemplate, useLatexStatus, useWarmUp } from '../../lib/latex';
import {
  diagnose,
  useResetRules,
  useReloadRules,
  useRevertRules,
  useRulesFile,
  useSaveRules,
  type Draft,
  type RulesSnapshot,
} from '../../lib/rules';
import { CompilePanel, type CompileState } from './CompilePanel';
import { DefaultTab } from './DefaultTab';
import { Diagnostics } from './Diagnostics';
import { RulesHistoryTab } from './RulesHistoryTab';
import { effectNote, fileName, languageOf, saveMessage, sortByLine } from './helpers';
import s from './rules.module.css';

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const BLOCKED = 'Save or discard your unsaved edits on the Edit tab first.';

export function RulesEditor({
  path,
  draft,
  onDraft,
  stale,
  onStale,
}: {
  path: RulesFile;
  /** Unsaved text for this file; null shows the file exactly. Held by the screen so it survives switching files. */
  draft: Draft | null;
  /** `baseHash` is the disk version the text was started from; the screen keeps the first one it saw. */
  onDraft: (text: string | null, baseHash: string) => void;
  /** The file changed on disk while there were unsaved edits. */
  stale: boolean;
  onStale: (stale: boolean) => void;
}): React.JSX.Element {
  const q = useRulesFile(path);
  if (!q.data)
    return q.isError ? (
      <ErrorState
        title={`Could not read ${fileName(path)}`}
        message={q.error.message}
        action={<Button onClick={() => void q.refetch()}>Retry</Button>}
      />
    ) : (
      <Loading what={`Reading ${fileName(path)}`} />
    );
  return (
    <Loaded path={path} snapshot={q.data} draft={draft} onDraft={onDraft} stale={stale} onStale={onStale} />
  );
}

function Loaded({
  path,
  snapshot,
  draft,
  onDraft,
  stale,
  onStale,
}: {
  path: RulesFile;
  snapshot: RulesSnapshot;
  draft: Draft | null;
  onDraft: (text: string | null, baseHash: string) => void;
  stale: boolean;
  onStale: (stale: boolean) => void;
}): React.JSX.Element {
  const { toast } = useToast();
  const name = fileName(path);
  const isTemplate = isTemplateFile(path);
  const gitAvailable = useGitAvailable();
  const saveM = useSaveRules(path);
  const revertM = useRevertRules(path);
  const resetM = useResetRules(path);
  const reload = useReloadRules();
  const compileM = useCompileTemplate();
  const warmM = useWarmUp();
  const latex = useLatexStatus();

  const [tab, setTab] = useState('edit');
  const [focus, setFocus] = useState<{ line: number }>();
  const [showInspector, setShowInspector] = useState(true);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [overwrite, setOverwrite] = useState(false);
  const [compiled, setCompiled] = useState<{ result: CompileState['result']; text: string }>({
    result: null,
    text: '',
  });

  // A draft the file has caught up with (after a save, or edited back to the saved text) is no draft.
  useEffect(() => {
    if (draft !== null && draft.text === snapshot.content) onDraft(null, snapshot.hash);
  });

  const text = draft?.text ?? snapshot.content;
  const dirty = draft !== null && draft.text !== snapshot.content;
  const live = useMemo(() => sortByLine(diagnose(path, text)), [path, text]);

  const save = (overwrite = false): void => {
    if (!draft || !dirty || saveM.isPending) return;
    setSaveError(null);
    saveM.mutate(
      { content: text, message: saveMessage(path), expectedHash: draft.baseHash, overwrite },
      {
        onSuccess: () => {
          onStale(false);
          toast({ title: `${name} saved`, tone: 'ok' });
        },
        onError: (e) => setSaveError(errMsg(e)),
      },
    );
  };
  const conflict = saveError?.includes(CHANGED_ON_DISK) ?? false;

  const discard = (): void => {
    setSaveError(null);
    onDraft(null, snapshot.hash); // the screen also reloads the file if it moved while we held these edits
  };

  const reloadFromDisk = (): void => {
    onDraft(null, snapshot.hash);
    onStale(false);
    setSaveError(null);
    void reload(path);
  };

  const jumpToLine = (line: number): void => {
    setTab('edit');
    setFocus({ line });
  };

  const runCompile = (): void => {
    if (compileM.isPending || !isTemplateFile(path)) return;
    const compiledText = text;
    compileM.mutate(
      { path, content: compiledText },
      { onSuccess: (result) => setCompiled({ result, text: compiledText }) },
    );
  };
  const warmUp = (): void =>
    warmM.mutate(isTemplateFile(path) ? text : undefined, {
      onSuccess: () => {
        toast({ title: 'LaTeX packages downloaded', tone: 'ok' });
        runCompile();
      },
      onError: (e) => toast({ title: 'Could not download packages', description: errMsg(e), tone: 'bad' }),
    });

  // Ctrl+S outside the editor; inside it, CodeEditor's own binding has already handled (and cancelled) the key.
  const act = useRef({ save });
  useEffect(() => {
    act.current = { save };
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && !e.defaultPrevented) {
        e.preventDefault();
        if (!document.querySelector('[role="dialog"]')) act.current.save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const commands = useMemo<Command[]>(
    () => [
      {
        id: 'rules.save',
        label: 'Save rules file',
        group: 'Rules',
        hint: 'Ctrl S',
        run: () => act.current.save(),
      },
    ],
    [],
  );
  useRegisterCommands('rules', commands);

  const compileState: CompileState = {
    result: compiled.result,
    text: compiled.text,
    pending: compileM.isPending,
    error: compileM.isError ? errMsg(compileM.error) : null,
  };
  const noEngine = latex.data?.engine === null;

  return (
    <div className={s.editor}>
      <div className={s.editorHead}>
        <code className={s.path}>{path}</code>
        {tab === 'edit' && (
          <div className={s.actions}>
            {dirty && (
              <Button variant="ghost" onClick={discard}>
                Discard
              </Button>
            )}
            {isTemplate && (
              <Button busy={compileM.isPending} disabled={noEngine} onClick={runCompile}>
                {compileM.isPending ? 'Compiling…' : 'Test compile'}
              </Button>
            )}
            <Button variant="primary" disabled={!dirty} busy={saveM.isPending} onClick={() => save()}>
              Save
            </Button>
          </div>
        )}
      </div>
      {saveError && (
        <div className={s.errorBanner}>
          <ErrorState
            title={`Could not save ${name}`}
            message={saveError}
            action={
              conflict ? (
                <div className={s.bannerActions}>
                  <Button onClick={reloadFromDisk}>Reload from disk (discard mine)</Button>
                  <Button onClick={() => setOverwrite(true)}>Overwrite with my version</Button>
                </div>
              ) : (
                <Button onClick={reloadFromDisk}>Reload from disk</Button>
              )
            }
          />
        </div>
      )}
      {stale && (
        <div className={s.banner} role="alert">
          <p>The file changed on disk. Your unsaved edits are based on the old version.</p>
          <div className={s.bannerActions}>
            <Button size="sm" onClick={reloadFromDisk}>
              Reload (discard my edits)
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onStale(false)}>
              Keep editing
            </Button>
          </div>
        </div>
      )}
      <ConfirmDialog
        open={overwrite}
        onOpenChange={setOverwrite}
        title="Overwrite the version on disk?"
        description={
          gitAvailable
            ? `Your edits replace the current ${name}. The version on disk is kept in history, so you can restore it.`
            : `Your edits replace the current ${name}. The version on disk is copied to .stellio/backups/ first.`
        }
        confirmLabel="Overwrite"
        danger
        onConfirm={() => save(true)}
      />
      <Tabs value={tab} onValueChange={setTab} className={s.tabs}>
        <div className={s.tabBar}>
          <TabsList>
            <TabsTrigger value="edit">Edit</TabsTrigger>
            <TabsTrigger value="history">History</TabsTrigger>
            <TabsTrigger value="default">Default</TabsTrigger>
          </TabsList>
          {!showInspector && tab === 'edit' && (
            <Button size="sm" variant="ghost" onClick={() => setShowInspector(true)}>
              Show checks ({live.length})
            </Button>
          )}
        </div>
        {/* Stays mounted while hidden: unmounting would drop CodeMirror's undo history and scroll. */}
        <TabsContent value="edit" className={s.editPane} forceMount hidden={tab !== 'edit'}>
          <p className={s.note}>{effectNote(path)}</p>
          <div className={s.split}>
            <SplitView
              inspector={
                showInspector ? (
                  <Inspector title="Checks" onClose={() => setShowInspector(false)}>
                    <Diagnostics diagnostics={live} onJump={jumpToLine} />
                    {isTemplate && (
                      <>
                        <div className={s.sectionGap} />
                        <SectionHeader title="Test compile" level={3} />
                        <CompilePanel
                          state={compileState}
                          status={latex.data}
                          current={text}
                          warming={warmM.isPending}
                          onWarm={warmUp}
                          onJump={jumpToLine}
                        />
                      </>
                    )}
                  </Inspector>
                ) : undefined
              }
            >
              <CodeEditor
                language={languageOf(path)}
                ariaLabel={`${name} content`}
                fill
                value={text}
                onChange={(v) => onDraft(v, snapshot.hash)}
                onSave={() => save()}
                focusLine={focus}
              />
            </SplitView>
          </div>
        </TabsContent>
        <TabsContent value="history" className={s.pane}>
          <RulesHistoryTab
            path={path}
            gitAvailable={gitAvailable}
            restoring={revertM.isPending}
            blockedReason={dirty ? BLOCKED : null}
            onRestore={(c) =>
              revertM.mutate(c.hash, {
                onSuccess: () => {
                  onStale(false);
                  toast({ title: 'Version restored', description: c.message, tone: 'ok' });
                },
                onError: (e) => toast({ title: 'Could not restore', description: errMsg(e), tone: 'bad' }),
              })
            }
          />
        </TabsContent>
        <TabsContent value="default" className={s.pane}>
          <DefaultTab
            path={path}
            gitAvailable={gitAvailable}
            resetting={resetM.isPending}
            blockedReason={dirty ? BLOCKED : null}
            onReset={() =>
              resetM.mutate(undefined, {
                onSuccess: () => {
                  onStale(false);
                  toast({
                    title: 'Reset to default',
                    description: gitAvailable
                      ? 'The previous version is in History.'
                      : 'Saved a copy of the previous version in .stellio/backups.',
                    tone: 'ok',
                  });
                },
                onError: (e) => toast({ title: 'Could not reset', description: errMsg(e), tone: 'bad' }),
              })
            }
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
