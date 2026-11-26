import type { Diagnostic } from '../profile';
import type { TemplateKind } from '../rules/files';

export const REQUIRED_SLOTS: Record<TemplateKind, readonly string[]> = {
  resume: ['header', 'summary', 'experience', 'projects', 'skills', 'education', 'certifications'],
  'cover-letter': ['header', 'recipient', 'body', 'closing'],
};
/** Slots Stellio fills when a template has them (template format 2, D25). */
export const OPTIONAL_SLOTS: Record<TemplateKind, readonly string[]> = {
  resume: ['publications', 'patents', 'misc', 'updated'],
  'cover-letter': [],
};

export interface Slot {
  name: string;
  /** 1-based line of the `%% STELLIO:SLOT` marker. */
  startLine: number;
  /** 1-based line of the `%% STELLIO:END` marker. */
  endLine: number;
  /** Lines between the markers, joined with "\n". */
  content: string;
}

export interface ParsedTemplate {
  slots: Slot[];
  /** Command names defined with \newcommand / \renewcommand / \providecommand / \def (no backslash). */
  macros: string[];
  /** Environment names defined with \newenvironment / \renewenvironment. */
  environments: string[];
  diagnostics: Diagnostic[];
}

const OPEN = /^\s*%%\s*STELLIO:SLOT(?:\s+(\S*))?\s*$/;
const CLOSE = /^\s*%%\s*STELLIO:END(?:\s+(\S*))?\s*$/;
const NAME = /^[a-z][a-z0-9_-]*$/;

const stripComment = (l: string): string => l.replace(/(?<!\\)%.*$/, '');

