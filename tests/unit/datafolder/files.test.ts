import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hashText, writeFileAtomic } from '../../../src/main/services/datafolder/files';
import { useTempDirs } from './helpers';

const tmp = useTempDirs();

describe('hashText', () => {
  it('ignores CRLF and trailing whitespace per line', () => {
    expect(hashText('a  \r\nb\t\r\n')).toBe(hashText('a\nb\n'));
  });
  it('differs for different content', () => {
    expect(hashText('a')).not.toBe(hashText('b'));
  });
});

describe('writeFileAtomic', () => {
  it('writes content, creates parents, leaves no temp files', async () => {
    const d = await tmp();
    const f = join(d, 'x', 'y.md');
    await writeFileAtomic(f, 'hello');
    await writeFileAtomic(f, 'hello 2');
    expect(await readFile(f, 'utf8')).toBe('hello 2');
    expect(await readdir(join(d, 'x'))).toEqual(['y.md']);
  });
});
