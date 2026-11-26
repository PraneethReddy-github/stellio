import { readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { UserError } from '../../ipc/dispatch';
import { writeFileAtomic } from '../datafolder/files';
import { commitFiles } from '../datafolder/git';

/** The resume photo (D26): one per data folder, always a JPEG the app wrote itself. */
export const PHOTO_FILE = 'templates/photo.jpg';
/** A picked file above this is refused before it is decoded. */
export const MAX_PHOTO_INPUT_BYTES = 15 * 1024 * 1024;

/**
 * Decodes a PNG or JPEG and re-encodes it as a small JPEG (main wires Electron's nativeImage). Null when the
 * bytes do not decode as an image.
 */
export type PhotoEncoder = (input: Buffer) => Buffer | null;

/** Larger pictures are refused before decoding: a small file can unpack to gigabytes of pixels. */
export const MAX_PHOTO_PIXELS_SIDE = 8000;

/** Width and height from a PNG IHDR or a JPEG SOF header, without decoding; null when not found. */
export function imageSize(b: Buffer): { width: number; height: number } | null {
  if (isPng(b)) return b.length >= 24 ? { width: b.readUInt32BE(16), height: b.readUInt32BE(20) } : null;
  if (!isJpeg(b)) return null;
  for (let i = 2; i + 9 < b.length;) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1] ?? 0;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      i += 2;
      continue;
    }
    const len = b.readUInt16BE(i + 2);
    // SOF0-15 except DHT (C4), JPG (C8) and DAC (CC)
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
}

const isPng = (b: Buffer): boolean => b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
const isJpeg = (b: Buffer): boolean => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

export interface PhotoServiceDeps {
  dataDir: string;
  gitAvailable: boolean;
  encode: PhotoEncoder;
}

export function createPhotoService({ dataDir, gitAvailable, encode }: PhotoServiceDeps) {
  const abs = join(dataDir, PHOTO_FILE);
  const commit = async (message: string): Promise<void> => {
    if (gitAvailable) await commitFiles(dataDir, [PHOTO_FILE], message);
  };

  async function read(): Promise<Buffer | null> {
    return readFile(abs).catch(() => null);
  }

  /** For the Profile screen: whether a photo is set, and a data URL to show it. */
  async function get(): Promise<{ present: boolean; dataUrl: string | null }> {
    const b = await read();
    return b
      ? { present: true, dataUrl: `data:image/jpeg;base64,${b.toString('base64')}` }
      : { present: false, dataUrl: null };
  }

  return {
    read,
    get,

    /** Validates a picked file (size, PNG/JPEG signature, decodes), stores it re-encoded, commits it. */
    async setFromFile(path: string): Promise<{ present: boolean; dataUrl: string | null }> {
      const st = await stat(path).catch(() => null);
      if (!st?.isFile()) throw new UserError('That file could not be read.');
      if (st.size > MAX_PHOTO_INPUT_BYTES)
        throw new UserError('The photo is over 15 MB. Pick a smaller image.');
      const input = await readFile(path);
      if (!isPng(input) && !isJpeg(input)) throw new UserError('Pick a PNG or JPEG image.');
      const size = imageSize(input);
      if (!size) throw new UserError('That image could not be read. Pick another PNG or JPEG.');
      if (size.width > MAX_PHOTO_PIXELS_SIDE || size.height > MAX_PHOTO_PIXELS_SIDE)
        throw new UserError(
          `The photo is over ${String(MAX_PHOTO_PIXELS_SIDE)} pixels on a side. Pick a smaller image.`,
        );
      const out = encode(input);
      if (!out || !isJpeg(out))
        throw new UserError('That image could not be read. Pick another PNG or JPEG.');
      // D20: a photo being replaced is in git already (it was committed when it was set).
      await writeFileAtomic(abs, out);
      await commit('photo: set resume photo');
      return get();
    },

    async clear(): Promise<{ present: boolean; dataUrl: string | null }> {
      await rm(abs, { force: true });
      await commit('photo: remove resume photo');
      return { present: false, dataUrl: null };
    },
  };
}
export type PhotoService = ReturnType<typeof createPhotoService>;
