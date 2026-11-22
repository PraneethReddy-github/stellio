import { parseDocument } from 'yaml';
import {
  findEntries,
  findTable,
  firstSection,
  scanLayout,
  splitCells,
  splitLines,
  stripEol,
  unescapeFreeText,
  type Layout,
  type SectionNode,
} from './layout';
import {
  ENTRY_SECTIONS,
  FrontMatterSchema,
  ProfileSchema,
  type Diagnostic,
  type FrontMatter,
  type Profile,
  type ProfileDoc,
  type SkillRow,
} from './types';

export interface ParseResult {
  doc: ProfileDoc;
  model: Profile;
  diagnostics: Diagnostic[];
}

type Diag = (severity: Diagnostic['severity'], code: string, message: string, line: number | null) => void;

/** Never throws: any input yields a lossless `doc`, the best-effort `model` and diagnostics. */
export function parseProfile(markdown: string): ParseResult {
  const doc: ProfileDoc = { lines: splitLines(markdown) };
  const diagnostics: Diagnostic[] = [];
  try {
    const model = buildModel(doc.lines, (severity, code, message, line) =>
      diagnostics.push({ severity, code, message, line }),
    );
    return { doc, model, diagnostics };
  } catch (e) {
    const message = e instanceof Error ? e.message : 'unknown error';
    return {
      doc,
      model: ProfileSchema.parse({}),
      diagnostics: [
        { severity: 'error', code: 'internal_error', message: `Could not parse: ${message}`, line: null },
      ],
    };
  }
}

function buildModel(lines: readonly string[], diag: Diag): Profile {
  const layout = scanLayout(lines);
  const model = ProfileSchema.parse({});
  model.frontMatter = parseFrontMatter(lines, layout, diag);
  if (layout.unclosedAt !== null) {
    const comment = layout.endsInComment;
    diag(
      'error',
      comment ? 'comment_unclosed' : 'fence_unclosed',
      comment
        ? 'HTML comment is never closed with -->; everything after it is ignored'
        : 'Code fence is never closed; everything after it is ignored',
      layout.unclosedAt + 1,
    );
  }

  const seen = new Set<string>();
  for (const sec of layout.sections) {
    if (sec.kind === null) continue;
    if (seen.has(sec.kind)) {
      diag('warning', 'section_duplicate', `Duplicate "${sec.name}" section ignored`, sec.start + 1);
      sec.kind = null;
    } else seen.add(sec.kind);
  }
  // Duplicates were demoted to unknown above, so `firstSection` now sees only the first of each kind.
  const summary = firstSection(layout, 'summary');
  if (summary) model.summary = freeText(lines, summary);
  const notes = firstSection(layout, 'notes');
  if (notes) model.notes = freeText(lines, notes);
  const skills = firstSection(layout, 'skills');
  if (skills) model.skills = parseSkills(lines, layout, skills, diag);

  for (const kind of ENTRY_SECTIONS) {
    const sec = firstSection(layout, kind);
    if (!sec) continue;
    model[kind] = findEntries(lines, layout, sec).map((n) => {
      for (const i of n.stray) {
        diag('warning', 'entry_stray_text', `Text under "${n.title}" is not a bullet and is ignored`, i + 1);
      }
      return {
        id: n.id,
        title: n.title,
        meta: Object.fromEntries(n.meta.map((m) => [m.key, m.value])),
        bullets: n.bullets.map((b) => b.text),
      };
    });
  }
  return model;
}

