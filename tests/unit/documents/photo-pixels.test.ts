import { describe, expect, it } from 'vitest';
import { flattenOnWhite } from '../../../src/main/services/documents/photoPixels';

describe('flattenOnWhite', () => {
  it('keeps opaque pixels, turns transparent ones white and makes every pixel opaque', () => {
    const px = Buffer.from([10, 20, 30, 255, 0, 0, 0, 0, 64, 64, 64, 128]);
    const out = flattenOnWhite(px);
    expect([...out.subarray(0, 4)]).toEqual([10, 20, 30, 255]);
    expect([...out.subarray(4, 8)]).toEqual([255, 255, 255, 255]);
    expect([...out.subarray(8, 12)]).toEqual([191, 191, 191, 255]); // premultiplied 64 + 255 × (1 − 128/255)
    expect([...px.subarray(4, 8)]).toEqual([0, 0, 0, 0]); // input unchanged
  });
});
