import { useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import type { Entry, Profile, SkillRow } from '@shared/profile';
import { Button, Field, Input, SectionHeader, Select, StatusDot, Table, type Column } from '../../ui';
import type { Tone } from '../../ui';
import { entryMeta, formatList, parseList, parseNumberOrNull, sortSkills } from './helpers';
import s from './profile.module.css';

const IDENTITY: { path: string; label: string; read: (m: Profile) => string }[] = [
  { path: 'name', label: 'Name', read: (m) => m.frontMatter.name },
  { path: 'headline', label: 'Headline', read: (m) => m.frontMatter.headline },
  { path: 'email', label: 'Email', read: (m) => m.frontMatter.email },
  { path: 'phone', label: 'Phone', read: (m) => m.frontMatter.phone },
  { path: 'location', label: 'Location', read: (m) => m.frontMatter.location },
  { path: 'links.linkedin', label: 'LinkedIn', read: (m) => m.frontMatter.links.linkedin },
  { path: 'links.github', label: 'GitHub', read: (m) => m.frontMatter.links.github },
  { path: 'links.portfolio', label: 'Portfolio', read: (m) => m.frontMatter.links.portfolio },
  { path: 'work_authorization', label: 'Work authorization', read: (m) => m.frontMatter.work_authorization },
  { path: 'notice_period', label: 'Notice period', read: (m) => m.frontMatter.notice_period },
];

const REMOTE = ['any', 'onsite', 'hybrid', 'remote'].map((v) => ({ value: v, label: v }));
const STATUS_TONE: Record<string, Tone> = { have: 'ok', learning: 'info', want: 'neutral' };

/**
 * Text input whose value is typed text but whose source of truth is a parsed value (list, number).
 * Typing "a, " must not be rewritten to "a" under the cursor, so the text only resyncs when the
 * parsed value changed from outside.
 */
function ParsedInput<T>({
  value,
  parse,
  format,
  equal,
  onValue,
  ...rest
}: {
  value: T;
  parse: (text: string) => T;
  format: (v: T) => string;
  equal: (a: T, b: T) => boolean;
  onValue: (v: T) => void;
} & Omit<React.ComponentProps<typeof Input>, 'value' | 'onChange'>): React.JSX.Element {
  const [text, setText] = useState(() => format(value));
  // Resync only when the model moved away from what the text parses to (reload, raw edit).
  if (!equal(parse(text), value)) setText(format(value));
  return (
    <Input
      {...rest}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        onValue(parse(e.target.value));
      }}
    />
  );
}

const sameList = (a: string[], b: string[]): boolean => a.join('\u0000') === b.join('\u0000');

function ListInput({
  value,
  onValue,
  ...rest
}: { value: string[]; onValue: (v: string[]) => void } & Omit<
  React.ComponentProps<typeof Input>,
  'value' | 'onChange'
>): React.JSX.Element {
  return (
    <ParsedInput
      {...rest}
      value={value}
      parse={parseList}
      format={formatList}
      equal={sameList}
      onValue={onValue}
    />
  );
}

const Dash = (): React.JSX.Element => <span className={s.dash}>—</span>;

const bulletLabel = (n: number): string => `${String(n)} ${n === 1 ? 'bullet' : 'bullets'}`;

