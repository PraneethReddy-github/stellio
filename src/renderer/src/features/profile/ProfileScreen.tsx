import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { canonicalSkillKey, type SkillRow } from '@shared/profile';
import { Page } from '../../app/Page';
import { useRegisterCommands, type Command } from '../../app/commands';
import {
  Button,
  CodeEditor,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Loading,
  SplitView,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  useToast,
} from '../../ui';
import {
  PROFILE_PATH,
  useGitAvailable,
  useImportProfile,
  useProfile,
  useProfileFileWatch,
  useRevertProfile,
  useSaveProfile,
  useSuggestProfile,
  type ProfileSnapshot,
  type ProfileSuggestionData,
} from '../../lib/profile';
import { useElapsedSeconds } from '../../lib/hooks';
import { DiagnosticsPanel } from './DiagnosticsPanel';
import { HistoryTab } from './HistoryTab';
import { ImportDialog, type ImportDraft } from './ImportDialog';
import { OverviewTab } from './OverviewTab';
import { SkillDialog } from './SkillDialog';
import { SuggestDialog } from './SuggestDialog';
import {
  GENERIC_MESSAGE,
  deleteSkill,
  entryLine,
  evidenceIds,
  liveDiagnostics,
  mergeMessage,
  saveSkill,
  setField,
  skillConflict,
} from './helpers';
import s from './profile.module.css';

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export default function ProfileScreen(): React.JSX.Element {
  const q = useProfile();
  if (!q.data) {
    return (
      <Page title="Profile">
        {q.isError ? (
          <ErrorState
            title="Could not read the profile"
            message={q.error.message}
            action={<Button onClick={() => void q.refetch()}>Retry</Button>}
          />
        ) : (
          <Loading what="Reading profile" />
        )}
      </Page>
    );
  }
  return <ProfileEditor snapshot={q.data} refetch={q.refetch} />;
}

