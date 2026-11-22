import { useMemo, useState } from 'react';
import { matchesSkill, canonicalSkillKey, type SkillRow } from '@shared/profile';
import type { GapRow, LedgerRow } from '@shared/skills/schemas';
import { Page } from '../../app/Page';
import {
  Button,
  EmptyState,
  ErrorState,
  Loading,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Tag,
  Table,
  useToast,
  type Column,
} from '../../ui';
import { useProfile, useSaveProfile, type ProfileSnapshot } from '../../lib/profile';
import { useAddLearning, useGaps, useLedger } from '../../lib/skills';
import { deleteSkill, evidenceIds, saveSkill, skillConflict } from '../profile/helpers';
import { SkillDialog } from '../profile/SkillDialog';
import { AddSkillDialog } from './AddSkillDialog';
import { LearningTab } from './LearningTab';
import { loadIgnored, percentText, profileModel, saveIgnored, visibleGaps } from './helpers';
import s from './skills.module.css';

export default function SkillsScreen(): React.JSX.Element {
  return (
    <Page title="Skills" subtitle="Your skills, what the jobs you stored ask for, and what you are learning.">
      <Tabs defaultValue="ledger">
        <TabsList>
          <TabsTrigger value="ledger">Ledger</TabsTrigger>
          <TabsTrigger value="gaps">Gaps</TabsTrigger>
          <TabsTrigger value="learning">Learning</TabsTrigger>
        </TabsList>
        <TabsContent value="ledger">
          <LedgerTab />
        </TabsContent>
        <TabsContent value="gaps">
          <GapsTab />
        </TabsContent>
        <TabsContent value="learning">
          <LearningTab />
        </TabsContent>
      </Tabs>
    </Page>
  );
}

const Retry = ({ onClick }: { onClick: () => void }): React.JSX.Element => (
  <Button onClick={onClick}>Try again</Button>
);