/** Reads slot markers and macro definitions. Pure; never throws. */
export function parseTemplate(tex: string, kind?: TemplateKind): ParsedTemplate {
  const lines = tex.split(/\r?\n/);
  const slots: Slot[] = [];
  const diagnostics: Diagnostic[] = [];
  const err = (code: string, message: string, line: number): void => {
    diagnostics.push({ severity: 'error', code, message, line });
  };

  const seen = new Set<string>();
  let open: { name: string; line: number; dup: boolean } | null = null;
  for (const [i, text] of lines.entries()) {
    const line = i + 1;
    const o = OPEN.exec(text);
    const c = CLOSE.exec(text);
    if (o) {
      const name = o[1] ?? '';
      if (name === '' || !NAME.test(name)) {
        err('slot_name_invalid', `Slot name "${name}" must be lowercase letters, digits, - or _`, line);
      }
      if (open) {
        err(
          'slot_nested',
          `Slot "${name}" starts inside slot "${open.name}" (opened on line ${open.line})`,
          line,
        );
        continue;
      }
      const dup = seen.has(name);
      if (dup) err('slot_duplicate', `Slot "${name}" is defined more than once`, line);
      seen.add(name);
      open = { name, line, dup };
    } else if (c) {
      const name = c[1] ?? '';
      if (!open) {
        err('slot_end_without_start', `END "${name}" has no matching SLOT`, line);
        continue;
      }
      if (name !== open.name) {
        err(
          'slot_mismatch',
          `END "${name}" does not match the open slot "${open.name}" (line ${open.line})`,
          line,
        );
      }
      if (!open.dup) {
        slots.push({
          name: open.name,
          startLine: open.line,
          endLine: line,
          content: lines.slice(open.line, i).join('\n'),
        });
      }
      open = null;
    }
  }
  if (open) {
    err(
      'slot_unclosed',
      `Slot "${open.name}" is never closed (missing %% STELLIO:END ${open.name})`,
      open.line,
    );
  }

  if (kind) {
    for (const name of REQUIRED_SLOTS[kind]) {
      if (!slots.some((s) => s.name === name)) err('slot_missing', `Required slot "${name}" is missing`, 1);
    }
    for (const s of slots) {
      if (!REQUIRED_SLOTS[kind].includes(s.name) && !OPTIONAL_SLOTS[kind].includes(s.name))
        diagnostics.push({
          severity: 'warning',
          code: 'slot_unknown',
          message: `Slot "${s.name}" is not used by Stellio and will not be filled`,
          line: s.startLine,
        });
    }
  }

  const code = lines.map(stripComment).join('\n');
  const macros = unique([
    ...matches(code, /\\(?:newcommand|renewcommand|providecommand)\*?\s*\{?\s*\\([A-Za-z@]+)/g),
    ...matches(code, /\\def\s*\\([A-Za-z@]+)/g),
  ]);
  const environments = unique(
    matches(code, /\\(?:newenvironment|renewenvironment)\*?\s*\{\s*([A-Za-z@*]+)\s*\}/g),
  );
  return { slots, macros, environments, diagnostics };
}

function matches(s: string, re: RegExp): string[] {
  return [...s.matchAll(re)].map((m) => m[1] ?? '');
}
const unique = (a: string[]): string[] => [...new Set(a)];

/**
 * Replaces slot bodies with `contents[name]`; the markers stay, so the result can be parsed again.
 * An empty string omits the slot's body. Slots without an entry, and all text outside slots, are untouched.
 * Marker-looking lines in the new content are dropped so they cannot corrupt the structure.
 */
export function fillTemplate(tex: string, contents: Readonly<Record<string, string>>): string {
  const eol = tex.includes('\r\n') ? '\r\n' : '\n';
  const lines = tex.split(/\r?\n/);
  const { slots } = parseTemplate(tex);
  const out: string[] = [];
  let at = 0; // next source line index (0-based) not yet copied
  for (const s of [...slots].sort((a, b) => a.startLine - b.startLine)) {
    const fill = Object.hasOwn(contents, s.name) ? contents[s.name] : undefined;
    if (fill === undefined || fill === s.content) continue;
    out.push(...lines.slice(at, s.startLine)); // through the SLOT marker
    const body = fill.split(/\r?\n/).filter((l) => !OPEN.test(l) && !CLOSE.test(l));
    while (body.length > 0 && body[body.length - 1]?.trim() === '') body.pop();
    out.push(...(fill.trim() === '' ? [] : body));
    at = s.endLine - 1; // resume at the END marker
  }
  out.push(...lines.slice(at));
  return out.join(eol);
}

const ESCAPES: Record<string, string> = {
  '\\': '\\textbackslash{}',
  '&': '\\&',
  '%': '\\%',
  $: '\\$',
  '#': '\\#',
  _: '\\_',
  '{': '\\{',
  '}': '\\}',
  '~': '\\textasciitilde{}',
  '^': '\\textasciicircum{}',
  // Typographic characters that Tectonic (XeTeX + T1 Charter) silently drops and pdfTeX may reject.
  // The ASCII/ligature spellings behave the same on both engines and extract as the same Unicode text.
  '\u2014': '---',
  '\u2013': '--',
  '\u2012': '--',
  '\u2010': '-',
  '\u2011': '-',
  '\u2212': '-',
  '\u2018': '`',
  '\u2019': "'",
  '\u201A': ',',
  '\u201C': '``',
  '\u201D': "''",
  '\u2026': '...',
  '\u2022': '\\textbullet{}',
  '\u00B7': '\\textperiodcentered{}',
  '\u00D7': '\\texttimes{}',
  '\u00A0': '~',
  '\u202F': '~',
  '\u2009': '\\,',
  // Ligature code points (pasted from PDFs) would be stripped as unsupported; spell them out.
  '\ufb00': 'ff',
  '\ufb01': 'fi',
  '\ufb02': 'fl',
  '\ufb03': 'ffi',
  '\ufb04': 'ffl',
  '\ufb05': 'st',
  '\ufb06': 'st',
};
const SPECIAL = new RegExp(
  `[${Object.keys(ESCAPES)
    .map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
    .join('')}]`,
  'g',
);
// Control characters (except \n and \t) and zero-width characters break compiles and ATS matching.
// eslint-disable-next-line no-control-regex
const INVISIBLE = /[\u0000-\u0008\u000B-\u001F\u007F\u200B-\u200D\u2060\uFEFF]/g;
// shortcut: anything outside Latin-1 / Latin Extended-A (U+0020-U+017F) is dropped (pdfTeX would fail on it,
// Tectonic would drop it); upgrade when non-Latin resumes are needed.
const UNSUPPORTED = /[^\n\t -~\u00A0-\u017F]/g;

/**
 * Under Tectonic (XeTeX) the 8-bit T1 fonts place a Unicode letter by its code point: Latin-1 letters land on
 * the right T1 slots, but ß lands on "SS", ÿ on ß, and every Latin Extended-A letter is dropped. LaTeX's own
 * commands for them (`\ss{}`, `\"{y}`, `\v{r}`, `\l{}`) pick the T1 glyph on both engines.
 */
const LETTER_CMD: Record<string, string> = {
  ß: '\\ss{}',
  Đ: '\\DJ{}',
  đ: '\\dj{}',
  Ħ: 'H',
  ħ: 'h',
  ı: '\\i{}',
  Ĳ: 'IJ',
  ĳ: 'ij',
  ĸ: 'k',
  Ŀ: 'L',
  ŀ: 'l',
  Ł: '\\L{}',
  ł: '\\l{}',
  ŉ: "'n",
  Ŋ: '\\NG{}',
  ŋ: '\\ng{}',
  Œ: '\\OE{}',
  œ: '\\oe{}',
  ſ: 's',
};
/** Combining mark → accent command. */
export const ACCENT_CMD: Record<string, string> = {
  '\u0300': '`',
  '\u0301': "'",
  '\u0302': '^',
  '\u0303': '~',
  '\u0304': '=',
  '\u0306': 'u',
  '\u0307': '.',
  '\u0308': '"',
  '\u030A': 'r',
  '\u030B': 'H',
  '\u030C': 'v',
  '\u0327': 'c',
  '\u0328': 'k',
};
const NEEDS_CMD = /[\u00DF\u00FF\u0100-\u017F]/g;
const letterCmd = (c: string): string => {
  const fixed = LETTER_CMD[c];
  if (fixed !== undefined) return fixed;
  const d = c.normalize('NFD'); // one base letter plus one combining mark, all in the BMP
  const base = d.charAt(0);
  const mark = d.slice(1);
  const acc = ACCENT_CMD[mark];
  return acc === undefined ? base : `\\${acc}{${base}}`;
};

/** Escapes plain text for use as LaTeX body text. Do not use it for header arguments (see checkHeaderArg). */
export function escapeLatex(text: string): string {
  return text
    .normalize('NFC')
    .replace(INVISIBLE, '')
    .replace(SPECIAL, (c) => ESCAPES[c] ?? c)
    .replace(NEEDS_CMD, letterCmd)
    .replace(UNSUPPORTED, '');
}

export type HeaderArgCheck = { ok: true; value: string } | { ok: false; reason: string };

/**
 * Header arguments (email, URLs) are passed raw and printed with \detokenize, so they must NOT be escaped.
 * `%` and `#` break the compile either way and are rejected, as are newlines and unbalanced braces.
 */
export function checkHeaderArg(value: string): HeaderArgCheck {
  if (/[%#]/.test(value))
    return { ok: false, reason: 'must not contain % or # (strip the query or fragment)' };
  if (Array.from(value, (c) => c.charCodeAt(0)).some((c) => c < 32))
    return { ok: false, reason: 'must be a single line' };
  let depth = 0;
  for (const ch of value) {
    if (ch === '{') depth++;
    if (ch === '}' && --depth < 0) break;
  }
  if (depth !== 0) return { ok: false, reason: 'has unbalanced braces' };
  return { ok: true, value };
}
