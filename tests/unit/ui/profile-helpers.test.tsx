// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseProfile } from '@shared/profile';
import {
  countDiagnostics,
  deleteSkill,
  diagnosticsSummary,
  emptySkillForm,
  entryLine,
  entryMeta,
  evidenceIds,
  formToRow,
  friendlyMessage,
  liveDiagnostics,
  mergeMessage,
  parseList,
  parseNumberOrNull,
  relativeTime,
  rowToForm,
  saveSkill,
  setField,
  skillConflict,
  sortDiagnostics,
  sortSkills,
} from '@renderer/features/profile/helpers';
import { OverviewTab } from '@renderer/features/profile/OverviewTab';

afterEach(cleanup);

const seed = readFileSync('seed/profile/profile.md', 'utf8');
const diag = (severity: 'error' | 'warning', message: string, line: number | null) => ({
  severity,
  code: message,
  message,
  line,
});

describe('lists and numbers', () => {
  it('parses comma lists', () => {
    expect(parseList(' a, b ,, c ')).toEqual(['a', 'b', 'c']);
    expect(parseList('')).toEqual([]);
  });
  it('parses numbers; blank or junk means unset', () => {
    expect(parseNumberOrNull('65000')).toBe(65000);
    expect(parseNumberOrNull(' ')).toBeNull();
    expect(parseNumberOrNull('abc')).toBeNull();
  });
});

describe('front matter edits', () => {
  it('sets an identity field and leaves every other byte alone', () => {
    const next = setField(seed, 'email', 'p@example.com');
    expect(next).toBe(seed.replace('email: ""', 'email: p@example.com'));
    expect(parseProfile(next).model.frontMatter.email).toBe('p@example.com');
  });
  it('sets nested, list and number fields', () => {
    const a = setField(seed, 'links.github', 'https://github.com/x');
    const b = setField(a, 'preferences.roles', ['Data Engineer', 'Analytics Engineer']);
    const c = setField(b, 'preferences.salary_floor', 65000);
    const fm = parseProfile(c).model.frontMatter;
    expect(fm.links.github).toBe('https://github.com/x');
    expect(fm.preferences.roles).toEqual(['Data Engineer', 'Analytics Engineer']);
    expect(fm.preferences.salary_floor).toBe(65000);
  });
  it('returns the input when the front matter is unusable', () => {
    const broken = '---\nname: [unclosed\n---\n';
    expect(setField(broken, 'email', 'x@y.z')).toBe(broken);
  });
});

