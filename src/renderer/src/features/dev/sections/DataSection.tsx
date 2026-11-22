import { useMemo, useState, type ReactNode } from 'react';
import { Button } from '../../../ui/Button';
import { StatusDot, Tag, type Tone } from '../../../ui/StatusDot';
import { EmptyState } from '../../../ui/States';
import { Table, type Column, type SortState } from '../../../ui/Table';
import { Inspector, SplitView } from '../../../ui/Inspector';
import { DiffView } from '../../../ui/DiffView';
import { diffLines } from '../../../ui/diff';
import { CodeEditor } from '../../../ui/CodeEditor';
import { ScoreMeter } from '../../../ui/ScoreMeter';
import { Stat } from '../../../ui/Stat';
import { Bars } from '../../../ui/Bars';
import { KeyValue, SectionHeader } from '../../../ui/Section';
import profileSeed from '../../../../../../seed/profile/praneethreddy.md?raw';
import resumeSeed from '../../../../../../seed/templates/resume.tex?raw';
import s from './DataSection.module.css';

interface Job {
  id: string;
  title: string;
  company: string;
  location: string;
  score: number;
  status: 'new' | 'saved' | 'applied' | 'rejected';
  posted: string;
}

const TITLES = ['Data Engineer', 'Analytics Engineer', 'Platform Engineer', 'ML Engineer', 'BI Developer'];
const COMPANIES = [
  'Northwind Labs',
  'Tidewater Systems',
  'Brightfield Data',
  'Quarry & Co',
  'Lumen Freight',
  'Oakline Health',
];
const PLACES = ['Berlin', 'Remote (EU)', 'Amsterdam', 'Hamburg', 'Lisbon'];
const STATUS: Job['status'][] = ['new', 'saved', 'applied', 'rejected'];
const STATUS_TONE: Record<Job['status'], Tone> = {
  new: 'signal',
  saved: 'info',
  applied: 'ok',
  rejected: 'bad',
};

const JOBS: Job[] = Array.from({ length: 500 }, (_, i) => ({
  id: `job-${String(i + 1).padStart(3, '0')}`,
  title: TITLES[i % TITLES.length] ?? '',
  company: COMPANIES[(i * 7) % COMPANIES.length] ?? '',
  location: PLACES[(i * 3) % PLACES.length] ?? '',
  score: (i * 37 + 11) % 101,
  status: STATUS[(i * 5) % STATUS.length] ?? 'new',
  posted: `2026-11-${String(1 + (i % 19)).padStart(2, '0')}`,
}));

const THRESHOLDS = { ok: 70, warn: 45 };

const COLUMNS: Column<Job>[] = [
  { id: 'title', header: 'Title', cell: (r) => r.title, width: 'minmax(0, 2fr)', sortable: true },
  { id: 'company', header: 'Company', cell: (r) => r.company, width: 'minmax(0, 1.5fr)', sortable: true },
  { id: 'location', header: 'Location', cell: (r) => r.location, width: 'minmax(0, 1fr)' },
  {
    id: 'status',
    header: 'Status',
    cell: (r) => <StatusDot tone={STATUS_TONE[r.status]}>{r.status}</StatusDot>,
    width: '110px',
  },
  {
    id: 'score',
    header: 'Fit',
    cell: (r) => (
      <ScoreMeter
        value={r.score}
        thresholds={THRESHOLDS}
        label={`Fit score for ${r.title} at ${r.company}`}
      />
    ),
    width: '140px',
    sortable: true,
  },
  {
    id: 'posted',
    header: 'Posted',
    cell: (r) => r.posted,
    width: '112px',
    mono: true,
    align: 'right',
    sortable: true,
  },
];

function sortJobs(rows: Job[], sort: SortState | undefined): Job[] {
  if (!sort) return rows;
  const k = sort.id as keyof Job;
  const dir = sort.dir === 'asc' ? 1 : -1;
  return rows.slice().sort((a, b) => (a[k] < b[k] ? -dir : a[k] > b[k] ? dir : 0));
}

const PROFILE_DIFF = `diff --git a/profile.md b/profile.md
index 3f1c2a1..9b7d4e0 100644
--- a/profile.md
+++ b/profile.md
@@ -1,6 +1,7 @@
 ---
 name: Sample Person
-headline: "Data Analyst"
+headline: "Data Engineer"
+work_authorization: "EU Blue Card"
 location: Berlin, Germany
 ---
@@ -24,5 +25,5 @@ ## Experience
 ### Analyst, Northwind Labs
-- Built weekly reporting in spreadsheets for 4 teams.
+- Replaced weekly spreadsheet reporting with a dbt pipeline serving 4 teams.
 - Cut month-end close from 6 days to 4.
 - Mentored 2 junior analysts.
`;

const SAVED_SUMMARY = `Data engineer with five years building reporting pipelines.
Works mostly in SQL and Python.
Looking for platform roles in the EU.`;

const Block = ({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: ReactNode;
}): React.JSX.Element => (
  <section className={s.block}>
    <SectionHeader title={title} actions={note ? <span className="faint">{note}</span> : undefined} />
    <div className={s.body}>{children}</div>
  </section>
);

