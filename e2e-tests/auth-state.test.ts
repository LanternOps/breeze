import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { hasRefreshCookie, REFRESH_COOKIE_NAME, workerStoragePath } from './auth-state';

describe('workerStoragePath', () => {
  it('gives every parallel worker its own storageState file under .auth/', () => {
    const a = workerStoragePath(0);
    const b = workerStoragePath(3);
    expect(path.basename(path.dirname(a))).toBe('.auth');
    expect(path.basename(a)).toBe('worker-0.json');
    expect(path.basename(b)).toBe('worker-3.json');
    expect(a).not.toBe(b);
  });
});

describe('hasRefreshCookie', () => {
  it('is true only when the API refresh cookie is present and non-empty', () => {
    expect(hasRefreshCookie({ cookies: [{ name: REFRESH_COOKIE_NAME, value: 'jwt' }] })).toBe(true);
    expect(hasRefreshCookie({ cookies: [{ name: REFRESH_COOKIE_NAME, value: '' }] })).toBe(false);
    expect(hasRefreshCookie({ cookies: [{ name: 'other', value: 'x' }] })).toBe(false);
    expect(hasRefreshCookie({ cookies: [] })).toBe(false);
    expect(hasRefreshCookie({})).toBe(false);
  });
});