function ProfileEditor({
  snapshot,
  refetch,
}: {
  snapshot: ProfileSnapshot;
  refetch: () => Promise<unknown>;
}): React.JSX.Element {
  const { toast } = useToast();
  const gitAvailable = useGitAvailable();
  const saveM = useSaveProfile();
  const revertM = useRevertProfile();
  const importM = useImportProfile();
  const suggestM = useSuggestProfile();

  // null = the editor shows the snapshot exactly, so "dirty" can never drift from the file.
  const [draft, setDraft] = useState<string | null>(null);
  const [label, setLabel] = useState<string | null>(null);
  const [tab, setTab] = useState('overview');
  const [focus, setFocus] = useState<{ line: number }>();
  const [showDiag, setShowDiag] = useState(true);
  const [startBlank, setStartBlank] = useState(false);
  const [externalWarn, setExternalWarn] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [skillDialog, setSkillDialog] = useState<{ row: SkillRow | null } | null>(null);
  const [skillDelete, setSkillDelete] = useState<string | null>(null);
  const [review, setReview] = useState<ImportDraft | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [suggestion, setSuggestion] = useState<ProfileSuggestionData | null>(null);
  const [suggestError, setSuggestError] = useState<string | null>(null);
  const [suggestSaveError, setSuggestSaveError] = useState<string | null>(null);

  // Saves never clear the draft themselves: the editor would flash the old snapshot for one render, and
  // anything typed while the save was pending would be lost. Drop it once the snapshot has caught up
  // (setState during render re-renders before anything is committed, so there is no stale frame).
  if (draft !== null && draft === snapshot.markdown) {
    setDraft(null);
    setLabel(null);
  }

  const markdown = draft ?? snapshot.markdown;
  const dirty = draft !== null;
  const today = useMemo(() => new Date(), []);
  const live = useMemo(() => liveDiagnostics(markdown, today), [markdown, today]);
  const model = live.model;

  const importBtn = useRef<HTMLButtonElement>(null);
  const suggestBtn = useRef<HTMLButtonElement>(null);
  const diagBtn = useRef<HTMLButtonElement>(null);
  const refocusDiag = useRef(false);
  const importSecs = useElapsedSeconds(importM.isPending);
  const suggestSecs = useElapsedSeconds(suggestM.isPending);

  const dirtyRef = useRef(dirty);
  useEffect(() => {
    dirtyRef.current = dirty;
  });

  const reload = useCallback(() => refetch(), [refetch]);
  const settle = (): void => {
    setDraft(null);
    setLabel(null);
    if (externalWarn) {
      setExternalWarn(false);
      void reload(); // the file moved while we held edits that are now gone
    }
  };

  /** Every edit, form or raw, lands here as new markdown. */
  const edit = (next: string, message: string): void => {
    if (next === markdown) return;
    if (next === snapshot.markdown) return settle();
    setDraft(next);
    setLabel(mergeMessage(label, message));
  };

  const onField = (path: string, value: unknown, section: 'identity' | 'preferences'): void => {
    const next = setField(markdown, path, value);
    if (next === markdown) {
      const cur = path
        .split('.')
        .reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], model.frontMatter);
      if (JSON.stringify(cur) !== JSON.stringify(value))
        toast({
          title: 'Could not edit the front matter',
          description: 'Fix it in the Markdown tab.',
          tone: 'warn',
        });
      return;
    }
    edit(next, `profile: edit ${section}`);
  };

  /** Returns an error for the Skill field, or null once the row is in the draft. */
  const submitSkill = (row: SkillRow, previous: string | null): string | null => {
    const clash = skillConflict(model.skills, row, previous);
    if (clash) return `${clash.skill} is already in the profile — edit it instead.`;
    const renamed = previous !== null && canonicalSkillKey(previous) !== canonicalSkillKey(row.skill);
    const base = renamed ? deleteSkill(markdown, previous) : markdown;
    edit(saveSkill(base, row), `profile: ${previous === null ? 'add' : 'update'} skill ${row.skill}`);
    setSkillDialog(null);
    return null;
  };

  const doSave = (md: string, message: string, ok: () => void, fail: (m: string) => void): void => {
    saveM.mutate(
      { markdown: md, message: message.slice(0, 200) },
      { onSuccess: ok, onError: (e) => fail(errMsg(e)) },
    );
  };

  const save = (): void => {
    if (!dirty || saveM.isPending || markdown === snapshot.markdown) return;
    setSaveError(null);
    doSave(
      markdown,
      label ?? GENERIC_MESSAGE,
      () => {
        setExternalWarn(false);
        toast({ title: 'Profile saved', tone: 'ok' });
      },
      setSaveError,
    );
  };

  const reloadFromDisk = (): void => {
    setDraft(null);
    setLabel(null);
    setSaveError(null);
    setExternalWarn(false);
    void reload();
  };

  const startImport = (): void => {
    if (importM.isPending) return;
    setImportError(null);
    importM.mutate(undefined, {
      onSuccess: (r) => {
        if (r.status !== 'draft') return;
        setReviewError(null);
        setReview(r);
      },
      onError: (e) => setImportError(errMsg(e)),
    });
  };

  /** `profile.suggest` reads the saved file, so unsaved edits must be saved or discarded first. */
  const startSuggest = (): void => {
    if (suggestM.isPending || dirtyRef.current) return;
    setSuggestError(null);
    suggestM.mutate(undefined, {
      onSuccess: (r) => {
        setSuggestSaveError(null);
        setSuggestion(r);
      },
      onError: (e) => setSuggestError(errMsg(e)),
    });
  };

  const saveSuggestion = (): void => {
    if (!suggestion) return;
    setSuggestSaveError(null);
    saveM.mutate(
      {
        markdown: suggestion.after,
        expectedHash: suggestion.expectedHash,
        message: 'profile: apply suggested updates',
      },
      {
        onSuccess: () => {
          setSuggestion(null);
          toast({ title: 'Profile updated', description: 'Suggested updates saved.', tone: 'ok' });
        },
        onError: (e) => setSuggestSaveError(errMsg(e)),
      },
    );
  };

  const replaceWithImport = (): void => {
    if (!review) return;
    setReviewError(null);
    doSave(
      review.draft.markdown,
      `profile: import from ${review.sourceName}`,
      () => {
        // The replaced file is the new truth, including over unsaved edits; the effect above clears it.
        setDraft(review.draft.markdown);
        setExternalWarn(false);
        setReview(null);
        toast({ title: 'Profile replaced', description: `Imported from ${review.sourceName}`, tone: 'ok' });
      },
      setReviewError,
    );
  };

  const jumpToLine = (line: number): void => {
    setTab('markdown');
    setFocus({ line });
  };

  useProfileFileWatch(
    useCallback(() => {
      if (dirtyRef.current) setExternalWarn(true);
      else void reload().then(() => toast({ title: 'Reloaded — the file changed outside Stellio' }));
    }, [reload, toast]),
  );

  // Ctrl+S outside the editor; inside it, CodeEditor's own binding has already handled (and cancelled) the key.
  const act = useRef({ save, startImport, startSuggest });
  useEffect(() => {
    act.current = { save, startImport, startSuggest };
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && !e.defaultPrevented) {
        e.preventDefault();
        if (!document.querySelector('[role="dialog"]')) act.current.save(); // not behind a dialog
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const commands = useMemo<Command[]>(
    () => [
      {
        id: 'profile.save',
        label: 'Save profile',
        group: 'Profile',
        hint: 'Ctrl S',
        run: () => act.current.save(),
      },
      {
        id: 'profile.import',
        label: 'Import resume',
        group: 'Profile',
        run: () => act.current.startImport(),
      },
      {
        id: 'profile.suggest',
        label: 'Suggest profile updates',
        group: 'Profile',
        run: () => act.current.startSuggest(),
      },
      { id: 'profile.history', label: 'Open history', group: 'Profile', run: () => setTab('history') },
    ],
    [],
  );
  useRegisterCommands('profile', commands);

  // Nothing to report: the panel collapses to a ghost button instead of taking a third of the width.
  const diagOpen = showDiag && live.all.length > 0;
  useEffect(() => {
    if (!diagOpen && refocusDiag.current) {
      refocusDiag.current = false;
      diagBtn.current?.focus();
    }
  }, [diagOpen]);

  const lastReviewed = model.frontMatter.last_reviewed;
  const empty = snapshot.markdown.trim() === '' && !dirty && !startBlank;

  return (
    <Page
      fill
      title="Profile"
      subtitle={
        <>
          <code className={s.mono}>{PROFILE_PATH}</code> · last reviewed {lastReviewed || 'never'}
        </>
      }
      actions={
        <>
          {dirty && (
            <Button
              variant="ghost"
              onClick={() => {
                setSaveError(null);
                settle();
              }}
            >
              Discard
            </Button>
          )}
          <Button
            ref={suggestBtn}
            busy={suggestM.isPending}
            disabled={dirty}
            title={dirty ? 'Save or discard your edits first' : undefined}
            onClick={startSuggest}
          >
            {suggestM.isPending ? 'Reading…' : 'Suggest updates'}
          </Button>
          <Button ref={importBtn} busy={importM.isPending} onClick={startImport}>
            {importM.isPending ? 'Importing…' : 'Import resume'}
          </Button>
          <Button variant="primary" disabled={!dirty} busy={saveM.isPending} onClick={save}>
            Save
          </Button>
        </>
      }
    >
      {importM.isPending && (
        <div className={s.importing}>
          <Loading what={`Drafting profile with Claude · ${String(importSecs)} s`} />
        </div>
      )}
      {suggestM.isPending && (
        <div className={s.importing}>
          <Loading what={`Reading your recent decisions and notes · ${String(suggestSecs)} s`} />
          <Button size="sm" onClick={() => void suggestM.cancel()}>
            Cancel
          </Button>
        </div>
      )}
      {suggestError && (
        <div className={s.errorBanner}>
          <ErrorState
            title="No suggestions"
            message={suggestError}
            action={<Button onClick={startSuggest}>Try again</Button>}
          />
        </div>
      )}
      {importError && (
        <div className={s.errorBanner}>
          <ErrorState
            title="Import failed"
            message={importError}
            action={<Button onClick={startImport}>Try again</Button>}
          />
        </div>
      )}
      {saveError && (
        <div className={s.errorBanner}>
          <ErrorState
            title="Could not save the profile"
            message={saveError}
            action={<Button onClick={reloadFromDisk}>Reload from disk</Button>}
          />
        </div>
      )}
      {externalWarn && (
        <div className={s.banner} role="alert">
          <p>The file changed on disk. Your unsaved edits are based on the old version.</p>
          <div className={s.bannerActions}>
            <Button size="sm" onClick={reloadFromDisk}>
              Reload (discard my edits)
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setExternalWarn(false)}>
              Keep editing
            </Button>
          </div>
        </div>
      )}

      {empty ? (
        <EmptyState
          title="The profile is empty"
          action={
            <div className={s.bannerActions}>
              <Button variant="primary" onClick={startImport}>
                Import resume
              </Button>
              <Button
                onClick={() => {
                  setStartBlank(true);
                  setTab('markdown');
                }}
              >
                Write in Markdown
              </Button>
            </div>
          }
        >
          Import an existing resume to draft it, or write the file by hand.
        </EmptyState>
      ) : (
        <SplitView
          inspector={
            diagOpen ? (
              <DiagnosticsPanel
                diagnostics={live.all}
                onJump={jumpToLine}
                onClose={() => {
                  refocusDiag.current = true; // the panel had focus; hand it to the toggle that replaces it
                  setShowDiag(false);
                }}
              />
            ) : undefined
          }
        >
          <Tabs value={tab} onValueChange={setTab} className={s.tabs}>
            <div className={s.tabBar}>
              <TabsList>
                <TabsTrigger value="overview">Overview</TabsTrigger>
                <TabsTrigger value="markdown">Markdown</TabsTrigger>
                <TabsTrigger value="history">History</TabsTrigger>
              </TabsList>
              {!diagOpen && (
                <Button
                  ref={diagBtn}
                  size="sm"
                  variant="ghost"
                  disabled={live.all.length === 0}
                  onClick={() => setShowDiag(true)}
                >
                  Show diagnostics ({live.all.length})
                </Button>
              )}
            </div>
            <TabsContent value="overview" className={s.pane}>
              <OverviewTab
                model={model}
                onField={onField}
                onAddSkill={() => setSkillDialog({ row: null })}
                onEditSkill={(row) => setSkillDialog({ row })}
                onJump={(id) => {
                  const line = entryLine(markdown, id);
                  if (line !== null) jumpToLine(line);
                }}
              />
            </TabsContent>
            {/* Stays mounted while hidden: unmounting would drop CodeMirror's undo history and scroll. */}
            <TabsContent
              value="markdown"
              className={s.editorPane}
              forceMount
              hidden={tab !== 'markdown'} // forceMount skips Radix's own hiding
            >
              <CodeEditor
                language="markdown"
                ariaLabel="Profile markdown"
                fill
                value={markdown}
                onChange={(v) => edit(v, GENERIC_MESSAGE)}
                onSave={save}
                focusLine={focus}
              />
            </TabsContent>
            <TabsContent value="history" className={s.pane}>
              <HistoryTab
                gitAvailable={gitAvailable}
                restoring={revertM.isPending}
                blockedReason={
                  dirty ? 'Save or discard your unsaved edits before restoring a version.' : null
                }
                onRestore={(c) =>
                  revertM.mutate(c.hash, {
                    onSuccess: () => {
                      setExternalWarn(false);
                      toast({ title: 'Version restored', description: c.message, tone: 'ok' });
                    },
                    onError: (e) =>
                      toast({ title: 'Could not restore', description: errMsg(e), tone: 'bad' }),
                  })
                }
              />
            </TabsContent>
          </Tabs>
        </SplitView>
      )}

      {skillDialog && (
        <SkillDialog
          row={skillDialog.row}
          evidenceIds={evidenceIds(model)}
          onSubmit={submitSkill}
          onDelete={(name) => {
            setSkillDialog(null);
            setSkillDelete(name);
          }}
          onClose={() => setSkillDialog(null)}
        />
      )}
      <ConfirmDialog
        open={skillDelete !== null}
        onOpenChange={(o) => {
          if (!o) setSkillDelete(null);
        }}
        title={`Delete skill "${skillDelete ?? ''}"?`}
        description="The row is removed from the profile when you save."
        confirmLabel="Delete"
        danger
        onConfirm={() => {
          if (skillDelete !== null)
            edit(deleteSkill(markdown, skillDelete), `profile: remove skill ${skillDelete}`);
        }}
      />
      {suggestion && (
        <SuggestDialog
          result={suggestion}
          returnFocus={suggestBtn}
          saving={saveM.isPending}
          error={suggestSaveError}
          onSave={saveSuggestion}
          onClose={() => setSuggestion(null)}
        />
      )}
      {review && (
        <ImportDialog
          result={review}
          returnFocus={importBtn}
          current={markdown}
          dirty={dirty}
          saving={saveM.isPending}
          error={reviewError}
          onReplace={replaceWithImport}
          onClose={() => setReview(null)}
        />
      )}
    </Page>
  );
}