function EntryList({
  title,
  entries,
  note,
  onJump,
}: {
  title: string;
  entries: Entry[];
  note?: string;
  onJump: (id: string) => void;
}): React.JSX.Element {
  return (
    <section className={s.section} aria-label={title}>
      <SectionHeader title={title} />
      {note && <p className={`${s.note} ${s.entriesNote}`}>{note}</p>}
      {entries.length === 0 ? (
        <p className={s.muted}>None yet.</p>
      ) : (
        <ul className={s.entries}>
          {entries.map((e, i) => {
            const body = (
              <>
                <span>{e.title || '(untitled)'}</span>
                <span className={s.mono}>{entryMeta(e)}</span>
                <span className={`${s.mono} ${s.right}`}>{bulletLabel(e.bullets.length)}</span>
              </>
            );
            return (
              <li key={`${e.id}-${String(i)}`}>
                {e.id === '' ? (
                  <div className={s.entry}>{body}</div>
                ) : (
                  <button type="button" className={s.entry} onClick={() => onJump(e.id)}>
                    {body}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

const skillColumns: Column<SkillRow>[] = [
  { id: 'skill', header: 'Skill', cell: (r) => r.skill, width: 'minmax(120px, 1.4fr)' },
  { id: 'category', header: 'Category', cell: (r) => r.category, width: '96px' },
  {
    id: 'level',
    header: 'Level',
    cell: (r) => r.level ?? <Dash />,
    width: '72px',
    align: 'right',
    mono: true,
  },
  {
    id: 'years',
    header: 'Years',
    cell: (r) => r.years ?? <Dash />,
    width: '72px',
    align: 'right',
    mono: true,
  },
  { id: 'last_used', header: 'Last used', cell: (r) => r.last_used || <Dash />, width: '104px', mono: true },
  {
    id: 'evidence',
    header: 'Evidence',
    cell: (r) => (r.evidence.length > 0 ? r.evidence.join(', ') : <Dash />),
    width: 'minmax(120px, 2fr)',
    mono: true,
  },
  {
    id: 'status',
    header: 'Status',
    cell: (r) => <StatusDot tone={STATUS_TONE[r.status] ?? 'neutral'}>{r.status}</StatusDot>,
    width: '104px',
  },
];

export function OverviewTab({
  model,
  onField,
  onAddSkill,
  onEditSkill,
  onJump,
}: {
  model: Profile;
  /** Dotted front matter path + new value. */
  onField: (path: string, value: unknown, section: 'identity' | 'preferences') => void;
  onAddSkill: () => void;
  onEditSkill: (row: SkillRow) => void;
  onJump: (id: string) => void;
}): React.JSX.Element {
  const p = model.frontMatter.preferences;
  const rows = Math.min(model.skills.length + 1, 12);
  const skills = useMemo(() => sortSkills(model.skills), [model.skills]);
  return (
    <div className={s.overview}>
      <section className={s.section} aria-label="Identity">
        <SectionHeader title="Identity" />
        <div className={s.grid}>
          {IDENTITY.map((f) => (
            <Field key={f.path} label={f.label}>
              {(a) => (
                <Input
                  {...a}
                  value={f.read(model)}
                  onChange={(e) => onField(f.path, e.target.value, 'identity')}
                />
              )}
            </Field>
          ))}
        </div>
      </section>

      <section className={s.section} aria-label="Preferences">
        <SectionHeader title="Preferences" />
        <div className={s.grid}>
          <Field label="Remote">
            {(a) => (
              <Select
                {...a}
                options={REMOTE}
                value={p.remote}
                onValueChange={(v) => onField('preferences.remote', v, 'preferences')}
              />
            )}
          </Field>
          <Field label="Salary floor">
            {(a) => (
              <ParsedInput
                {...a}
                inputMode="numeric"
                value={p.salary_floor}
                parse={parseNumberOrNull}
                format={(v) => (v === null ? '' : String(v))}
                equal={(x, y) => x === y}
                onValue={(v) => onField('preferences.salary_floor', v, 'preferences')}
              />
            )}
          </Field>
          <Field label="Currency">
            {(a) => (
              <Input
                {...a}
                value={p.currency}
                onChange={(e) => onField('preferences.currency', e.target.value, 'preferences')}
              />
            )}
          </Field>
          <Field label="Roles" hint="Comma-separated.">
            {(a) => (
              <ListInput
                {...a}
                value={p.roles}
                onValue={(v) => onField('preferences.roles', v, 'preferences')}
              />
            )}
          </Field>
          <Field label="Locations" hint="Comma-separated.">
            {(a) => (
              <ListInput
                {...a}
                value={p.locations}
                onValue={(v) => onField('preferences.locations', v, 'preferences')}
              />
            )}
          </Field>
        </div>
      </section>

      <section className={s.section} aria-label="Skills">
        <SectionHeader
          title="Skills"
          actions={
            <Button size="sm" icon={<Plus aria-hidden="true" />} onClick={onAddSkill}>
              Add skill
            </Button>
          }
        />
        {model.skills.length === 0 ? (
          <p className={s.muted}>No skills yet.</p>
        ) : (
          <div className={s.skillsTable} style={{ height: `calc(${String(rows)} * var(--row) + 2px)` }}>
            <Table
              ariaLabel="Skills"
              columns={skillColumns}
              rows={skills}
              getRowId={(r) => r.skill}
              onRowClick={onEditSkill}
            />
          </div>
        )}
      </section>

      <EntryList
        title="Experience"
        entries={model.experience}
        note="Edit entries in the Markdown tab."
        onJump={onJump}
      />
      <EntryList title="Projects" entries={model.projects} onJump={onJump} />
      <EntryList title="Education" entries={model.education} onJump={onJump} />
    </div>
  );
}
