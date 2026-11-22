// Structural scan of a profile's lines. Shared by the parser, the editors and the validator's tests.
// Everything here is positional (line indexes) so edits can touch only the lines they own.
import { SECTION_KINDS, type SectionKind } from './types';

export const stripEol = (line: string): string => line.replace(/\r?\n$/, '');
export const isBlank = (line: string): boolean => stripEol(line).trim() === '';
/** Split after every "\n"; joining the result gives the input back byte for byte. */
export const splitLines = (text: string): string[] => text.split(/(?<=\n)/).filter((l) => l !== '');
export const detectEol = (lines: readonly string[]): string =>
  lines.some((l) => l.endsWith('\r\n')) ? '\r\n' : '\n';

export interface SectionNode {
  /** Heading text, e.g. "Skills". */
  name: string;
  kind: SectionKind | null;
  /** Index of the `## ` line. */
  start: number;
  /** Exclusive end (next `## ` line or end of file). */
  end: number;
}

export interface Layout {
  /** Front matter line range including both `---` lines; `end` is exclusive. */
  fm: { start: number; end: number } | null;
  fmUnterminated: boolean;
  /** live[i] is false for lines inside front matter, an HTML comment or a code fence. */
  live: boolean[];
  sections: SectionNode[];
  /** Set when the file ends inside a comment or fence, so appended blocks must close it first. */
  endsInComment: boolean;
  endFence: string | null;
  /** 0-based line where the comment or fence that is still open at end of file began. */
  unclosedAt: number | null;
}

const FM_OPEN = /^(?:\uFEFF)?---[ \t]*$/;
const FM_CLOSE = /^(---|\.\.\.)[ \t]*$/;
const H2 = /^##(?!#)[ \t]+(\S.*?)[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

export function scanLayout(lines: readonly string[]): Layout {
  const live = lines.map(() => true);
  let fm: Layout['fm'] = null;
  let fmUnterminated = false;
  if (lines.length > 0 && FM_OPEN.test(stripEol(lines[0] ?? ''))) {
    const close = lines.findIndex((l, i) => i > 0 && FM_CLOSE.test(stripEol(l)));
    if (close < 0) fmUnterminated = true;
    else fm = { start: 0, end: close + 1 };
  }
  for (let i = 0; i < (fm?.end ?? 0); i++) live[i] = false;

  let inComment = false;
  let fence: string | null = null;
  let openedAt = -1;
  const sections: SectionNode[] = [];
  for (let i = fm?.end ?? 0; i < lines.length; i++) {
    const t = stripEol(lines[i] ?? '');
    live[i] = !inComment && fence === null;
    if (inComment) {
      if (t.includes('-->')) inComment = false;
      continue;
    }
    if (fence !== null) {
      const m = FENCE.exec(t);
      if (m?.[1] && m[1][0] === fence[0] && m[1].length >= fence.length && t.trim() === m[1]) fence = null;
      continue;
    }
    const f = FENCE.exec(t);
    if (f?.[1]) {
      fence = f[1];
      openedAt = i;
      continue;
    }
    const h = H2.exec(t);
    if (h?.[1]) {
      const name = h[1];
      const lower = name.toLowerCase();
      const kind = SECTION_KINDS.find((k) => k === lower) ?? null;
      sections.push({ name, kind, start: i, end: lines.length });
    }
    // Only a `<!--` that begins the line opens a comment, so prose like "uses <!-- tags" cannot swallow the file.
    if (t.trimStart().startsWith('<!--') && t.indexOf('-->', t.indexOf('<!--') + 4) < 0) {
      inComment = true;
      openedAt = i;
    }
  }
  sections.forEach((s, i) => {
    s.end = sections[i + 1]?.start ?? lines.length;
  });
  return {
    fm,
    fmUnterminated,
    live,
    sections,
    endsInComment: inComment,
    endFence: fence,
    unclosedAt: inComment || fence !== null ? openedAt : null,
  };
}

export function firstSection(layout: Layout, kind: SectionKind): SectionNode | undefined {
  return layout.sections.find((s) => s.kind === kind);
}

/** Last non-blank line index inside the section (the heading itself at minimum). */
export function lastContentLine(lines: readonly string[], sec: SectionNode): number {
  let i = sec.end - 1;
  while (i > sec.start && isBlank(lines[i] ?? '')) i--;
  return i;
}

// ---------- skills table ----------

export const SKILL_COLUMNS = [
  'skill',
  'category',
  'level',
  'years',
  'last_used',
  'evidence',
  'status',
  'aliases',
] as const;

