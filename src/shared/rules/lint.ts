import { isMap, isSeq, LineCounter, parseDocument, type Document, type Node } from 'yaml';
import type { Diagnostic } from '../profile';
import type { RulesKind } from './files';
import { lenientSchemas, strictSchemas, type RulesConfigs } from './schemas';

export interface LintResult<K extends RulesKind = RulesKind> {
  /** Null when the front matter has errors. Unknown keys are only warnings, so the config is still returned. */
  config: RulesConfigs[K] | null;
  diagnostics: Diagnostic[];
}

/** Front matter location: lines[start] is the opening `---`, lines[end] the closing one (0-based). */
function findFrontMatter(lines: string[]): { start: number; end: number } | 'unterminated' | null {
  const isFence = (l: string) => (l.charCodeAt(0) === 0xfeff ? l.slice(1) : l).trimEnd() === '---';
  if (!isFence(lines[0] ?? '')) return null;
  for (let i = 1; i < lines.length; i++) if (isFence(lines[i] ?? '')) return { start: 0, end: i };
  return 'unterminated';
}

/** 1-based file line of the YAML node at `path`; falls back to the deepest ancestor that exists. */
function lineAt(
  doc: Document.Parsed,
  counter: LineCounter,
  path: readonly PropertyKey[],
  offset: number,
): number {
  let node: unknown = doc.contents;
  let best: Node | null = doc.contents;
  for (const key of path) {
    let next: unknown;
    if (isMap(node)) {
      const pair = node.items.find(
        (p) => String((p.key as { value?: unknown } | null)?.value) === String(key),
      );
      if (pair) best = (pair.key as Node | null) ?? best;
      next = pair?.value;
    } else if (isSeq(node)) {
      next = node.items[Number(key)];
      if (next) best = next as Node;
    }
    if (!next) break;
    node = next;
  }
  const at = best?.range?.[0] ?? 0;
  return offset + counter.linePos(at).line - 1;
}

/** Validates a rules file's YAML front matter. Pure; never throws. */
export function lintRules<K extends RulesKind>(kind: K, markdown: string): LintResult<K> {
  const diagnostics: Diagnostic[] = [];
  const add = (
    severity: Diagnostic['severity'],
    code: string,
    message: string,
    line: number | null,
  ): void => {
    diagnostics.push({ severity, code, message, line });
  };
  const fail = (): LintResult<K> => ({ config: null, diagnostics });

  const lines = markdown.split(/\r?\n/);
  const fm = findFrontMatter(lines);
  if (fm === null) {
    add('error', 'frontmatter_missing', 'The file must start with a YAML front matter block (---)', 1);
    return fail();
  }
  if (fm === 'unterminated') {
    add('error', 'frontmatter_unterminated', 'Front matter is missing its closing ---', 1);
    return fail();
  }

  const counter = new LineCounter();
  const doc = parseDocument(lines.slice(fm.start + 1, fm.end).join('\n'), { lineCounter: counter });
  const offset = fm.start + 2; // file line of YAML line 1
  if (doc.errors.length > 0) {
    for (const e of doc.errors)
      add(
        'error',
        'frontmatter_yaml',
        e.message.split('\n')[0] ?? e.message,
        offset + (e.linePos?.[0].line ?? 1) - 1,
      );
    return fail();
  }
  const raw: unknown = doc.toJS();
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
    add('error', 'frontmatter_not_mapping', 'Front matter must be a key: value mapping', offset);
    return fail();
  }

  const strict = strictSchemas[kind].safeParse(raw);
  if (!strict.success) {
    for (const issue of strict.error.issues) {
      if (issue.code === 'unrecognized_keys') {
        for (const key of issue.keys)
          add(
            'warning',
            'rules_unknown_key',
            `Unknown key "${[...issue.path, key].join('.')}" is ignored`,
            lineAt(doc, counter, [...issue.path, key], offset),
          );
        continue;
      }
      const where = issue.path.join('.');
      const label = where === '' ? '' : `"${where}": `;
      const missing =
        issue.path.reduce<unknown>((v, k) => (v as Record<PropertyKey, unknown> | undefined)?.[k], raw) ===
        undefined;
      add(
        'error',
        missing ? 'rules_missing_key' : 'rules_invalid_value',
        `${label}${missing ? 'is required' : issue.message}`,
        lineAt(doc, counter, issue.path, offset),
      );
    }
  }
  if (diagnostics.some((d) => d.severity === 'error')) return fail();

  const lenient = lenientSchemas[kind].safeParse(raw);
  return lenient.success ? { config: lenient.data as RulesConfigs[K], diagnostics } : fail();
}