function parseFrontMatter(lines: readonly string[], layout: Layout, diag: Diag): FrontMatter {
  const empty = FrontMatterSchema.parse({});
  if (!layout.fm) {
    if (layout.fmUnterminated)
      diag('error', 'frontmatter_unterminated', 'Front matter is missing its closing ---', 1);
    else diag('error', 'frontmatter_missing', 'Profile has no YAML front matter (--- block at the top)', 1);
    return empty;
  }
  const src = lines.slice(layout.fm.start + 1, layout.fm.end - 1).join('');
  const yaml = parseDocument(src);
  if (yaml.errors.length > 0) {
    for (const e of yaml.errors) {
      diag(
        'error',
        'frontmatter_yaml',
        e.message.split('\n')[0] ?? e.message,
        layout.fm.start + 1 + (e.linePos?.[0].line ?? 1),
      );
    }
    return empty;
  }
  const js: unknown = yaml.toJS();
  if (js === null || js === undefined) return empty;
  if (typeof js !== 'object' || Array.isArray(js)) {
    diag(
      'error',
      'frontmatter_not_mapping',
      'Front matter must be a key: value mapping',
      layout.fm.start + 2,
    );
    return empty;
  }
  const first = FrontMatterSchema.safeParse(js);
  if (first.success) return first.data;
  // Drop each offending field (so it falls back to its default) and report why.
  const cleaned = structuredClone(js) as Record<string, unknown>;
  for (const issue of first.error.issues) {
    const where = issue.path.join('.');
    diag(
      'error',
      'frontmatter_invalid',
      `Front matter field "${where}": ${issue.message}`,
      layout.fm.start + 2,
    );
    deleteAt(cleaned, issue.path);
  }
  const second = FrontMatterSchema.safeParse(cleaned);
  return second.success ? second.data : empty;
}

function deleteAt(root: Record<string, unknown>, path: readonly PropertyKey[]): void {
  let cur: unknown = root;
  for (const key of path.slice(0, -1)) {
    if (typeof cur !== 'object' || cur === null) return;
    cur = (cur as Record<PropertyKey, unknown>)[key];
  }
  const last = path[path.length - 1];
  if (typeof cur === 'object' && cur !== null && last !== undefined) {
    Reflect.deleteProperty(cur, last);
  }
}

function freeText(lines: readonly string[], sec: SectionNode): string {
  const text = lines
    .slice(sec.start + 1, sec.end)
    .map(stripEol)
    .join('\n')
    // Same rule as scanLayout: only a `<!--` that begins a line is a comment.
    .replace(/^[ \t]*<!--[\s\S]*?-->/gm, '')
    .replace(/(^|\n)[ \t]*<!--[\s\S]*$/, '$1')
    .trim();
  return unescapeFreeText(text);
}

const number = (cell: string, what: string, line: number, diag: Diag): number | null => {
  if (cell === '') return null;
  if (/^\d+(\.\d+)?$/.test(cell)) return Number(cell);
  diag('warning', 'skill_number_invalid', `"${cell}" is not a number (${what})`, line);
  return null;
};
const list = (cell: string): string[] =>
  cell
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');

function parseSkills(lines: readonly string[], layout: Layout, sec: SectionNode, diag: Diag): SkillRow[] {
  const { table, malformedAt } = findTable(lines, layout, sec);
  if (malformedAt !== null) {
    diag(
      'warning',
      'skills_table_malformed',
      'Skills table has no header separator row (|---|---|)',
      malformedAt + 1,
    );
  }
  if (!table) return [];
  if (!table.columns.includes('skill')) {
    diag('error', 'skills_table_malformed', 'Skills table has no "skill" column', table.header + 1);
    return [];
  }
  const missing = ['category', 'level', 'status'].filter((c) => !table.columns.includes(c));
  if (missing.length > 0) {
    diag(
      'warning',
      'skills_columns_missing',
      `Skills table lacks column(s): ${missing.join(', ')}`,
      table.header + 1,
    );
  }
  return table.rows.map((i) => {
    const cells = splitCells(lines[i] ?? '');
    if (cells.length !== table.columns.length) {
      diag(
        'warning',
        'skill_row_columns',
        `Row has ${cells.length} cells, header has ${table.columns.length}`,
        i + 1,
      );
    }
    const get = (name: string): string => cells[table.columns.indexOf(name)] ?? '';
    return {
      skill: get('skill'),
      category: get('category'),
      level: number(get('level'), 'level', i + 1, diag),
      years: number(get('years'), 'years', i + 1, diag),
      last_used: get('last_used'),
      evidence: list(get('evidence')),
      status: get('status'),
      aliases: list(get('aliases')),
    };
  });
}