describe('skill form', () => {
  it('converts a valid form to a row', () => {
    const res = formToRow({
      ...emptySkillForm(),
      skill: ' Rust ',
      level: '4',
      years: '2.5',
      last_used: 'now',
      evidence: 'exp-example, proj-example',
      aliases: 'rustlang',
    });
    expect(res).toEqual({
      row: {
        skill: 'Rust',
        category: 'language',
        level: 4,
        years: 2.5,
        last_used: 'now',
        evidence: ['exp-example', 'proj-example'],
        status: 'have',
        aliases: ['rustlang'],
      },
    });
  });
  it('never prefills claims: level and last used start empty', () => {
    const f = emptySkillForm();
    expect([f.level, f.last_used]).toEqual(['', '']);
    expect(formToRow({ ...f, skill: 'Go' })).toMatchObject({ error: { field: 'level' } });
  });
  it('accepts an empty last used', () => {
    expect(formToRow({ ...emptySkillForm(), skill: 'Go', level: '2' })).toMatchObject({
      row: { last_used: '' },
    });
  });
  it.each([
    [{ skill: '' }, 'skill', 'Skill name'],
    [{ skill: 'A|B' }, 'skill', 'cannot contain'],
    [{ skill: 'X', level: '' }, 'level', 'Level'],
    [{ skill: 'X', level: '9' }, 'level', 'Level'],
    [{ skill: 'X', level: '2.5' }, 'level', 'Level'],
    [{ skill: 'X', level: '3', years: '-1' }, 'years', 'Years'],
    [{ skill: 'X', level: '3', last_used: 'recently' }, 'last_used', 'Last used'],
  ])('rejects %j on the %s field', (patch, field, text) => {
    const res = formToRow({ ...emptySkillForm(), ...patch });
    expect(res).toMatchObject({ error: { field, message: expect.stringContaining(text) as string } });
  });
  it('round-trips a row through the form', () => {
    const row = parseProfile(seed).model.skills[0];
    if (!row) throw new Error('seed has no skills');
    expect(formToRow(rowToForm(row))).toEqual({ row });
  });
  it('adds and removes a skill in the markdown', () => {
    const parsed = formToRow({ ...emptySkillForm(), skill: 'Rust', level: '3' });
    if ('error' in parsed) throw new Error(parsed.error.message);
    const added = saveSkill(seed, parsed.row);
    expect(parseProfile(added).model.skills.map((s) => s.skill)).toContain('Rust');
    expect(deleteSkill(added, 'rust')).toBe(seed);
  });
  it('flags a name or alias that already exists, case-insensitively', () => {
    const row = (skill: string, aliases: string[] = []) => ({
      skill,
      category: 'language',
      level: 3,
      years: null,
      last_used: '',
      evidence: [],
      status: 'have',
      aliases,
    });
    const skills = [row('Rust'), row('PostgreSQL', ['Postgres'])];
    expect(skillConflict(skills, row('rust'), null)?.skill).toBe('Rust');
    expect(skillConflict(skills, row('Postgres'), null)?.skill).toBe('PostgreSQL');
    expect(skillConflict(skills, row('Go', ['RUST']), null)?.skill).toBe('Rust');
    expect(skillConflict(skills, row('Go'), null)).toBeNull();
    // editing a row never conflicts with itself, but renaming onto another row does
    expect(skillConflict(skills, row('rust'), 'Rust')).toBeNull();
    expect(skillConflict(skills, row('Rust'), 'PostgreSQL')?.skill).toBe('Rust');
  });
  it('sorts skills by category, then name', () => {
    const r = (skill: string, category: string) =>
      ({ skill, category }) as Parameters<typeof sortSkills>[0][0];
    expect(
      sortSkills([r('b', 'tool'), r('Z', 'language'), r('a', 'tool'), r('c', 'language')]).map(
        (x) => x.skill,
      ),
    ).toEqual(['c', 'Z', 'a', 'b']);
  });
  it('lists the ids skills can cite', () => {
    expect(evidenceIds(parseProfile(seed).model)).toEqual(['exp-example', 'proj-example']);
  });
});

describe('diagnostics', () => {
  const list = [
    diag('warning', 'w-late', 9),
    diag('error', 'e-none', null),
    diag('warning', 'w-early', 2),
    diag('error', 'e-line', 5),
  ];
  it('sorts errors first, then by line, unlocated last', () => {
    expect(sortDiagnostics(list).map((d) => d.message)).toEqual(['e-line', 'e-none', 'w-early', 'w-late']);
  });
  it('counts and summarises', () => {
    expect(countDiagnostics(list)).toEqual({ errors: 2, warnings: 2 });
    expect(diagnosticsSummary(list)).toBe('2 errors · 2 warnings');
    expect(diagnosticsSummary([diag('error', 'x', 1)])).toBe('1 error · 0 warnings');
    expect(diagnosticsSummary([])).toBe('No problems found.');
  });
  it('recomputes live from the markdown, errors first', () => {
    const today = new Date('2026-11-20');
    const { all } = liveDiagnostics(seed, today);
    expect(all.map((d) => d.code)).toContain('profile_email_missing');
    expect(all[0]?.severity).toBe('error');
    const fixed = liveDiagnostics(setField(seed, 'email', 'p@example.com'), today);
    expect(fixed.all.map((d) => d.code)).not.toContain('profile_email_missing');
  });
});

describe('friendly diagnostics', () => {
  it('maps validate codes to plain copy and keeps unknown messages', () => {
    expect(
      friendlyMessage({ code: 'profile_email_missing', message: 'Front matter "email" is required' }),
    ).toBe('Email is missing.');
    expect(friendlyMessage({ code: 'profile_name_missing', message: 'x' })).toBe('Name is missing.');
    expect(
      friendlyMessage({
        code: 'profile_stale',
        message: 'Profile was last reviewed on 2026-01-02; review it (over 30 days ago)',
      }),
    ).toBe('Last reviewed 2026-01-02, over 30 days ago. Review the profile.');
    expect(friendlyMessage({ code: 'something_new', message: 'Original text' })).toBe('Original text');
  });
});