function LedgerTab(): React.JSX.Element {
  const { toast } = useToast();
  const q = useLedger();
  const profile = useProfile();
  const save = useSaveProfile();
  const [editing, setEditing] = useState<SkillRow | null>(null);
  const snapshot = profile.data;
  const model = useMemo(() => (snapshot ? profileModel(snapshot.markdown) : null), [snapshot]);

  if (q.isPending) return <Loading what="Reading your skills" />;
  if (q.isError)
    return (
      <ErrorState
        title="Could not read the skills"
        message={q.error.message}
        action={<Retry onClick={() => void q.refetch()} />}
      />
    );
  if (q.data.length === 0)
    return (
      <EmptyState title="No skills in your profile yet.">
        Add them on the Profile screen, then they show up here with their demand.
      </EmptyState>
    );

  const columns: Column<LedgerRow>[] = [
    { id: 'skill', header: 'Skill', width: 'minmax(140px, 1.4fr)', cell: (r) => r.skill },
    { id: 'category', header: 'Category', width: 'minmax(100px, 1fr)', cell: (r) => r.category },
    { id: 'level', header: 'Level', width: '64px', mono: true, align: 'right', cell: (r) => r.level ?? '—' },
    { id: 'years', header: 'Years', width: '64px', mono: true, align: 'right', cell: (r) => r.years ?? '—' },
    { id: 'last', header: 'Last used', width: '90px', mono: true, cell: (r) => r.lastUsed || '—' },
    { id: 'status', header: 'Status', width: '90px', cell: (r) => r.status },
    {
      id: 'demand',
      header: 'Demand',
      width: '80px',
      mono: true,
      align: 'right',
      cell: (r) => percentText(r.demand?.share),
    },
    {
      id: 'learning',
      header: 'Learning',
      width: '100px',
      cell: (r) => (r.learning ? <Tag>{r.learning.status}</Tag> : '—'),
    },
  ];

  const edit = (r: LedgerRow): void => {
    const row = model?.skills.find((x) => matchesSkill(x, r.skill));
    if (row) setEditing(row);
  };
  const submit = (row: SkillRow, previous: string | null): string | null => {
    if (!snapshot || !model) return 'The profile is still loading.';
    const clash = skillConflict(model.skills, row, previous);
    if (clash) return `${clash.skill} is already in the profile — edit it instead.`;
    const renamed = previous !== null && canonicalSkillKey(previous) !== canonicalSkillKey(row.skill);
    const base = renamed ? deleteSkill(snapshot.markdown, previous) : snapshot.markdown;
    save.mutate(
      { markdown: saveSkill(base, row), message: `profile: update skill ${row.skill}` },
      {
        onSuccess: () => {
          setEditing(null);
          toast({ title: `Saved ${row.skill}`, tone: 'ok' });
        },
        onError: (e) => toast({ title: 'Could not save the profile', description: e.message, tone: 'bad' }),
      },
    );
    return null;
  };

  return (
    <div className={s.screen}>
      <p className={s.hint}>Enter or click a row to edit it. The profile file is saved and committed.</p>
      <div className={s.screenTable}>
        <Table
          ariaLabel="Skill ledger"
          columns={columns}
          rows={q.data}
          getRowId={(r) => r.skill}
          onRowClick={edit}
        />
      </div>
      {editing && model && (
        <SkillDialog
          row={editing}
          evidenceIds={evidenceIds(model)}
          onSubmit={submit}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function GapsTab(): React.JSX.Element {
  const { toast } = useToast();
  const q = useGaps();
  const profile = useProfile();
  const addLearning = useAddLearning();
  const [ignored, setIgnored] = useState(loadIgnored);
  const [have, setHave] = useState<{ skill: string; snapshot: ProfileSnapshot } | null>(null);

  if (q.isPending) return <Loading what="Ranking missing skills" />;
  if (q.isError)
    return (
      <ErrorState
        title="Could not read the gaps"
        message={q.error.message}
        action={<Retry onClick={() => void q.refetch()} />}
      />
    );
  const rows = visibleGaps(q.data, ignored);
  if (rows.length === 0)
    return (
      <EmptyState title={q.data.length === 0 ? 'No gaps.' : 'Nothing left to decide.'}>
        {q.data.length === 0
          ? 'Skills named by your stored jobs and missing from your profile show up here, ranked by demand.'
          : `${String(q.data.length)} ignored. They return if you clear this browser's site data.`}
      </EmptyState>
    );

  const ignore = (skill: string): void => {
    const next = [...ignored, skill];
    setIgnored(next);
    saveIgnored(next);
    toast({
      title: `Ignored ${skill}`,
      action: {
        label: 'Undo',
        onClick: () => {
          setIgnored(ignored);
          saveIgnored(ignored);
        },
      },
    });
  };
  const learn = (g: GapRow): void =>
    addLearning.mutate(g.skill, {
      onSuccess: () => toast({ title: `Added ${g.skill} to Learning` }),
      onError: (e) => toast({ title: `Could not add ${g.skill}`, description: e.message, tone: 'bad' }),
    });

  const columns: Column<GapRow>[] = [
    {
      id: 'skill',
      header: 'Skill',
      width: 'minmax(140px, 1.4fr)',
      cell: (g) => (
        <>
          {g.skill} {g.inProfile && <Tag>{`profile: ${g.inProfile}`}</Tag>}
        </>
      ),
    },
    {
      id: 'required',
      header: 'Required',
      width: '90px',
      mono: true,
      align: 'right',
      cell: (g) => percentText(g.demand.requiredShare),
    },
    { id: 'jobs', header: 'Jobs', width: '64px', mono: true, align: 'right', cell: (g) => g.demand.jobCount },
    {
      id: 'priority',
      header: 'Priority',
      width: '88px',
      mono: true,
      align: 'right',
      cell: (g) => g.priority,
    },
    {
      id: 'actions',
      header: 'Actions',
      width: '280px',
      cell: (g) => {
        const learning = g.learning && g.learning.status !== 'dropped';
        return (
          <span className={s.rowActions}>
            <Button size="sm" disabled={!!learning || addLearning.isPending} onClick={() => learn(g)}>
              {learning ? 'In Learning' : 'Learn'}
            </Button>
            <Button
              size="sm"
              disabled={!profile.data}
              onClick={() => profile.data && setHave({ skill: g.skill, snapshot: profile.data })}
            >
              I have it
            </Button>
            <Button size="sm" variant="ghost" onClick={() => ignore(g.skill)}>
              Ignore
            </Button>
          </span>
        );
      },
    },
  ];

  return (
    <div className={s.screen}>
      <div className={s.screenTable}>
        <Table ariaLabel="Skill gaps" columns={columns} rows={rows} getRowId={(g) => g.skill} />
      </div>
      {have && (
        <AddSkillDialog
          skill={have.skill}
          before={have.snapshot.markdown}
          expectedHash={have.snapshot.hash}
          onClose={() => setHave(null)}
        />
      )}
    </div>
  );
}
