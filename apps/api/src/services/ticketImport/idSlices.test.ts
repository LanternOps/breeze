import { describe, expect, it, vi } from 'vitest';
import { ID_SLICE, readInIdSlices } from './idSlices';

describe('readInIdSlices', () => {
  it('reads in order, at most 500 ids a statement, and concatenates the rows', async () => {
    const ids = Array.from({ length: 2 * ID_SLICE + 1 }, (_, i) => `id-${i}`);
    const read = vi.fn(async (slice: string[]) => [slice.length, slice[0]]);
    expect(await readInIdSlices(ids, read)).toEqual([500, 'id-0', 500, 'id-500', 1, 'id-1000']);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('runs no statement for no ids', async () => {
    const read = vi.fn(async () => [1]);
    expect(await readInIdSlices([], read)).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });
});
