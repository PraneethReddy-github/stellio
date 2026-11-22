/**
 * Reads a resume .tex built from the Stellio macros back into plain text and structure, so lint and the ATS
 * check work the same on generated and hand-edited versions. Pure; never throws.
 */

// Escaped text is swapped for placeholders first, so stripping markup below cannot touch it.
const ESCAPED: [RegExp, string][] = [
  [/\\textbackslash\{\}/g, '\uE001'],
  [/\\\{/g, '\uE002'],
  [/\\\}/g, '\uE003'],
  [/\\textasciitilde\{\}/g, '\uE004'],
  [/\\textasciicircum\{\}/g, '^'],
  [/\\textbullet\{\}/g, '•'],
  [/\\textperiodcentered\{\}/g, '·'],
  [/\\texttimes\{\}/g, '×'],
  [/\\([&%$#_])/g, '$1'],
  [/\\,/g, ' '],
];
const TYPOGRAPHY: [RegExp, string][] = [
  [/---/g, '—'],
  [/--/g, '–'],
  [/``|''/g, '"'],
  [/~/g, ' '],
  [/\uE001/g, '\\'],
  [/\uE002/g, '{'],
  [/\uE003/g, '}'],
  [/\uE004/g, '~'],
];

/** LaTeX fragment → plain text: escapes undone, `\detokenize{x}` → x, other commands and braces dropped. */
export function texToText(s: string): string {
  let t = s.replace(/\\detokenize\{([^{}]*)\}/g, '$1').replace(/\\(?:begin|end)\{[^{}]*\}/g, ' ');
  for (const [re, rep] of ESCAPED) t = t.replace(re, rep);
  t = t
    .replace(/\\\\/g, ' ')
    .replace(/\\[A-Za-z@]+\*?/g, ' ')
    .replace(/[{}]/g, '');
  for (const [re, rep] of TYPOGRAPHY) t = t.replace(re, rep);
  return t
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .trim();
}

/** Drops `%` comments (an unescaped %), line by line. */
export function stripComments(tex: string): string {
  return tex
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|[^\\])((?:\\\\)*)%.*$/, '$1$2'))
    .join('\n');
}

/** Reads `n` brace groups starting at `pos` (whitespace allowed between). Escaped braces do not count. */
function readGroups(s: string, pos: number, n: number): { args: string[]; end: number } | null {
  const args: string[] = [];
  let i = pos;
  for (let k = 0; k < n; k++) {
    while (i < s.length && /\s/.test(s[i] ?? '')) i++;
    if (s[i] !== '{') return null;
    let depth = 0;
    const start = i + 1;
    for (; i < s.length; i++) {
      const c = s[i];
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === '{') depth++;
      else if (c === '}' && --depth === 0) break;
    }
    if (depth !== 0) return null;
    args.push(s.slice(start, i));
    i++;
  }
  return { args, end: i };
}

export interface ReadEntry {
  title: string;
  dates: string;
  bullets: string[];
}
export interface ReadSection {
  /** Heading as written ("Experience"); "Summary" for \resumeSummary. */
  heading: string;
  entries: ReadEntry[];
  summary: string | null;
  skillLines: { label: string; skills: string[] }[];
}
export interface ReadResume {
  hasHeader: boolean;
  sections: ReadSection[];
  /** Plain text of the document body. */
  text: string;
  /** Body (after \begin{document}), comments removed. */
  body: string;
  preamble: string;
}

const MACROS: Record<string, number> = {
  section: 1,
  resumeHeader: 6,
  resumeSummary: 1,
  resumeEntry: 4,
  resumeProject: 3,
  resumeItem: 1,
  skillLine: 2,
};

export function readResume(tex: string): ReadResume {
  const clean = stripComments(tex);
  const at = clean.indexOf('\\begin{document}');
  const preamble = at >= 0 ? clean.slice(0, at) : '';
  const body = at >= 0 ? clean.slice(at + '\\begin{document}'.length) : clean;
  const sections: ReadSection[] = [];
  let hasHeader = false;
  const open = (heading: string): ReadSection => {
    const s: ReadSection = { heading, entries: [], summary: null, skillLines: [] };
    sections.push(s);
    return s;
  };
  let cur: ReadSection | null = null;
  const here = (): ReadSection => (cur ??= open(''));
  const re =
    /\\(section\*?|resumeHeader|resumeSummary|resumeEntry|resumeProject|resumeItem|skillLine)(?![A-Za-z])/g;
  for (let m = re.exec(body); m; m = re.exec(body)) {
    const name = (m[1] ?? '').replace('*', '');
    const g = readGroups(body, m.index + m[0].length, MACROS[name] ?? 0);
    if (!g) continue;
    re.lastIndex = g.end;
    const a = g.args.map(texToText);
    if (name === 'resumeHeader') hasHeader = true;
    else if (name === 'section') cur = open(a[0] ?? '');
    else if (name === 'resumeSummary') {
      cur = open('Summary');
      cur.summary = a[0] ?? '';
    } else if (name === 'resumeEntry' || name === 'resumeProject')
      here().entries.push({
        title: a[0] ?? '',
        dates: (name === 'resumeEntry' ? a[1] : a[2]) ?? '',
        bullets: [],
      });
    else if (name === 'resumeItem') {
      const s = here();
      if (s.entries.length === 0) s.entries.push({ title: '', dates: '', bullets: [] });
      s.entries.at(-1)?.bullets.push(a[0] ?? '');
    } else if (name === 'skillLine')
      here().skillLines.push({
        label: a[0] ?? '',
        skills: (a[1] ?? '')
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean),
      });
  }
  return {
    hasHeader,
    sections,
    text: texToText(body.replace(/\\end\{document\}[\s\S]*$/, '')),
    body,
    preamble,
  };
}
