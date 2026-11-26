import { Link } from '@tanstack/react-router';
import { ChevronDown } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { CANCELLED_MESSAGE } from '@shared/messages';
import { useRegisterCommands, type Command } from '../../../app/commands';
import {
  Button,
  CodeEditor,
  ConfirmDialog,
  DropdownMenu,
  EmptyState,
  ErrorState,
  Inspector,
  Input,
  Loading,
  Select,
  SplitView,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Tag,
  useToast,
} from '../../../ui';
import { useElapsedSeconds } from '../../../lib/hooks';
import { cancelTask } from '../../../lib/jobs';
import { base64ToBytes } from '../../../lib/latex';
import {
  exportDoc,
  openInOverleaf,
  useDocProgress,
  useDocVersion,
  useDocVersions,
  useGenerateDoc,
  useMarkFinal,
  useReviseDoc,
  useSaveManualDoc,
  useTranslateDoc,
  type DocKind,
  type DocView,
} from '../../../lib/resume';
import { useAiSettings } from '../../../lib/settings';
import { PdfCanvas } from '../../rules/PdfCanvas';
import { SkillsPanel } from '../../skills/SkillsPanel';
import { ChangesPanel } from './ChangesPanel';
import { ChecksPanel } from './ChecksPanel';
import {
  DOC_COPY,
  FINAL_NOTE_MANUAL,
  effectiveVersion,
  modelLabel,
  pagesText,
  reviseBlocker,
  stageLabel,
  translateBlocker,
  versionLabel,
} from './helpers';
import s from './resume.module.css';

/** What Copy, Download and Open in Overleaf can do with a version. */
type Action = 'copy' | 'tex' | 'pdf' | 'overleaf';
type Run = { kind: 'draft' } | { kind: 'revise'; instruction: string } | { kind: 'translate' };

const SETTINGS: string = '/settings';
const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * The Resume or Cover letter tab of a job (same layout, `kind` picks the channels and wording). Always mounted
 * (the job page keeps it hidden on other tabs), so a running draft survives switching tabs and the palette
 * commands work from anywhere on the page. Only the resume has the ATS check and the Skills panel.
 */
