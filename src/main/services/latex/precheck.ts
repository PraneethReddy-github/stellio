import type { CompileError } from './compile';
import { DENY_EXACT, DENY_GROUP, DENY_PARTS, norm } from '@shared/latex/deny';

/**
 * Second layer behind the bwrap sandbox (docs/06 §7): rejects TeX file I/O primitives and the usual ways to
 * hide them. Templates never need these. TeX is a full programming language, so this is a best-effort denylist;
 * the sandbox is the security boundary.
 */

/** The one file input the seed templates use, pdfTeX only (spikes/latex/FINDINGS.md). */
const GLYPHTOUNICODE = '\\ifdefined\\pdfgentounicode\\input{glyphtounicode}\\pdfgentounicode=1\\fi';

const denied = (name: string): boolean => {
  const n = norm(name);
  return DENY_EXACT.has(n) || DENY_PARTS.some((p) => n.includes(p));
};

const ALLOWED_SCHEMES = new Set(['http', 'https', 'mailto']);

/** Line-numbered problems; empty when the source looks safe to compile. */
export function precheckTex(tex: string): CompileError[] {
  const errors: CompileError[] = [];
  const add = (line: number, what: string) => {
    if (errors.length < 20)
      errors.push({
        line,
        message: `Stellio templates can't read or write files: ${what} on line ${String(line)}`,
      });
  };
  tex.split(/\r\n?|\n/).forEach((raw, i) => {
    const line = i + 1;
    // Drop the comment (an unescaped %): it is never executed.
    const text = raw.replace(/(^|[^\\])((?:\\\\)*)%.*$/, '$1$2').replaceAll(GLYPHTOUNICODE, '');
    if (text.includes('^^')) add(line, '^^ character escapes');
    for (const m of text.matchAll(/\\([A-Za-z@]+)/g)) if (denied(m[1] ?? '')) add(line, `\\${m[1] ?? ''}`);
    const loads = /\\(?:usepackage|RequirePackage|documentclass|LoadClass)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g;
    for (const m of text.matchAll(loads))
      if (!/^[\w\s,-]*$/.test(m[1] ?? '')) add(line, `a package or class path "${m[1] ?? ''}"`);
    // `\begin{input}` and `\b{input}` (with \let\b\begin) call \input through \csname.
    for (const m of text.replace(loads, '').matchAll(/\{\s*([A-Za-z@]+\*?)\s*\}/g))
      if (DENY_GROUP.has(norm(m[1] ?? ''))) add(line, `{${m[1] ?? ''}}`);
    for (const m of text.matchAll(/\\(?:href|url)\s*\{\s*([A-Za-z][\w+.-]*):/g))
      if (!ALLOWED_SCHEMES.has((m[1] ?? '').toLowerCase())) add(line, `a ${m[1] ?? ''}: link`);
  });
  return errors;
}
