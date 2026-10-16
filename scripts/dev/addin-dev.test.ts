// Picked up by the existing root script: test:dev-scripts (vitest over scripts/dev).
import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error - plain .mjs helper, deliberately untyped (it must run under bare node from a
// nested package, where tsx is not on PATH).
import { addinDevSkipReason, runAddinDev } from './addin-dev.mjs';

describe('addin-dev guard (#8375)', () => {
  it('skips on linux with a reason', () => {
    expect(addinDevSkipReason('linux')).toMatch(/office-addin-dev-certs/);
  });

  it('does not skip on win32 or darwin', () => {
    expect(addinDevSkipReason('win32')).toBeNull();
    expect(addinDevSkipReason('darwin')).toBeNull();
  });

  it('returns 0 and logs instead of starting vite on linux', () => {
    const log = vi.fn();
    expect(runAddinDev({ platform: 'linux', log })).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[addin-dev] skipped'));
  });
});
