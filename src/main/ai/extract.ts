import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';

const MAX_BYTES = 10 * 1024 * 1024;

/** Rough LaTeX to text: drops comments/preamble/macros, keeps macro arguments and line structure. */
export function texToText(tex: string): string {
  let s = tex.replace(/(?<!\\)%.*$/gm, '');
  const body = /\\begin\{document\}([\s\S]*?)(?:\\end\{document\}|$)/.exec(s);
  if (body?.[1] !== undefined) s = body[1];
  s = s
    .replace(/\\\\(\[[^\]]*\])?/g, '\n')
    .replace(/\\item\b\s*(\[[^\]]*\])?/g, '\n- ')
    .replace(/\\(?:begin|end)\{[^}]*\}(\[[^\]]*\])?/g, '\n')
    .replace(/\\href\{[^}]*\}/g, '')
    .replace(/\\([&%$#_{}])/g, '$1')
    .replace(/\}\s*\{/g, ' ')
    .replace(/\\[a-zA-Z]+\*?(\[[^\]]*\])?/g, ' ')
    .replace(/[{}]/g, '');
  return s
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function pdfToText(data: Uint8Array): Promise<string> {
  // pdfjs is ESM-only; dynamic import keeps the CJS main bundle working.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data, useSystemFonts: true });
  const doc = await task.promise;
  try {
    const pages: string[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      let out = '';
      let lastY: number | undefined;
      for (const item of content.items) {
        if (!('str' in item)) continue;
        const y = item.transform[5] as number;
        if (lastY !== undefined && Math.abs(y - lastY) > 2 && !out.endsWith('\n')) out += '\n';
        out += item.str;
        if (item.hasEOL) out += '\n';
        lastY = y;
      }
      pages.push(out.trim());
    }
    return pages.join('\n\n');
  } finally {
    await task.destroy();
  }
}

/** Number of pages in a PDF. */
export async function pdfPageCount(data: Uint8Array): Promise<number> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: new Uint8Array(data), useSystemFonts: true });
  try {
    return (await task.promise).numPages;
  } finally {
    await task.destroy();
  }
}

/** Plain text of a resume file (.pdf, .tex, .txt, .md). Rejects other types and files over 10 MB. */
export async function extractResumeText(file: string): Promise<string> {
  const ext = extname(file).toLowerCase();
  if (!['.pdf', '.tex', '.txt', '.md'].includes(ext)) throw new Error(`Unsupported file type "${ext}"`);
  if ((await stat(file)).size > MAX_BYTES) throw new Error('File is larger than 10 MB');
  const buf = await readFile(file);
  if (ext === '.pdf') return pdfToText(new Uint8Array(buf));
  const text = buf.toString('utf8');
  return ext === '.tex' ? texToText(text) : text;
}