export function ResumeTab({
  kind = 'resume',
  jobId,
  analyzed,
  onActivate,
}: {
  kind?: DocKind;
  jobId: string;
  /** The job has a fit analysis, so Analyze fit is no longer the page's primary action. */
  analyzed: boolean;
  /** Brings this tab to the front (palette commands). */
  onActivate: () => void;
}): React.JSX.Element {
  const { toast } = useToast();
  const copy = DOC_COPY[kind];
  const versions = useDocVersions(kind, jobId);
  const list = useMemo(() => versions.data ?? [], [versions.data]);
  const [picked, setPicked] = useState<number | null>(null);
  const version = effectiveVersion(list, picked);
  const summary = list.find((v) => v.meta.version === version);
  const docQ = useDocVersion(kind, jobId, version);
  const doc = docQ.data;

  const generate = useGenerateDoc(kind, jobId);
  const revise = useReviseDoc(kind, jobId);
  const saveManual = useSaveManualDoc(kind, jobId);
  const markFinal = useMarkFinal(kind, jobId);
  const translate = useTranslateDoc(kind, jobId);
  const running = generate.isPending || revise.isPending || translate.isPending;
  const [requestId, setRequestId] = useState<string | null>(null);
  const progress = useDocProgress(kind, requestId);
  const secs = useElapsedSeconds(running);
  const [runError, setRunError] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<Run>({ kind: 'draft' });

  const [draft, setDraft] = useState<{ version: number; tex: string } | null>(null);
  const [instruction, setInstruction] = useState('');
  const [gate, setGate] = useState<Action | null>(null);
  const [showReview, setShowReview] = useState(true);
  const [inspTab, setInspTab] = useState('checks');
  const reviseInput = useRef<HTMLInputElement>(null);
  const aiSettings = useAiSettings();

  const model = aiSettings.data?.models[copy.task].model;
  const text = draft?.version === version && doc ? draft.tex : (doc?.tex ?? '');
  const dirty = doc !== undefined && draft?.version === version && draft.tex !== doc.tex;
  const truth = doc?.checks.truth ?? null;
  const blocked = truth !== null && !truth.ok;
  const manual = doc !== undefined && doc.content === null;
  const german = doc?.meta.language === 'de';
  const blocker = reviseBlocker({ hasVersion: doc !== undefined, manual, dirty, running, german });
  const noGerman = translateBlocker({ manual, dirty, german });

  const start = (run: Run): void => {
    if (running) return;
    if (run.kind === 'translate' && noGerman) {
      toast({ title: noGerman });
      return;
    }
    const id = crypto.randomUUID();
    setLastRun(run);
    setRequestId(id);
    setRunError(null);
    onActivate();
    const opts = {
      onSuccess: (v: DocView) => {
        setPicked(v.meta.version);
        setDraft(null);
        if (run.kind === 'revise') setInstruction('');
      },
      onError: (e: Error) => {
        if (e.message === CANCELLED_MESSAGE) toast({ title: 'Cancelled' });
        else setRunError(e.message);
      },
    };
    if (run.kind === 'draft') generate.mutate({ requestId: id }, opts);
    else if (run.kind === 'translate') {
      if (version !== null) translate.mutate({ requestId: id, fromVersion: version }, opts);
    } else if (version !== null)
      revise.mutate({ requestId: id, fromVersion: version, instruction: run.instruction }, opts);
  };

  const submitRevise = (): void => {
    const t = instruction.trim();
    if (t && !blocker && !running) start({ kind: 'revise', instruction: t });
  };

  const save = (): void => {
    if (!dirty || saveManual.isPending) return;
    saveManual.mutate(
      { fromVersion: version, tex: text },
      {
        onSuccess: (v) => {
          setPicked(v.meta.version);
          setDraft(null);
          toast({ title: `Saved as v${String(v.meta.version)}` });
        },
        onError: (e) => toast({ title: 'Could not save', description: e.message, tone: 'bad' }),
      },
    );
  };

  const perform = async (action: Action): Promise<void> => {
    if (version === null) return;
    try {
      if (action === 'copy') {
        await navigator.clipboard.writeText(text);
        toast({ title: 'LaTeX copied' });
      } else if (action === 'overleaf') {
        await openInOverleaf(kind, jobId, version);
        toast({ title: 'Opened in your browser' });
      } else {
        const r = await exportDoc(kind, jobId, version, action);
        if (r.status === 'saved') toast({ title: 'Saved', description: r.path });
      }
    } catch (e) {
      toast({
        title: `Could not ${action === 'copy' ? 'copy' : action === 'overleaf' ? 'open Overleaf' : 'export'}`,
        description: errorText(e),
        tone: 'bad',
      });
    }
  };
  /** Overleaf always asks (it leaves the machine); anything else asks only for a draft that failed the truth check. */
  const request = (action: Action): void => {
    if (version === null || !doc) return;
    if (blocked || action === 'overleaf') setGate(action);
    else void perform(action);
  };

  // Palette handlers see the latest state without re-registering.
  const act = useRef({ start, request, save, focusRevise: () => undefined });
  useEffect(() => {
    act.current = {
      start,
      request,
      save,
      focusRevise: () => {
        onActivate();
        setTimeout(() => reviseInput.current?.focus(), 60);
      },
    };
  });
  const commands = useMemo<Command[]>(
    () => [
      {
        id: `${kind}.draft`,
        label: copy.draft,
        group: kind === 'cover' ? 'Cover letter' : 'Resume',
        run: () => act.current.start({ kind: 'draft' }),
      },
      {
        id: `${kind}.revise`,
        label: copy.revise,
        group: kind === 'cover' ? 'Cover letter' : 'Resume',
        run: () => act.current.focusRevise(),
      },
      {
        id: `${kind}.translate`,
        label: kind === 'cover' ? 'German version of this cover letter' : 'German version of this resume',
        group: kind === 'cover' ? 'Cover letter' : 'Resume',
        run: () => act.current.start({ kind: 'translate' }),
      },
      // One Copy / Overleaf command, for the resume; the cover letter has the buttons.
      ...(kind === 'cover'
        ? []
        : [
            {
              id: 'resume.copy',
              label: 'Copy LaTeX',
              group: 'Resume',
              run: () => act.current.request('copy'),
            },
            {
              id: 'resume.overleaf',
              label: 'Open in Overleaf',
              group: 'Resume',
              run: () => act.current.request('overleaf'),
            },
          ]),
    ],
    [kind, copy],
  );
  useRegisterCommands(`workspace.${kind}`, commands);

  const runningStrip = running && (
    <div className={s.running}>
      <Loading what={`${stageLabel(progress)} · ${String(secs)} s`} />
      <Button size="sm" onClick={() => requestId && void cancelTask(requestId)}>
        Cancel
      </Button>
    </div>
  );
  const failure = runError && (
    <ErrorState
      title={
        lastRun.kind === 'draft'
          ? copy.failDraft
          : lastRun.kind === 'translate'
            ? copy.failTranslate
            : copy.failRevise
      }
      message={runError}
      action={<Button onClick={() => start(lastRun)}>Try again</Button>}
    />
  );

  if (versions.isPending) return <Loading what="Reading resume versions" />;
  if (versions.isError)
    return (
      <ErrorState
        title={`Could not read the ${kind === 'cover' ? 'cover letter' : 'resume'} versions`}
        message={versions.error.message}
        action={<Button onClick={() => void versions.refetch()}>Try again</Button>}
      />
    );

  if (list.length === 0)
    return (
      <div className={s.tab}>
        {runningStrip}
        {failure}
        {!running && (
          <div className={s.empty}>
            <EmptyState
              title={copy.empty}
              action={
                <Button variant={analyzed ? 'primary' : 'secondary'} onClick={() => start({ kind: 'draft' })}>
                  {copy.draft}
                </Button>
              }
            >
              {copy.emptyBody}
            </EmptyState>
            <p className={s.quiet}>
              Uses {copy.rules} · {model ? modelLabel(model) : 'Claude'}
            </p>
          </div>
        )}
      </div>
    );

  const reviewTitle = `Review v${String(version ?? '')}`;
  return (
    <div className={s.tab}>
      {runningStrip}
      {failure}
      {summary?.stale && (
        <div className={s.banner} role="status">
          <p>Your profile, rules or template changed since this version.</p>
          <Button size="sm" busy={running} onClick={() => start({ kind: 'draft' })}>
            Regenerate
          </Button>
        </div>
      )}
      {truth && !truth.ok && (
        <ErrorState
          title={`Truth check failed: ${String(truth.violations.length)} ${truth.violations.length === 1 ? 'violation remains' : 'violations remain'} after the repair`}
          message={truth.violations.map((v) => `${v.text} — ${v.detail}`).join('\n')}
          action={<p className={s.quiet}>Copy, Download and Open in Overleaf ask for confirmation.</p>}
        />
      )}

      {docQ.isPending && <Loading what="Reading this version" />}
      {docQ.isError && (
        <ErrorState
          title="Could not read this version"
          message={docQ.error.message}
          action={<Button onClick={() => void docQ.refetch()}>Try again</Button>}
        />
      )}
      {doc && summary && (
        <>
          <div className={s.head}>
            <span className={s.version}>v{version}</span>
            {german && <Tag>German</Tag>}
            {doc.meta.isFinal && <Tag tone="ok">Final</Tag>}
            <span className={s.meta}>
              {doc.meta.createdAt.slice(0, 10)} ·{' '}
              {doc.meta.model ? modelLabel(doc.meta.model) : 'edited by hand'}
              {doc.meta.parentVersion !== null && ` · from v${String(doc.meta.parentVersion)}`}
            </span>
            <Button
              size="sm"
              variant="ghost"
              aria-pressed={showReview}
              onClick={() => setShowReview(!showReview)}
            >
              Checks and changes
            </Button>
          </div>

          <div className={`${s.work} ${showReview && inspTab === 'skills' ? s.workWide : ''}`}>
            <SplitView
              inspector={
                showReview && (
                  <Inspector title={reviewTitle} onClose={() => setShowReview(false)}>
                    <Tabs value={inspTab} onValueChange={setInspTab}>
                      <TabsList>
                        <TabsTrigger value="checks">Checks</TabsTrigger>
                        <TabsTrigger value="changes">Changes</TabsTrigger>
                        {kind === 'resume' && <TabsTrigger value="skills">Skills</TabsTrigger>}
                      </TabsList>
                      <TabsContent value="checks">
                        <ChecksPanel doc={doc} />
                      </TabsContent>
                      <TabsContent value="changes">
                        <ChangesPanel kind={kind} jobId={jobId} doc={doc} />
                      </TabsContent>
                      {kind === 'resume' && (
                        <TabsContent value="skills">
                          <SkillsPanel
                            jobId={jobId}
                            version={doc.meta.version}
                            onVersion={(v) => {
                              setPicked(v);
                              setDraft(null);
                            }}
                            onRegenerate={() => start({ kind: 'draft' })}
                          />
                        </TabsContent>
                      )}
                    </Tabs>
                  </Inspector>
                )
              }
            >
              <div className={s.panes}>
                <section className={s.pane} aria-label="LaTeX source">
                  <div className={s.paneHead}>
                    <h3 className={s.micro}>LaTeX</h3>
                    <div className={s.row}>
                      {dirty && (
                        <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
                          Discard
                        </Button>
                      )}
                      <Button size="sm" busy={saveManual.isPending} disabled={!dirty} onClick={save}>
                        Save as new version
                      </Button>
                    </div>
                  </div>
                  {(dirty || doc.meta.userEdited) && (
                    <p className={s.note}>
                      {dirty && 'Unsaved edits: the preview and checks show the saved version. '}
                      {FINAL_NOTE_MANUAL}
                    </p>
                  )}
                  <div className={s.editorBox}>
                    <CodeEditor
                      language="latex"
                      fill
                      ariaLabel={copy.latex}
                      value={text}
                      onChange={(t) => setDraft({ version: doc.meta.version, tex: t })}
                      onSave={() => act.current.save()}
                    />
                  </div>
                </section>
                <section className={s.pane} aria-label="PDF preview">
                  <div className={s.paneHead}>
                    <h3 className={s.micro}>Preview</h3>
                    {doc.checks.compile && (
                      <Tag tone={doc.checks.compile.ok ? 'neutral' : 'bad'}>
                        {doc.checks.compile.ok ? pagesText(doc.checks.compile.pages) : 'Compile failed'}
                      </Tag>
                    )}
                  </div>
                  <div className={s.previewBox}>
                    <Preview doc={doc} />
                  </div>
                </section>
              </div>
            </SplitView>
          </div>

          <div className={s.bar}>
            <div className={s.row}>
              <div className={s.revise}>
                <Input
                  ref={reviseInput}
                  aria-label="Revise instruction"
                  placeholder="Tell Stellio what to change…"
                  value={instruction}
                  disabled={running}
                  onChange={(e) => setInstruction(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      submitRevise();
                    }
                  }}
                />
              </div>
              <Button
                busy={revise.isPending}
                disabled={running || !instruction.trim() || blocker !== null}
                onClick={submitRevise}
              >
                {revise.isPending ? 'Revising…' : 'Revise'}
              </Button>
            </div>
            {blocker && <p className={s.quiet}>{blocker}</p>}
            <div className={s.row}>
              <label htmlFor={`${kind}-version`} className={s.micro}>
                Version
              </label>
              <div className={s.versionPick}>
                <Select
                  id={`${kind}-version`}
                  size="sm"
                  value={String(version)}
                  onValueChange={(v) => {
                    setPicked(Number(v));
                    setDraft(null);
                  }}
                  options={[...list].reverse().map((v) => ({
                    value: String(v.meta.version),
                    label: versionLabel(v),
                  }))}
                />
              </div>
              <Button
                busy={translate.isPending}
                disabled={running || noGerman !== null}
                title={noGerman ?? undefined}
                onClick={() => start({ kind: 'translate' })}
              >
                {translate.isPending ? 'Translating…' : 'German version'}
              </Button>
              <span className={s.spacer} />
              <Button onClick={() => request('copy')}>Copy LaTeX</Button>
              <Button disabled={dirty} onClick={() => request('overleaf')}>
                Open in Overleaf
              </Button>
              <DropdownMenu
                align="end"
                items={[
                  { label: 'Download .tex', onSelect: () => request('tex'), disabled: dirty },
                  {
                    label: 'Download .pdf',
                    onSelect: () => request('pdf'),
                    disabled: dirty || !doc.pdfBase64,
                  },
                ]}
                trigger={<Button icon={<ChevronDown aria-hidden="true" />}>Download</Button>}
              />
              <Button
                busy={markFinal.isPending}
                disabled={doc.meta.isFinal || dirty}
                onClick={() =>
                  markFinal.mutate(doc.meta.version, {
                    onSuccess: () => toast({ title: `v${String(doc.meta.version)} marked final` }),
                    onError: (e) =>
                      toast({ title: 'Could not mark final', description: e.message, tone: 'bad' }),
                  })
                }
              >
                {doc.meta.isFinal ? 'Final' : 'Mark final'}
              </Button>
            </div>
          </div>
        </>
      )}

      <ConfirmDialog
        open={gate !== null}
        onOpenChange={(o) => {
          if (!o) setGate(null);
        }}
        title={blocked ? 'Use this version anyway?' : 'Open in Overleaf?'}
        description={gateText(gate, blocked ? truth.violations.length : 0)}
        confirmLabel={blocked ? 'Use anyway' : 'Open in Overleaf'}
        onConfirm={() => gate && void perform(gate)}
      />
    </div>
  );
}

