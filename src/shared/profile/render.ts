import { stringify } from 'yaml';
import { escapeFreeText, escapeTitle, formatMetaValue, SKILL_COLUMNS, type EntryNode } from './layout';
import { ENTRY_SECTIONS, type Entry, type Profile, type SkillRow } from './types';

const flat = (s: string): string => s.replace(/\s*[\r\n]+\s*/g, ' ');
const escapeCell = (s: string): string => flat(s).replace(/[\\|]/g, '\\$&');
const metaKey = (k: string): string =>
  k
    .trim()
    .replace(/[^\w-]+/g, '_')
    .replace(/^(?=[\d-]|$)/, '_');

export const SKILLS_HEADER = `| ${SKILL_COLUMNS.join(' | ')} |`;
export const SKILLS_SEPARATOR = `|${SKILL_COLUMNS.map(() => '---').join('|')}|`;

function skillCell(row: SkillRow, column: string): string | undefined {
  switch (column) {
    case 'skill':
      return row.skill;
    case 'category':
      return row.category;
    case 'level':
      return row.level === null ? '' : String(row.level);
    case 'years':
      return row.years === null ? '' : String(row.years);
    case 'last_used':
      return row.last_used;
    case 'evidence':
      return row.evidence.join(', ');
    case 'status':
      return row.status;
    case 'aliases':
      return row.aliases.join(', ');
    default:
      return undefined;
  }
}

/** Cell texts in the given column order. Columns we do not know keep the old row's cell. */
export function skillCells(
  row: SkillRow,
  columns: readonly string[],
  oldCells: readonly string[] = [],
): string[] {
  return columns.map((c, i) => flat(skillCell(row, c) ?? oldCells[i] ?? ''));
}

export function renderSkillRow(
  row: SkillRow,
  columns: readonly string[],
  oldCells: readonly string[] = [],
): string {
  return `| ${skillCells(row, columns, oldCells).map(escapeCell).join(' | ')} |`;
}

/**
 * Lines of one entry. With `old`, every meta/bullet/heading line that did not change is reused verbatim,
 * so editing one bullet produces a one-line diff.
 */
export function renderEntry(
  entry: Entry,
  eol: string,
  old?: { node: EntryNode; lines: readonly string[] },
): string[] {
  const oldLine = (i: number): string => old?.lines[i] ?? '';
  const out: string[] = [];
  const idPart = entry.id === '' ? '' : `{#${entry.id}}`;
  out.push(
    old && old.node.title === entry.title && old.node.id === entry.id
      ? oldLine(old.node.start)
      : `### ${[escapeTitle(flat(entry.title)), idPart].filter((p) => p !== '').join(' ')}${eol}`,
  );
  for (const [k, v] of Object.entries(entry.meta)) {
    const same = old?.node.meta.find((m) => m.key === metaKey(k) && m.value === v);
    out.push(same ? oldLine(same.line) : `- ${metaKey(k)}: ${formatMetaValue(v)}${eol}`);
  }
  if (entry.bullets.length > 0) {
    const first = old?.node.bullets[0];
    const sep = old && first ? old.lines.slice(old.node.metaEnd, first.start) : [];
    out.push(...(sep.length > 0 ? sep : [eol]));
    const used = new Set<number>();
    for (const text of entry.bullets) {
      const i = old?.node.bullets.findIndex((b, n) => !used.has(n) && b.text === text) ?? -1;
      const same = i >= 0 ? old?.node.bullets[i] : undefined;
      if (same) {
        used.add(i);
        out.push(...(old?.lines.slice(same.start, same.end) ?? []));
      } else out.push(`- ${flat(text)}${eol}`);
    }
  }
  return out;
}

const TITLES: Record<string, string> = {
  summary: 'Summary',
  skills: 'Skills',
  experience: 'Experience',
  projects: 'Projects',
  education: 'Education',
  certifications: 'Certifications',
  awards: 'Awards',
  publications: 'Publications',
  languages: 'Languages',
  notes: 'Notes',
};
export const sectionTitle = (kind: string): string => TITLES[kind] ?? kind;

/** Render a fresh profile file (LF line endings) from a model. `parseProfile(result).model` equals `model`. */
export function profileToMarkdown(model: Profile): string {
  const out: string[] = ['---', stringify(model.frontMatter, { lineWidth: 0 }).trimEnd(), '---', ''];
  if (model.frontMatter.name !== '') out.push(`# ${flat(model.frontMatter.name)}`, '');
  const section = (kind: string, body: string[]): void => {
    out.push(`## ${sectionTitle(kind)}`, '');
    if (body.length > 0) out.push(...body, '');
  };
  section('summary', model.summary === '' ? [] : [escapeFreeText(model.summary)]);
  section('skills', [
    SKILLS_HEADER,
    SKILLS_SEPARATOR,
    ...model.skills.map((r) => renderSkillRow(r, SKILL_COLUMNS)),
  ]);
  for (const kind of ENTRY_SECTIONS) {
    const blocks = model[kind].map((e) => renderEntry(e, '\n').map((l) => l.replace(/\n$/, '')));
    section(
      kind,
      blocks.flatMap((b, i) => (i === 0 ? b : ['', ...b])),
    );
  }
  section('notes', model.notes === '' ? [] : [escapeFreeText(model.notes)]);
  return `${out.slice(0, -1).join('\n')}\n`;
}
