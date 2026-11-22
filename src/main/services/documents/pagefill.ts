/**
 * True when the text on the last page of `pdf` ends within ~2 lines of the bottom margin (docs/06 §7).
 * Margins are not in the PDF, so the bottom margin is taken to equal the top one: the gap above the highest
 * text on page 1. Line height is the median distance between baselines on the last page.
 */
export async function lastPageNearlyFull(pdf: Uint8Array, lines = 2): Promise<boolean> {
  // pdfjs is ESM-only; dynamic import keeps the CJS main bundle working.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: new Uint8Array(pdf), useSystemFonts: true });
  const doc = await task.promise;
  try {
    const items = async (n: number) =>
      (await (await doc.getPage(n)).getTextContent()).items
        .filter((i) => 'str' in i && i.str.trim() !== '')
        .map((i) => ({
          y: (i as { transform: number[] }).transform[5] ?? 0,
          h: (i as { height: number }).height,
        }));
    const first = await items(1);
    const lastPage = await doc.getPage(doc.numPages);
    const last = doc.numPages === 1 ? first : await items(doc.numPages);
    if (first.length === 0 || last.length === 0) return false;
    const [, y0 = 0, , y1 = 0] = lastPage.view;
    const topGap = y1 - Math.max(...first.map((i) => i.y + i.h));
    const bottomGap = Math.min(...last.map((i) => i.y)) - y0;
    const ys = [...new Set(last.map((i) => Math.round(i.y)))].sort((a, b) => b - a);
    const gaps = ys
      .slice(1)
      .map((y, k) => (ys[k] ?? 0) - y)
      .filter((g) => g > 1)
      .sort((a, b) => a - b);
    const lineHeight = gaps[Math.floor(gaps.length / 2)] ?? 12;
    return bottomGap - topGap < lines * lineHeight;
  } finally {
    await task.destroy();
  }
}