/** The confirmation text: what leaves the machine (Overleaf) and what failed the truth check. */
function gateText(action: Action | null, violations: number): string {
  const what =
    action === 'copy'
      ? 'copy it'
      : action === 'overleaf'
        ? 'open it in Overleaf'
        : `save it as .${action ?? 'tex'}`;
  const parts: string[] = [];
  if (violations > 0)
    parts.push(
      `This version has ${String(violations)} truth ${violations === 1 ? 'violation' : 'violations'}: claims Stellio could not trace to your profile. Check them before you send it anywhere. Continue and ${what}?`,
    );
  if (action === 'overleaf')
    parts.push('Open in Overleaf sends the full LaTeX of this version to overleaf.com through your browser.');
  return parts.join(' ');
}

/** Page 1 of the compiled PDF, or why there is none. */
function Preview({ doc }: { doc: DocView }): React.JSX.Element {
  const bytes = useMemo(() => (doc.pdfBase64 ? base64ToBytes(doc.pdfBase64) : null), [doc.pdfBase64]);
  const c = doc.checks.compile;
  if (bytes) return <PdfCanvas bytes={bytes} label="PDF preview, page 1" />;
  if (c === null)
    return (
      <EmptyState
        title="No LaTeX engine found."
        action={
          <Link to={SETTINGS} search={{ section: 'latex' }} className={s.quiet}>
            Set up in Settings
          </Link>
        }
      >
        A preview needs Tectonic, a small local LaTeX engine.
      </EmptyState>
    );
  return (
    <ErrorState
      title="No preview"
      message={
        c.errors
          .map((e) => (e.line !== undefined ? `line ${String(e.line)}: ${e.message}` : e.message))
          .join('\n') || 'The PDF is missing or over 5 MB.'
      }
    />
  );
}
