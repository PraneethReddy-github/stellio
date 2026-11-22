import { describe, expect, it } from 'vitest';
import { barSlot } from '../../../src/renderer/src/ui/Bars';

describe('barSlot', () => {
  it('keeps the minimum pitch for short labels', () => {
    expect(barSlot(['W41', 'W42'])).toBe(44);
    expect(barSlot([])).toBe(44);
  });
  it('widens the pitch so the longest label never reaches its neighbour', () => {
    expect(barSlot(['saved', 'interview'])).toBe(9 * 7 + 8);
  });
});
