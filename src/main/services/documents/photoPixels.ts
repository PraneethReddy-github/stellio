/**
 * Composites 32-bit BGRA pixels onto white and makes them opaque. Chromium bitmaps are premultiplied, so a
 * colour channel already carries its alpha: white shows through as 255 × (1 − alpha). Pure; returns a new buffer.
 */
export function flattenOnWhite(px: Buffer): Buffer {
  const out = Buffer.from(px);
  for (let i = 0; i + 3 < out.length; i += 4) {
    const a = (out[i + 3] ?? 255) / 255;
    for (let c = 0; c < 3; c++) out[i + c] = Math.min(255, Math.round((out[i + c] ?? 0) + 255 * (1 - a)));
    out[i + 3] = 255;
  }
  return out;
}
