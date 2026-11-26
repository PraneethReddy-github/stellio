import { nativeImage } from 'electron';
import { flattenOnWhite } from '../services/documents/photoPixels';

/** The stored photo is at most this tall: 2.4 cm wide on the page needs far less, and the PDF stays small. */
export const MAX_PHOTO_HEIGHT = 600;

/**
 * Resume photo encoder (D26): decodes a PNG or JPEG with Chromium's image decoder, scales it down, puts
 * transparent pixels on white (JPEG has no alpha) and encodes a JPEG. Null when the bytes are not an image.
 */
export function encodePhoto(input: Buffer): Buffer | null {
  const img = nativeImage.createFromBuffer(input);
  if (img.isEmpty()) return null;
  const { height } = img.getSize();
  const scaled = height > MAX_PHOTO_HEIGHT ? img.resize({ height: MAX_PHOTO_HEIGHT, quality: 'best' }) : img;
  const size = scaled.getSize();
  const flat = nativeImage.createFromBitmap(flattenOnWhite(scaled.toBitmap()), size);
  return flat.toJPEG(90);
}