export function DataSection(): React.JSX.Element {
  const [sort, setSort] = useState<SortState | undefined>({ id: 'score', dir: 'desc' });
  const [selected, setSelected] = useState<string>();
  const [open, setOpen] = useState<string>();
  const rows = useMemo(() => sortJobs(JOBS, sort), [sort]);
  const job = JOBS.find((j) => j.id === open);

  const [summary, setSummary] = useState(SAVED_SUMMARY);
  const [saved, setSaved] = useState(SAVED_SUMMARY);
  const [profile, setProfile] = useState(profileSeed);
  const [resume, setResume] = useState(resumeSeed);

  return (
    <div className={s.root}>
      <Block title="Stat, ScoreMeter, Bars">
        <div className={s.stats}>
          <Stat label="New this week" value={42} delta={8} deltaLabel="vs last week" />
          <Stat label="Applied" value={11} delta={-3} deltaLabel="vs last week" />
          <Stat label="Avg fit" value="68" />
          <Stat label="Rejected" value={5} delta={2} deltaTone="bad" />
        </div>
        <div className={s.meters}>
          <ScoreMeter value={88} thresholds={THRESHOLDS} label="Fit, good" />
          <ScoreMeter value={54} thresholds={THRESHOLDS} label="Fit, middling" />
          <ScoreMeter value={19} thresholds={THRESHOLDS} label="Fit, poor" />
          <ScoreMeter value={0} thresholds={THRESHOLDS} label="Fit, zero" />
        </div>
        <div className={s.charts}>
          <Bars
            ariaLabel="Applications per week"
            data={[
              { label: 'W41', value: 3 },
              { label: 'W42', value: 5 },
              { label: 'W43', value: 2 },
              { label: 'W44', value: 7 },
              { label: 'W45', value: 4 },
              { label: 'W46', value: 9, highlight: true },
            ]}
          />
          <Bars
            ariaLabel="Funnel by status"
            data={[
              { label: 'saved', value: 24, tone: 'info' },
              { label: 'applied', value: 11, tone: 'ok' },
              { label: 'interview', value: 3, tone: 'warn' },
              { label: 'rejected', value: 5, tone: 'bad' },
              { label: 'empty', value: 0 },
            ]}
          />
        </div>
      </Block>

      <Block
        title="Table, 500 rows, virtualized"
        note="Click, Arrow/J/K, Enter opens the inspector, Esc closes"
      >
        <div className={s.tableBox}>
          <SplitView
            inspector={
              job && (
                <Inspector title={job.title} onClose={() => setOpen(undefined)}>
                  <KeyValue
                    items={[
                      { key: 'Company', value: job.company },
                      { key: 'Location', value: job.location },
                      { key: 'Status', value: <Tag tone={STATUS_TONE[job.status]}>{job.status}</Tag> },
                      { key: 'Fit', value: job.score, mono: true },
                      { key: 'Posted', value: job.posted, mono: true },
                      { key: 'Id', value: job.id, mono: true },
                    ]}
                  />
                </Inspector>
              )
            }
          >
            <Table
              ariaLabel="Jobs"
              columns={COLUMNS}
              rows={rows}
              getRowId={(r) => r.id}
              selectedId={selected}
              onSelectedChange={setSelected}
              onRowClick={(r) => setOpen(r.id)}
              sort={sort}
              onSortChange={setSort}
            />
          </SplitView>
        </div>
        <div className={s.tableBox} data-density="compact">
          <Table
            ariaLabel="Jobs, none match"
            columns={COLUMNS}
            rows={[]}
            getRowId={(r) => r.id}
            empty={
              <EmptyState
                title="No jobs match these filters"
                action={<Button size="sm">Clear filters</Button>}
              />
            }
          />
        </div>
      </Block>

      <Block title="DiffView, git diff of a profile edit">
        <DiffView diff={PROFILE_DIFF} ariaLabel="Profile edit" />
      </Block>

      <Block title="Editor with unsaved-change preview (diffLines)" note="Ctrl+S saves">
        <div className={s.editor}>
          <CodeEditor
            ariaLabel="Summary, Markdown"
            language="markdown"
            value={summary}
            onChange={setSummary}
            onSave={() => setSaved(summary)}
            height={120}
          />
        </div>
        <SectionHeader level={3} title={summary === saved ? 'No unsaved changes' : 'Unsaved changes'} />
        <DiffView diff={diffLines(saved, summary)} ariaLabel="Unsaved changes" />
      </Block>

      <Block title="CodeEditor, Markdown (seed/profile)">
        <CodeEditor
          ariaLabel="Profile, Markdown"
          language="markdown"
          value={profile}
          onChange={setProfile}
          height={280}
        />
      </Block>
      <Block title="CodeEditor, LaTeX (seed/templates/resume.tex)">
        <CodeEditor
          ariaLabel="Resume template, LaTeX"
          language="latex"
          value={resume}
          onChange={setResume}
          height={280}
        />
      </Block>
      <Block title="CodeEditor, read-only">
        <CodeEditor
          ariaLabel="Resume template, read-only"
          language="latex"
          value={resumeSeed.slice(0, 600)}
          readOnly
          height={120}
        />
      </Block>
    </div>
  );
}
