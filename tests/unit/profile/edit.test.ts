import { describe, expect, it } from 'vitest';
import {
  parseProfile,
  removeSkill,
  serializeProfile,
  setFrontMatterField,
  upsertEntry,
  upsertSkill,
  type Entry,
  type SkillRow,
} from '../../../src/shared/profile';
import { changedLines, fixture, modelOf } from './helpers';

const apply = (
  text: string,
  edit: (doc: ReturnType<typeof parseProfile>['doc']) => ReturnType<typeof parseProfile>['doc'],
): string => serializeProfile(edit(parseProfile(text).doc));

const zig: SkillRow = {
  skill: 'Zig',
  category: 'language',
  level: 2,
  years: 1,
  last_used: '2026',
  evidence: ['proj-ledger'],
  status: 'learning',
  aliases: ['ziglang'],
};

describe('upsertSkill', () => {
  it('appends a row after the last row and touches nothing else', () => {
    const before = fixture('full');
    const after = apply(before, (d) => upsertSkill(d, zig));
    expect(changedLines(before, after)).toEqual({
      removed: [],
      added: ['| Zig | language | 2 | 1 | 2026 | proj-ledger | learning | ziglang |\n'],
    });
    expect(modelOf(after).skills.at(-1)).toEqual(zig);
  });

  it('rewrites only the matching row (case-insensitive name) and keeps extra columns', () => {
    const text =
      '## Skills\n\n| skill | level | note | category | years | last_used | evidence | status | aliases |\n|---|---|---|---|---|---|---|---|---|\n| Zig | 1 | keep me | tool | 0 | now | | want | |\n| Go | 3 | x | tool | 1 | now | | have | |\n';
    const after = apply(text, (d) => upsertSkill(d, { ...zig, skill: 'zig' }));
    expect(changedLines(text, after)).toEqual({
      removed: ['| Zig | 1 | keep me | tool | 0 | now | | want | |\n'],
      added: ['| zig | 2 | keep me | language | 1 | 2026 | proj-ledger | learning | ziglang |\n'],
    });
  });

  it('is a no-op when the row already holds the same data', () => {
    const text = fixture('full');
    const row = modelOf(text).skills[1] as SkillRow;
    expect(apply(text, (d) => upsertSkill(d, row))).toBe(text);
  });

  it('creates the table in an existing skills section that has none', () => {
    const text = '---\nname: A\n---\n\n## Skills\n\n<!-- add skills later -->\n\n## Notes\n\nhi\n';
    const after = apply(text, (d) => upsertSkill(d, zig));
    expect(modelOf(after).skills).toEqual([zig]);
    expect(modelOf(after).notes).toBe('hi');
    expect(after).toContain('<!-- add skills later -->\n\n| skill |');
    expect(changedLines(text, after).removed).toEqual([]);
  });

  it('creates the section in canonical position when missing', () => {
    const text = '---\nname: A\n---\n\n## Summary\n\nhello\n\n## Experience\n\n### T {#exp-t}\n\n- x\n';
    const after = apply(text, (d) => upsertSkill(d, zig));
    const heads = after.split('\n').filter((l) => l.startsWith('## '));
    expect(heads).toEqual(['## Summary', '## Skills', '## Experience']);
    expect(modelOf(after).skills).toEqual([zig]);
    expect(modelOf(after).experience).toEqual(modelOf(text).experience);
  });

  it('creates the section at the end of a file without trailing newline, and in an empty doc', () => {
    expect(modelOf(apply('hello', (d) => upsertSkill(d, zig))).skills).toEqual([zig]);
    expect(apply('hello', (d) => upsertSkill(d, zig)).startsWith('hello\n\n## Skills\n\n| skill')).toBe(true);
    expect(modelOf(apply('', (d) => upsertSkill(d, zig))).skills).toEqual([zig]);
  });

  it('adds a row to a file without trailing newline', () => {
    const after = apply(fixture('no-trailing-newline'), (d) => upsertSkill(d, zig));
    expect(modelOf(after).skills.map((s) => s.skill)).toEqual(['Bash', 'Zig']);
  });

  it('keeps CRLF endings on new lines', () => {
    const before = fixture('crlf');
    const after = apply(before, (d) => upsertSkill(d, zig));
    expect(after.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    expect(modelOf(after).skills.map((s) => s.skill)).toEqual(['Go', 'Zig']);
  });

  it('escapes pipes in cells so the row parses back', () => {
    const row = { ...zig, skill: 'A | B', aliases: ['x\\y'] };
    expect(modelOf(apply(fixture('minimal'), (d) => upsertSkill(d, row))).skills.at(-1)).toEqual(row);
  });
});

describe('removeSkill', () => {
  it('removes only the matching row line', () => {
    const before = fixture('full');
    const after = apply(before, (d) => removeSkill(d, '  docker '));
    expect(changedLines(before, after)).toEqual({
      removed: ['| Docker | tool | 3 | 2 | 2026 | proj-ledger | learning | |\n'],
      added: [],
    });
  });

  it('is a no-op for unknown skills and documents without a table', () => {
    const text = fixture('full');
    expect(apply(text, (d) => removeSkill(d, 'COBOL'))).toBe(text);
    expect(apply('nothing here', (d) => removeSkill(d, 'x'))).toBe('nothing here');
  });
});

describe('setFrontMatterField', () => {
  it('changes one scalar and keeps comments and spacing on every other line', () => {
    const before = fixture('seed-template');
    const after = apply(before, (d) => setFrontMatterField(d, 'headline', 'Data Engineer'));
    expect(changedLines(before, after)).toEqual({
      removed: ['headline: ""                # e.g. "Data Engineer"\n'],
      added: ['headline: Data Engineer                # e.g. "Data Engineer"\n'],
    });
    expect(modelOf(after).frontMatter.headline).toBe('Data Engineer');
  });

  it('reaches nested paths (dotted string or array)', () => {
    const before = fixture('seed-template');
    const a = apply(before, (d) => setFrontMatterField(d, 'preferences.remote', 'remote'));
    const b = apply(before, (d) => setFrontMatterField(d, ['preferences', 'remote'], 'remote'));
    expect(a).toBe(b);
    expect(changedLines(before, a)).toEqual({
      removed: ['  remote: hybrid            # onsite | hybrid | remote | any\n'],
      added: ['  remote: remote            # onsite | hybrid | remote | any\n'],
    });
    const n = apply(before, (d) => setFrontMatterField(d, 'preferences.salary_floor', 70000));
    expect(modelOf(n).frontMatter.preferences.salary_floor).toBe(70000);
  });

  it('quotes values that need it', () => {
    const after = apply(fixture('minimal'), (d) => setFrontMatterField(d, 'name', 'Sam: the "Sample", #1'));
    expect(modelOf(after).frontMatter.name).toBe('Sam: the "Sample", #1');
  });

  it('replaces a value inside a flow mapping safely', () => {
    const after = apply(fixture('full'), (d) =>
      setFrontMatterField(d, ['languages_spoken', 1, 'level'], 'C1, fluent'),
    );
    expect(modelOf(after).frontMatter.languages_spoken[1]).toEqual({
      language: 'German',
      level: 'C1, fluent',
    });
  });

  it('replaces a flow list in place, keeping its trailing comment', () => {
    const before = fixture('full');
    const after = apply(before, (d) =>
      setFrontMatterField(d, 'preferences.roles', ['ML Engineer', 'Data, Lead']),
    );
    expect(changedLines(before, after)).toEqual({
      removed: ['  roles: [Data Engineer, Analytics Engineer]   # target titles\n'],
      added: ['  roles: [ML Engineer, "Data, Lead"]   # target titles\n'],
    });
    expect(modelOf(after).frontMatter.preferences.roles).toEqual(['ML Engineer', 'Data, Lead']);
  });

  it('keeps comments when a replacement has to go through the Document API', () => {
    const text = '---\nname: A\nroles: # who\n  - x\n---\n';
    const after = apply(text, (d) => setFrontMatterField(d, 'roles', ['y', 'z']));
    expect(after).toContain('# who');
    expect(parseProfile(after).diagnostics).toEqual([]);
  });

  it('adds a missing key', () => {
    const after = apply(fixture('minimal'), (d) => setFrontMatterField(d, 'location', 'Oslo'));
    expect(modelOf(after).frontMatter).toMatchObject({ name: 'Sam Sample', location: 'Oslo' });
    expect(changedLines(fixture('minimal'), after).removed).toEqual([]);
  });

  it('keeps a trailing comment on the replaced line', () => {
    const after = apply('---\nname: A # who\n---\n', (d) => setFrontMatterField(d, 'name', 'B'));
    expect(after).toBe('---\nname: B # who\n---\n');
  });

  it('creates front matter when missing, and leaves broken front matter alone', () => {
    const after = apply(fixture('missing-front-matter'), (d) => setFrontMatterField(d, 'name', 'New'));
    expect(after.startsWith('---\nname: New\n---\n\n# No Front Matter')).toBe(true);
    expect(modelOf(after).frontMatter.name).toBe('New');
    for (const name of ['bad-yaml', 'unterminated-front-matter']) {
      expect(apply(fixture(name), (d) => setFrontMatterField(d, 'name', 'x'))).toBe(fixture(name));
    }
  });

  it('uses CRLF for new lines in CRLF files', () => {
    const after = apply(fixture('crlf'), (d) => setFrontMatterField(d, 'location', 'Oslo'));
    expect(after.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    expect(modelOf(after).frontMatter.location).toBe('Oslo');
  });
});

describe('upsertEntry', () => {
  const entry = (over: Partial<Entry> = {}): Entry => ({
    id: 'exp-globex',
    title: 'Data Engineer — Globex',
    meta: { start: '2022-03', end: 'present', location: 'Berlin, Germany', type: 'full-time' },
    bullets: [
      'Cut nightly report runtime from 2 h to 10 min by rewriting SQL pipelines.',
      'Owned the Airflow deployment for six teams.',
    ],
    ...over,
  });

  it('is a no-op for an identical entry', () => {
    const text = fixture('full');
    expect(apply(text, (d) => upsertEntry(d, 'experience', entry()))).toBe(text);
  });

  it('edits one bullet as a one-line change', () => {
    const before = fixture('full');
    const e = entry({
      bullets: [entry().bullets[0] as string, 'Owned the Airflow deployment for eight teams.'],
    });
    const after = apply(before, (d) => upsertEntry(d, 'experience', e));
    expect(changedLines(before, after)).toEqual({
      removed: ['- Owned the Airflow deployment for six teams.\n'],
      added: ['- Owned the Airflow deployment for eight teams.\n'],
    });
  });

  it('changes a meta value, adds a meta key and appends a bullet', () => {
    const before = fixture('full');
    const e = entry({
      meta: {
        start: '2022-03',
        end: '2026-10',
        location: 'Berlin, Germany',
        type: 'full-time',
        team: 'Data',
      },
      bullets: [...entry().bullets, 'Mentored two juniors.'],
    });
    const after = apply(before, (d) => upsertEntry(d, 'experience', e));
    expect(modelOf(after).experience[0]).toEqual(e);
    expect(modelOf(after).experience[1]).toEqual(modelOf(before).experience[1]);
    const b = before.split(/(?<=\n)/);
    const a = after.split(/(?<=\n)/);
    expect(b.filter((l) => !a.includes(l))).toEqual(['- end: present\n']);
    expect(a.filter((l) => !b.includes(l))).toEqual([
      '- end: 2026-10\n',
      '- team: Data\n',
      '- Mentored two juniors.\n',
    ]);
  });

  it('appends a new entry at the end of its section', () => {
    const before = fixture('full');
    const e: Entry = {
      id: 'exp-new',
      title: 'Intern — Hooli',
      meta: { start: '2019-06' },
      bullets: ['Fixed bugs.'],
    };
    const after = apply(before, (d) => upsertEntry(d, 'experience', e));
    expect(modelOf(after).experience.map((x) => x.id)).toEqual(['exp-globex', 'exp-initrode', 'exp-new']);
    expect(changedLines(before, after).removed).toEqual([]);
    expect(modelOf(after).projects).toEqual(modelOf(before).projects);
  });

  it('adds into an empty section and after a trailing comment', () => {
    const e: Entry = { id: 'cert-x', title: 'Cert — Issuer', meta: { date: '2025-05' }, bullets: [] };
    const after = apply(fixture('seed-template'), (d) => upsertEntry(d, 'certifications', e));
    expect(modelOf(after).certifications).toEqual([e]);
    expect(after).toContain('credential_url: "" -->\n\n### Cert — Issuer {#cert-x}\n- date: 2025-05\n');
  });

  it('creates a missing section in canonical position', () => {
    const e: Entry = { id: 'proj-a', title: 'A', meta: {}, bullets: ['Did it.'] };
    const after = apply(fixture('minimal'), (d) => upsertEntry(d, 'projects', e));
    expect(modelOf(after).projects).toEqual([e]);
    expect(modelOf(after).experience).toEqual(modelOf(fixture('minimal')).experience);
    expect(after.indexOf('## Experience')).toBeLessThan(after.indexOf('## Projects'));
  });

  it('preserves comments between fields of an edited entry', () => {
    const text =
      '## Experience\n\n### T {#exp-t}\n- start: 2020-01\n<!-- remember to check dates -->\n\n- a\n';
    const after = apply(text, (d) =>
      upsertEntry(d, 'experience', {
        id: 'exp-t',
        title: 'T',
        meta: { start: '2021-01' },
        bullets: ['a', 'b'],
      }),
    );
    expect(after).toContain('<!-- remember to check dates -->');
    expect(modelOf(after).experience[0]).toMatchObject({ meta: { start: '2021-01' }, bullets: ['a', 'b'] });
  });

  it('quotes meta values that would not parse back and keeps entries after the edited one intact', () => {
    const e = entry({ meta: { note: ' padded', empty: '' } });
    const after = apply(fixture('full'), (d) => upsertEntry(d, 'experience', e));
    expect(modelOf(after).experience[0]?.meta).toEqual({ note: ' padded', empty: '' });
    expect(modelOf(after).experience[1]?.id).toBe('exp-initrode');
  });
});
