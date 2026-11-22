// Rasterizes resources/icon.svg to resources/icons/<n>x<n>.png (electron-builder linux.icon).
// Uses @napi-rs/canvas, which pdfjs-dist already pulls in as an optional dependency: no extra package.
// Run: node scripts/make-icons.mjs
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const SIZES = [512, 256, 128, 64, 32, 16];
const svg = readFileSync('resources/icon.svg');
const image = await loadImage(svg);
mkdirSync('resources/icons', { recursive: true });
for (const n of SIZES) {
  const canvas = createCanvas(n, n);
  canvas.getContext('2d').drawImage(image, 0, 0, n, n);
  writeFileSync(`resources/icons/${String(n)}x${String(n)}.png`, canvas.toBuffer('image/png'));
}
console.log(`wrote ${String(SIZES.length)} icons`);
