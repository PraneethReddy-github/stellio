import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { initDataFolder } from '../../../src/main/services/datafolder/init';
import { log } from '../../../src/main/services/datafolder/git';
import { createPhotoService, imageSize, PHOTO_FILE } from '../../../src/main/services/documents/photo';
import { SEED_DIR, isolateGit, useTempDirs } from './helpers';

isolateGit();
const tmp = useTempDirs();
const JPEG = 'tests/fixtures/latex/photo.jpg';
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]);

async function setup(encode = vi.fn((b: Buffer): Buffer | null => b)) {
  const d = join(await tmp(), 'Stellio');
  await initDataFolder(d, SEED_DIR);
  return { d, encode, photo: createPhotoService({ dataDir: d, gitAvailable: true, encode }) };
}

describe('photo service (D26)', () => {
  it('stores the re-encoded picture as templates/photo.jpg, commits it, and shows it as a data URL', async () => {
    const { d, photo, encode } = await setup();
    expect(await photo.get()).toEqual({ present: false, dataUrl: null });
    const r = await photo.setFromFile(JPEG);
    expect(encode).toHaveBeenCalledOnce();
    expect(r.present).toBe(true);
    expect(r.dataUrl).toMatch(/^data:image\/jpeg;base64,\/9j\//);
    expect(await readFile(join(d, PHOTO_FILE))).toEqual(await readFile(JPEG));
    expect((await log(d, { limit: 1 }))[0]?.message).toBe('photo: set resume photo');
    await photo.clear();
    expect(existsSync(join(d, PHOTO_FILE))).toBe(false);
    expect(await photo.read()).toBeNull();
    expect((await log(d, { limit: 1 }))[0]?.message).toBe('photo: remove resume photo');
  });

  it('refuses anything that is not a PNG or JPEG before decoding it', async () => {
    const { d, photo, encode } = await setup();
    const txt = join(d, 'notes.txt');
    await writeFile(txt, 'hello');
    await expect(photo.setFromFile(txt)).rejects.toThrow('Pick a PNG or JPEG image.');
    await expect(photo.setFromFile(join(d, 'missing.png'))).rejects.toThrow(/could not be read/);
    expect(encode).not.toHaveBeenCalled();
  });

  it('refuses a file that does not decode, and one over 15 MB', async () => {
    const { d, photo } = await setup(vi.fn(() => null));
    const png = join(d, 'broken.png');
    await writeFile(png, PNG);
    await expect(photo.setFromFile(png)).rejects.toThrow(/could not be read/);
    const big = join(d, 'big.jpg');
    await writeFile(big, Buffer.alloc(15 * 1024 * 1024 + 1, 0xff));
    await expect(photo.setFromFile(big)).rejects.toThrow(/over 15 MB/);
    expect(existsSync(join(d, PHOTO_FILE))).toBe(false);
  });

  it('refuses an encoder result that is not a JPEG', async () => {
    const { photo } = await setup(vi.fn(() => PNG));
    await expect(photo.setFromFile(JPEG)).rejects.toThrow(/could not be read/);
  });
});

describe('imageSize (review finding: refuse huge pictures before decoding)', () => {
  it('reads PNG and JPEG sizes from their headers', async () => {
    expect(imageSize(await readFile(JPEG))).toEqual({ width: 120, height: 140 });
    expect(imageSize(await readFile('tests/fixtures/latex/photo.png'))).toEqual({ width: 300, height: 360 });
    expect(imageSize(Buffer.from('hello'))).toBeNull();
  });

  it('refuses a picture over 8000 pixels on a side without decoding it', async () => {
    const { d, photo, encode } = await setup();
    const big = Buffer.alloc(33);
    PNG.copy(big);
    big.writeUInt32BE(9000, 16);
    big.writeUInt32BE(10, 20);
    await writeFile(join(d, 'huge.png'), big);
    await expect(photo.setFromFile(join(d, 'huge.png'))).rejects.toThrow(/over 8000 pixels/);
    expect(encode).not.toHaveBeenCalled();
  });
});
