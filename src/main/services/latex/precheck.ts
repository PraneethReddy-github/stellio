import type { CompileError } from './compile';
import { DENY_EXACT, DENY_GROUP, DENY_PARTS, norm } from '@shared/latex/deny';

/**
 * Second layer behind the bwrap sandbox (docs/06 §7): rejects TeX file I/O primitives and the usual ways to
 * hide them. Templates never need these. TeX is a full programming language, so this is a best-effort denylist;
 * the sandbox is the security boundary.
 */

/** The one file input the seed templates use, pdfTeX only (spikes/latex/FINDINGS.md). */
const GLYPHTOUNICODE = '\\ifdefined\\pdfgentounicode\\input{glyphtounicode}\\pdfgentounicode=1\\fi';

/**
 * The one image a template may load: the user's photo, copied into the sandbox work dir as photo.jpg by the
 * compile (D26). Only the literal name `photo`, with plain options; any other \includegraphics is refused.
 */
export const PHOTO_INCLUDE =
  /\\includegraphics\s*(?:\[\s*(?:(?:width|height|scale|clip|trim|keepaspectratio|angle)\s*(?:=\s*[A-Za-z0-9. -]*)?\s*(?:,\s*)?)*\])?\s*\{photo\}/g;

/** graphicx settings that change where or how `{photo}` is read; the photo exception must not reach them. */
const GRAPHICS_SETUP = new Set(['graphicspath', 'setkeys']);

const denied = (name: string): boolean => {
  const n = norm(name);
  return (
    DENY_EXACT.has(n) ||
    DENY_PARTS.some((p) => n.includes(p)) ||
    GRAPHICS_SETUP.has(n) ||
    n.startsWith('declaregraphics') ||
    n.startsWith('gin') // \Gin@... internals of graphicx
  );
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
    const text = raw
      .replace(/(^|[^\\])((?:\\\\)*)%.*$/, '$1$2')
      .replaceAll(GLYPHTOUNICODE, '')
      .replace(PHOTO_INCLUDE, '');
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
