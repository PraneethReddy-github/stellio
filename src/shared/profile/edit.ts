// Pure edits on a ProfileDoc. Each one rewrites only the lines it owns and returns a new doc; the input is
// never mutated and no function throws on odd documents (unfixable cases return the doc unchanged).
import { Document, isCollection, isMap, isNode, isScalar, isSeq, parseDocument, stringify } from 'yaml';
import {
  detectEol,
  findEntries,
  findTable,
  firstSection,
  isBlank,
  lastContentLine,
  scanLayout,
  SKILL_COLUMNS,
  splitCells,
  splitLines,
  type Layout,
  type SectionNode,
} from './layout';
import {
  renderEntry,
  renderSkillRow,
  sectionTitle,
  skillCells,
  SKILLS_HEADER,
  SKILLS_SEPARATOR,
} from './render';
import { canonicalSkillKey } from './skills';
import {
  SECTION_KINDS,
  type Entry,
  type EntrySection,
  type ProfileDoc,
  type SectionKind,
  type SkillRow,
} from './types';

/** Every line but the last must end in a newline; edits can leave the old last line without one. */
function finish(lines: string[], eol: string): ProfileDoc {
  return { lines: lines.map((l, i) => (i < lines.length - 1 && !l.endsWith('\n') ? l + eol : l)) };
}

/** Replace lines[start, end) by `next`, keeping the common prefix and suffix lines untouched. */
function spliceMin(lines: readonly string[], start: number, end: number, next: readonly string[]): string[] {
  const oldLen = end - start;
  let a = 0;
  while (a < oldLen && a < next.length && lines[start + a] === next[a]) a++;
  let b = 0;
  while (b < oldLen - a && b < next.length - a && lines[end - 1 - b] === next[next.length - 1 - b]) b++;
  return [...lines.slice(0, start + a), ...next.slice(a, next.length - b), ...lines.slice(end - b)];
}

const lineEnd = (line: string): string => /\r?\n$/.exec(line)?.[0] ?? '';

/** Add a new section where its kind belongs: before the first later known section, else at the end. */
function insertSection(
  lines: string[],
  layout: Layout,
  kind: SectionKind,
  body: string[],
  eol: string,
): string[] {
  const rank = SECTION_KINDS.indexOf(kind);
  const next = layout.sections.find((s) => s.kind !== null && SECTION_KINDS.indexOf(s.kind) > rank);
  const at = next ? next.start : lines.length;
  const before = lines.slice(0, at);
  const block = [`## ${sectionTitle(kind)}${eol}`, eol, ...body];
  if (!next) {
    if (layout.endsInComment) before.push(`-->${eol}`);
    if (layout.endFence !== null) before.push(`${layout.endFence}${eol}`);
  }
  const last = before[before.length - 1];
  if (last !== undefined && !isBlank(last)) before.push(eol);
  return [...before, ...block, ...(next ? [eol] : []), ...lines.slice(at)];
}

/** Append a block after the last content line of a section, separated by a blank line. */
function appendToSection(
  lines: string[],
  layout: Layout,
  sec: SectionNode,
  block: string[],
  eol: string,
): string[] {
  const at = lastContentLine(lines, sec) + 1;
  const closers: string[] = [];
  if (sec.end === lines.length) {
    if (layout.endsInComment) closers.push(`-->${eol}`);
    if (layout.endFence !== null) closers.push(`${layout.endFence}${eol}`);
  }
  return [...lines.slice(0, at), ...closers, eol, ...block, ...lines.slice(at)];
}

export function upsertSkill(doc: ProfileDoc, row: SkillRow): ProfileDoc {
  const lines = [...doc.lines];
  const eol = detectEol(lines);
  const layout = scanLayout(lines);
  const newTable = [
    `${SKILLS_HEADER}${eol}`,
    `${SKILLS_SEPARATOR}${eol}`,
    `${renderSkillRow(row, SKILL_COLUMNS)}${eol}`,
  ];
  const sec = firstSection(layout, 'skills');
  if (!sec) return finish(insertSection(lines, layout, 'skills', newTable, eol), eol);
  const { table } = findTable(lines, layout, sec);
  const nameCol = table?.columns.indexOf('skill') ?? -1;
  if (!table || nameCol < 0) return finish(appendToSection(lines, layout, sec, newTable, eol), eol);

  const key = canonicalSkillKey(row.skill);
  const hit = table.rows.find((i) => canonicalSkillKey(splitCells(lines[i] ?? '')[nameCol] ?? '') === key);
  if (hit === undefined) {
    const at = (table.rows[table.rows.length - 1] ?? table.header + 1) + 1;
    lines.splice(at, 0, `${renderSkillRow(row, table.columns)}${eol}`);
    return finish(lines, eol);
  }
  const old = lines[hit] ?? '';
  const oldCells = splitCells(old);
  const cells = skillCells(row, table.columns, oldCells);
  if (cells.length === oldCells.length && cells.every((c, i) => c === oldCells[i])) return doc;
  lines[hit] = `${renderSkillRow(row, table.columns, oldCells)}${lineEnd(old)}`;
  return finish(lines, eol);
}