describe('misc', () => {
  it('finds an entry heading line', () => {
    const line = entryLine(seed, 'proj-example');
    expect(line).not.toBeNull();
    expect(seed.split('\n')[(line ?? 0) - 1]).toContain('{#proj-example}');
    expect(entryLine(seed, 'nope')).toBeNull();
    expect(entryLine(seed, '')).toBeNull();
  });
  it('summarises entry meta', () => {
    const e = (meta: Record<string, string>) => ({ id: 'a', title: 't', meta, bullets: [] });
    expect(entryMeta(e({ start: '2023-01', end: 'present', location: 'Leipzig' }))).toBe(
      '2023-01 – present · Leipzig',
    );
    expect(entryMeta(e({ dates: '2024-03 – 2024-06' }))).toBe('2024-03 – 2024-06');
    expect(entryMeta(e({}))).toBe('');
  });
  it('formats relative times', () => {
    const now = new Date('2026-11-19T12:00:00Z');
    expect(relativeTime('2026-11-19T11:59:40Z', now)).toBe('just now');
    expect(relativeTime('2026-11-19T11:30:00Z', now)).toBe('30 min ago');
    expect(relativeTime('2026-11-19T09:00:00Z', now)).toBe('3 h ago');
    expect(relativeTime('2026-11-16T12:00:00Z', now)).toBe('3 d ago');
    expect(relativeTime('2026-01-02T12:00:00Z', now)).toBe('2026-01-02');
    expect(relativeTime('garbage', now)).toBe('garbage');
  });
  it('keeps a commit label for one kind of edit, generalises mixed ones', () => {
    expect(mergeMessage(null, 'profile: edit identity')).toBe('profile: edit identity');
    expect(mergeMessage('profile: edit identity', 'profile: edit identity')).toBe('profile: edit identity');
    expect(mergeMessage('profile: edit identity', 'profile: add skill X')).toBe('profile: edit');
  });
});

describe('OverviewTab', () => {
  function Harness({ onField }: { onField: (p: string, v: unknown, s: string) => void }): React.JSX.Element {
    const [md, setMd] = useState(seed);
    return (
      <OverviewTab
        model={parseProfile(md).model}
        onField={(p, v, sec) => {
          onField(p, v, sec);
          setMd((m) => setField(m, p, v));
        }}
        onAddSkill={vi.fn()}
        onEditSkill={vi.fn()}
        onJump={vi.fn()}
      />
    );
  }

  it('reports identity edits with their field path', () => {
    const onField = vi.fn();
    render(<Harness onField={onField} />);
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'p@example.com' } });
    expect(onField).toHaveBeenCalledWith('email', 'p@example.com', 'identity');
    expect(screen.getByLabelText('Email')).toHaveProperty('value', 'p@example.com');
  });

  it('does not eat a trailing comma while typing a list', () => {
    const onField = vi.fn();
    render(<Harness onField={onField} />);
    const roles = screen.getByLabelText('Roles');
    fireEvent.change(roles, { target: { value: 'Data Engineer, ' } });
    expect(onField).toHaveBeenLastCalledWith('preferences.roles', ['Data Engineer'], 'preferences');
    expect(roles).toHaveProperty('value', 'Data Engineer, ');
  });

  it('lists skills and entries, and entries jump by id', () => {
    const onJump = vi.fn();
    render(
      <OverviewTab
        model={parseProfile(seed).model}
        onField={vi.fn()}
        onAddSkill={vi.fn()}
        onEditSkill={vi.fn()}
        onJump={onJump}
      />,
    );
    expect(screen.getByRole('grid', { name: 'Skills' })).toBeTruthy();
    expect(screen.getByText('Python')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Project Name/ }));
    expect(onJump).toHaveBeenCalledWith('proj-example');
  });
});
