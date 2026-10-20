import { afterEach, describe, expect, it } from 'vitest';

import { readSortFromHash, writeSortToHash } from './deviceListSort';

afterEach(() => history.replaceState(null, '', '/'));

describe('deviceListSort (#9037)', () => {
  it('reads a valid column and direction', () => {
    expect(readSortFromHash('#deviceClass=agent&sort=cpu.desc')).toEqual({ field: 'cpu', direction: 'desc' });
  });

  it.each(['', '#sort=', '#sort=cpu', '#sort=cpu.sideways', '#sort=nope.asc'])('returns null for %j', (hash) => {
    expect(readSortFromHash(hash)).toBeNull();
  });

  it('returns null instead of throwing on a malformed %-sequence', () => {
    expect(() => readSortFromHash('#sort=%E0%A4%A')).not.toThrow();
    expect(readSortFromHash('#sort=%E0%A4%A')).toBeNull();
  });

  it('writes its key and preserves the others', () => {
    history.replaceState(null, '', '/devices#deviceClass=all');
    writeSortToHash({ field: 'ram', direction: 'asc' });
    expect(window.location.hash).toBe('#deviceClass=all&sort=ram.asc');
    writeSortToHash(null);
    expect(window.location.hash).toBe('#deviceClass=all');
  });
});