/** Remove every row whose skill name matches `name` (alias-insensitive, name column only). */
export function removeSkill(doc: ProfileDoc, name: string): ProfileDoc {
  const layout = scanLayout(doc.lines);
  const sec = firstSection(layout, 'skills');
  const table = sec ? findTable(doc.lines, layout, sec).table : null;
  const nameCol = table?.columns.indexOf('skill') ?? -1;
  if (!table || nameCol < 0) return doc;
  const key = canonicalSkillKey(name);
  const drop = new Set(
    table.rows.filter((i) => canonicalSkillKey(splitCells(doc.lines[i] ?? '')[nameCol] ?? '') === key),
  );
  if (drop.size === 0) return doc;
  return finish(
    doc.lines.filter((_, i) => !drop.has(i)),
    detectEol(doc.lines),
  );
}

/** True when any collection on the way to `keys` uses flow style (`{ a: b }`), where plain text splicing is unsafe. */
function inFlow(y: Document, keys: readonly (string | number)[]): boolean {
  let cur: unknown = y.contents;
  for (const k of keys) {
    if (!isCollection(cur)) return false;
    if (cur.flow) return true;
    cur = cur.get(k, true);
  }
  return false;
}

/**
 * Set a front matter value by path (`'preferences.remote'` or `['links', 'github']`). Scalar replacements
 * splice only the value's characters, so comments and spacing on every line stay byte-identical; anything
 * else goes through yaml's Document API, which keeps comments but may normalize spacing near them.
 */
export function setFrontMatterField(
  doc: ProfileDoc,
  path: string | readonly (string | number)[],
  value: unknown,
): ProfileDoc {
  const keys = typeof path === 'string' ? path.split('.') : [...path];
  const eol = detectEol(doc.lines);
  const layout = scanLayout(doc.lines);
  if (keys.length === 0 || layout.fmUnterminated) return doc;

  if (!layout.fm) {
    const y = new Document({});
    y.setIn(keys, value);
    const body = splitLines(y.toString({ lineWidth: 0 }).replace(/\n/g, eol));
    const first = doc.lines[0];
    const gap = first === undefined || isBlank(first) ? [] : [eol];
    return finish([`---${eol}`, ...body, `---${eol}`, ...gap, ...doc.lines], eol);
  }

  const start = layout.fm.start + 1;
  const end = layout.fm.end - 1;
  const src = doc.lines.slice(start, end).join('');
  const y = parseDocument(src);
  if (y.errors.length > 0 || (y.contents !== null && !isMap(y.contents))) return doc;

  const node = y.getIn(keys, true);
  const plain = (v: unknown): boolean => v === null || ['string', 'number', 'boolean'].includes(typeof v);
  let text: string | null = null;
  if (plain(value) && isScalar(node) && !inFlow(y, keys)) text = stringify(value, { lineWidth: 0 }).trimEnd();
  else if (Array.isArray(value) && value.every(plain) && isSeq(node) && node.flow) {
    text = stringify(value, {
      collectionStyle: 'flow',
      flowCollectionPadding: false,
      lineWidth: 0,
    }).trimEnd();
  }
  let next: string;
  if (
    text !== null &&
    !text.includes('\n') &&
    (isScalar(node) || isSeq(node)) &&
    node.range &&
    node.range[0] !== node.range[1]
  ) {
    next = src.slice(0, node.range[0]) + text + src.slice(node.range[1]);
  } else {
    const fresh = y.createNode(value);
    if (isNode(node)) {
      fresh.comment = node.comment;
      fresh.commentBefore = node.commentBefore;
    }
    y.setIn(keys, fresh);
    next = y.toString({ lineWidth: 0 }).replace(/\n/g, eol);
  }
  return finish(spliceMin(doc.lines, start, end, splitLines(next)), eol);
}

/** Replace the entry with the same id in `section`, or append it (creating the section if needed). */
export function upsertEntry(doc: ProfileDoc, section: EntrySection, entry: Entry): ProfileDoc {
  const lines = [...doc.lines];
  const eol = detectEol(lines);
  const layout = scanLayout(lines);
  const sec = firstSection(layout, section);
  if (!sec) return finish(insertSection(lines, layout, section, renderEntry(entry, eol), eol), eol);

  const node = entry.id === '' ? undefined : findEntries(lines, layout, sec).find((n) => n.id === entry.id);
  if (!node) return finish(appendToSection(lines, layout, sec, renderEntry(entry, eol), eol), eol);

  const owned = new Set<number>([node.start, ...node.meta.map((m) => m.line)]);
  for (const b of node.bullets) for (let i = b.start; i < b.end; i++) owned.add(i);
  // Comments or stray text between the fields have no model slot; keep them after the rewritten entry.
  const foreign = lines
    .slice(node.start, node.coreEnd)
    .filter((l, n) => !owned.has(node.start + n) && !isBlank(l));
  const next = [...renderEntry(entry, eol, { node, lines }), ...foreign];
  return finish(spliceMin(lines, node.start, node.coreEnd, next), eol);
}
