import { afterEach, describe, expect, it, vi } from 'vitest';
import { breezeRole } from './env';

describe('breezeRole()', () => {
  const original = process.env.BREEZE_ROLE;
  afterEach(() => {
    if (original === undefined) delete process.env.BREEZE_ROLE;
    else process.env.BREEZE_ROLE = original;
    vi.restoreAllMocks();
  });

  it.each([
    [undefined, 'all'],
    ['', 'all'],
    ['all', 'all'],
    ['api', 'api'],
    ['worker', 'worker'],
    ['API', 'api'],
    ['  worker  ', 'worker'],
  ])('BREEZE_ROLE=%s → %s', (raw, expected) => {
    if (raw === undefined) delete process.env.BREEZE_ROLE;
    else process.env.BREEZE_ROLE = raw;
    expect(breezeRole()).toBe(expected);
  });

  it('unknown value warns and falls back to all', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.BREEZE_ROLE = 'banana';
    expect(breezeRole()).toBe('all');
    expect(warn).toHaveBeenCalledOnce();
  });
});