/** Split a table row into cells. `\|` and `\\` are escapes; outer pipes are optional. */
export function splitCells(line: string): string[] {
  const t = stripEol(line).trim();
  const cells: string[] = [];
  let cur = '';
  for (let i = t.startsWith('|') ? 1 : 0; i < t.length; i++) {
    const c = t.charAt(i);
    const next = t.charAt(i + 1);
    if (c === '\\' && (next === '|' || next === '\\')) {
      cur += next;
      i++;
    } else if (c === '|') {
      cells.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  if (cur.trim() !== '' || !t.endsWith('|')) cells.push(cur.trim());
  return cells;
}

export interface TableNode {
  header: number;
  /** Header cells, lower-cased with spaces as underscores. */
  columns: string[];
  /** Data row line indexes. */
  rows: number[];
}

const isRow = (line: string): boolean => stripEol(line).trimStart().startsWith('|');
const isSeparator = (line: string): boolean => {
  const t = stripEol(line).trim();
  return t.startsWith('|') && t.includes('-') && /^[|\s:-]+$/.test(t);
};

/** First table in the section. `malformedAt` is set when a `|` line has no separator row under it. */
export function findTable(
  lines: readonly string[],
  layout: Layout,
  sec: SectionNode,
): { table: TableNode | null; malformedAt: number | null } {
  for (let i = sec.start + 1; i < sec.end; i++) {
    if (!layout.live[i] || !isRow(lines[i] ?? '')) continue;
    if (!isSeparator(lines[i + 1] ?? '') || i + 1 >= sec.end) return { table: null, malformedAt: i };
    const rows: number[] = [];
    for (let j = i + 2; j < sec.end && layout.live[j] && isRow(lines[j] ?? ''); j++) rows.push(j);
    const columns = splitCells(lines[i] ?? '').map((c) => c.toLowerCase().replace(/\s+/g, '_'));
    return { table: { header: i, columns, rows }, malformedAt: null };
  }
  return { table: null, malformedAt: null };
}

// ---------- entries ----------

export interface EntryNode {
  start: number;
  /** Exclusive end of the entry's own lines (heading, meta, bullets). Trailing comments/blank lines stay outside. */
  coreEnd: number;
  title: string;
  id: string;
  meta: { key: string; value: string; line: number }[];
  /** Exclusive end of the meta run (`start + 1` when there is none). */
  metaEnd: number;
  bullets: { text: string; start: number; end: number }[];
  /** Non-blank, non-bullet text lines that belong to no field. */
  stray: number[];
}

const H3 = /^###(?!#)[ \t]+(.*?)[ \t]*$/;
const H3_BARE = /^###(?!#)[ \t]*$/;
const META = /^-[ \t]+([A-Za-z_][\w-]*):[ \t]*(.*?)[ \t]*$/;
const BULLET = /^[-*+][ \t]+(.*?)[ \t]*$/;

// `{#` in a title would read as an id marker, so the renderer writes `\{#` (doubling backslashes before it).
export const escapeTitle = (s: string): string => s.replace(/(\\*)\{#/g, '$1\\{#');
export const unescapeTitle = (s: string): string => s.replace(/\\(\\*)\{#/g, '$1{#');

// Free-text lines that start like structure (`#`, `<!--`, a fence) get one leading backslash. Existing
// backslashes count as part of the marker, so unescaping removes exactly the one the renderer added.
const STRUCTURAL = '(\\\\*(?:#|<!--|`{3}|~{3}))';
export const escapeFreeText = (s: string): string =>
  s.replace(new RegExp(`^([ \\t]*)${STRUCTURAL}`, 'gm'), '$1\\$2');
export const unescapeFreeText = (s: string): string =>
  s.replace(new RegExp(`^([ \\t]*)\\\\${STRUCTURAL}`, 'gm'), '$1$2');

export function parseMetaValue(raw: string): string {
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    try {
      const v: unknown = JSON.parse(raw);
      if (typeof v === 'string') return v;
    } catch {
      /* not JSON-escaped: fall through and strip the quotes */
    }
    return raw.slice(1, -1);
  }
  return raw;
}

export function formatMetaValue(v: string): string {
  const flat = v.replace(/\s*[\r\n]+\s*/g, ' ');
  return flat === '' || /^"|^\s|\s$/.test(flat) ? JSON.stringify(flat) : flat;
}

export function findEntries(lines: readonly string[], layout: Layout, sec: SectionNode): EntryNode[] {
  const heads: number[] = [];
  for (let i = sec.start + 1; i < sec.end; i++) {
    const t = stripEol(lines[i] ?? '');
    if (layout.live[i] && (H3.test(t) || H3_BARE.test(t))) heads.push(i);
  }
  return heads.map((start, n) => {
    const end = heads[n + 1] ?? sec.end;
    const text = H3.exec(stripEol(lines[start] ?? ''))?.[1] ?? '';
    const idm = /^(.*?)[ \t]*(?<!\\)\{#([^{}\s]+)\}$/.exec(text);
    const node: EntryNode = {
      start,
      coreEnd: start + 1,
      title: unescapeTitle(idm ? (idm[1] ?? '') : text),
      id: idm?.[2] ?? '',
      meta: [],
      metaEnd: start + 1,
      bullets: [],
      stray: [],
    };
    let i = start + 1;
    for (; i < end && layout.live[i]; i++) {
      const m = META.exec(stripEol(lines[i] ?? ''));
      if (!m) break;
      node.meta.push({ key: m[1] ?? '', value: parseMetaValue(m[2] ?? ''), line: i });
      node.coreEnd = i + 1;
    }
    node.metaEnd = i;
    let open = false;
    for (; i < end; i++) {
      const t = stripEol(lines[i] ?? '');
      if (!layout.live[i]) continue;
      if (t.trim() === '') {
        open = false;
        continue;
      }
      const b = BULLET.exec(t);
      const last = node.bullets[node.bullets.length - 1];
      if (b) {
        node.bullets.push({ text: b[1] ?? '', start: i, end: i + 1 });
        open = true;
      } else if (open && last && /^\s/.test(t)) {
        last.text += ` ${t.trim()}`;
        last.end = i + 1;
      } else {
        node.stray.push(i);
        open = false;
        continue;
      }
      node.coreEnd = i + 1;
    }
    return node;
  });
}
