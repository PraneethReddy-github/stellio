import { useState } from 'react';
import type { SkillAuditRow } from '@shared/skills/schemas';
import { Button, EmptyState, ErrorState, Kbd, Loading, Table, Tag, useToast, type Column } from '../../ui';
import { useElapsedSeconds } from '../../lib/hooks';
import { useDecideSkill, useRecordApproval, useSkillAudit } from '../../lib/skills';
import { AddSkillDialog } from './AddSkillDialog';
import {
  ACTION_KEY,
  IMPORTANCE_LABEL,
  ORIGIN_LABEL,
  RECOMMENDATION_LABEL,
  RECOMMENDATION_TONE,
  actionBlocker,
  hoursText,
  percentText,
  type AuditAction,
} from './helpers';
import s from './skills.module.css';

const COLUMNS: Column<SkillAuditRow>[] = [
  { id: 'skill', header: 'Skill', width: '110px', cell: (r) => r.skill },
  { id: 'origin', header: 'Origin', width: '100px', cell: (r) => ORIGIN_LABEL[r.origin] },
  { id: 'jd', header: 'JD', width: '80px', cell: (r) => IMPORTANCE_LABEL[r.jdImportance] },
  {
    id: 'rec',
    header: 'Advice',
    width: '128px',
    cell: (r) => (
      <Tag tone={RECOMMENDATION_TONE[r.recommendation]}>{RECOMMENDATION_LABEL[r.recommendation]}</Tag>
    ),
  },
  { id: 'why', header: 'Rationale', width: 'minmax(100px, 1fr)', cell: (r) => r.rationale ?? '—' },
  { id: 'hours', header: 'Learn', width: '136px', mono: true, cell: (r) => hoursText(r.learnEstimateHours) },
  {
    id: 'demand',
    header: 'Demand',
    width: '84px',
    mono: true,
    align: 'right',
    cell: (r) => percentText(r.demand?.share),
  },
];

const BUTTONS: { action: AuditAction; label: string; key: string }[] = [
  { action: 'keep', label: 'Keep', key: 'K' },
  { action: 'remove', label: 'Remove', key: 'R' },
  { action: 'learn', label: 'Learn', key: 'L' },
  { action: 'add_to_profile', label: 'Add to profile', key: 'A' },
];

/**
 * The per-resume skill audit (docs/07 §2-3). Decisions act on the focused row: K keep, R remove, L learn,
 * A add to profile (arrow keys move; K is a decision here, not "up").
 */
export function SkillsPanel({
  jobId,
  version,
  onVersion,
  onRegenerate,
}: {
  jobId: string;
  version: number;
  /** A keep or remove stored a new resume version: show it. */
  onVersion: (version: number) => void;
  onRegenerate: () => void;
}): React.JSX.Element {
  const { toast } = useToast();
  const audit = useSkillAudit(jobId, version);
  const decide = useDecideSkill(jobId);
  const approve = useRecordApproval(jobId);
  const secs = useElapsedSeconds(audit.isPending);
  const [selected, setSelected] = useState<string>();
  const [add, setAdd] = useState<{ skill: string; before: string; expectedHash: string } | null>(null);

  if (audit.isPending) return <Loading what={`Auditing skills · ${String(secs)} s`} />;
  if (audit.isError)
    return (
      <ErrorState
        title="Could not audit the skills"
        message={audit.error.message}
        action={<Button onClick={() => void audit.refetch()}>Try again</Button>}
      />
    );
  const { rows, aiWarning } = audit.data;
  if (rows.length === 0)
    return (
      <EmptyState title="No skills to review.">
        This resume and the posting name no skills from the dictionary.
      </EmptyState>
    );

  const row = rows.find((r) => r.skill === selected) ?? rows[0];
  const blocker = (a: AuditAction): string | null => (row ? actionBlocker(row, a) : 'No skill selected');

  const run = (action: AuditAction): void => {
    if (!row || decide.isPending || blocker(action)) return;
    decide.mutate(
      { version, skill: row.skill, decision: action },
      {
        onSuccess: (r) => {
          if (action === 'add_to_profile' && r.profilePreview)
            setAdd({
              skill: row.skill,
              before: r.profilePreview.before,
              expectedHash: r.profilePreview.expectedHash,
            });
          else if (r.newVersion !== undefined) {
            toast({
              title: `${action === 'remove' ? 'Removed' : 'Kept'} ${row.skill} — v${String(r.newVersion)}`,
            });
            onVersion(r.newVersion);
          } else if (action === 'learn') toast({ title: `Added ${row.skill} to Learning` });
        },
        onError: (e) =>
          toast({
            title: `Could not ${action.replace('_', ' ')} ${row.skill}`,
            description: e.message,
            tone: 'bad',
          }),
      },
    );
  };

  return (
    <div
      className={s.panel}
      onKeyDownCapture={(e) => {
        const action = ACTION_KEY[e.key.toLowerCase()];
        if (
          !action ||
          e.ctrlKey ||
          e.metaKey ||
          e.altKey ||
          e.target !== e.currentTarget.querySelector('[role=grid]')
        )
          return;
        e.preventDefault();
        e.stopPropagation(); // the table would read K as "up"
        run(action);
      }}
    >
      {aiWarning && (
        <p className={s.warn} role="status">
          Rationale and hour estimates are missing: {aiWarning} The recommendations are complete.
        </p>
      )}
      <div className={s.toolbar} role="toolbar" aria-label="Skill decisions">
        {BUTTONS.map((b) => (
          <Button
            key={b.action}
            size="sm"
            busy={decide.isPending && decide.variables.decision === b.action}
            disabled={blocker(b.action) !== null || decide.isPending}
            title={blocker(b.action) ?? undefined}
            onClick={() => run(b.action)}
          >
            {b.label} <Kbd keys={b.key} />
          </Button>
        ))}
      </div>
      <p className={s.detail} aria-live="polite">
        {row && (
          <>
            <strong>{row.skill}</strong>
            {row.rationale ? ` — ${row.rationale}` : ''}
            {row.adjacentTo ? ` Close to ${row.adjacentTo} in your profile.` : ''}
          </>
        )}
      </p>
      <div className={s.tableBox}>
        <Table
          ariaLabel="Skill audit"
          columns={COLUMNS}
          rows={rows}
          getRowId={(r) => r.skill}
          selectedId={row?.skill}
          onSelectedChange={setSelected}
        />
      </div>
      {add && (
        <AddSkillDialog
          skill={add.skill}
          before={add.before}
          expectedHash={add.expectedHash}
          onSaved={() => approve.mutateAsync(add.skill)}
          regenerate={onRegenerate}
          onClose={() => setAdd(null)}
        />
      )}
    </div>
  );
}
