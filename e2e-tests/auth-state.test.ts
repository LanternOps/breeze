import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import {
  hasRefreshCookie,
  REFRESH_COOKIE_NAME,
  snapshotAfterMountRefresh,
  trackRefreshes,
  workerStoragePath,
} from './auth-state';

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

describe('snapshotAfterMountRefresh (#9252)', () => {
  type Handler = (arg: any) => void;
  function fakePage() {
    const handlers = new Map<string, Handler[]>();
    return {
      on(event: string, h: Handler) {
        handlers.set(event, [...(handlers.get(event) ?? []), h]);
      },
      emit(event: string, arg: unknown) {
        for (const h of handlers.get(event) ?? []) h(arg);
      },
      waitForTimeout: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    };
  }
  const refreshReq = () => ({
    method: () => 'POST',
    url: () => 'http://x.test/api/v1/auth/refresh',
    failure: () => null,
  });

  it('waits for a refresh that has not started yet, and snapshots the rotated cookie', async () => {
    const page = fakePage();
    const tracker = trackRefreshes(page);
    let jti = 'pre-rotation';
    const ctx = { storageState: async () => ({ jti }) };
    const req = refreshReq();
    // The mount heartbeat starts late (after the old 2x150 ms idle polls would have passed).
    setTimeout(() => page.emit('request', req), 60);
    setTimeout(() => {
      jti = 'post-rotation';
      page.emit('requestfinished', req);
    }, 100);
    const snap = await snapshotAfterMountRefresh(ctx, page, tracker, { pollMs: 10, deadlineMs: 2000 });
    expect(snap.jti).toBe('post-rotation');
  });

  it('re-snapshots when a refresh starts while storageState() runs', async () => {
    const page = fakePage();
    const tracker = trackRefreshes(page);
    const first = refreshReq();
    page.emit('request', first);
    page.emit('requestfinished', first);
    let calls = 0;
    const ctx = {
      storageState: async () => {
        calls++;
        if (calls === 1) {
          const late = refreshReq();
          page.emit('request', late);
          setTimeout(() => page.emit('requestfinished', late), 30);
        }
        return { calls };
      },
    };
    const snap = await snapshotAfterMountRefresh(ctx, page, tracker, { pollMs: 10, deadlineMs: 2000 });
    expect(snap.calls).toBe(2);
  });

  it('fails with a clear message (no snapshot) when no refresh ever completes', async () => {
    const page = fakePage();
    const tracker = trackRefreshes(page);
    const ctx = { storageState: vi.fn(async () => ({})) };
    await expect(
      snapshotAfterMountRefresh(ctx, page, tracker, { pollMs: 5, deadlineMs: 50 })
    ).rejects.toThrow(/mount heartbeat never completed/);
    expect(ctx.storageState).not.toHaveBeenCalled();
  });

  it('refuses to snapshot after a failed refresh', async () => {
    const page = fakePage();
    const tracker = trackRefreshes(page);
    const req = refreshReq();
    page.emit('request', req);
    page.emit('response', { request: () => req, status: () => 401 });
    page.emit('requestfinished', req);
    await expect(
      snapshotAfterMountRefresh({ storageState: async () => ({}) }, page, tracker, { pollMs: 5 })
    ).rejects.toThrow(/HTTP 401/);
  });

  it('requestfailed clears in-flight and is reported as a failure', async () => {
    const page = fakePage();
    const tracker = trackRefreshes(page);
    const req = { ...refreshReq(), failure: () => ({ errorText: 'net::ERR_ABORTED' }) };
    page.emit('request', req);
    page.emit('requestfailed', req);
    expect(tracker.inflight).toBe(0);
    await expect(
      snapshotAfterMountRefresh({ storageState: async () => ({}) }, page, tracker, { pollMs: 5 })
    ).rejects.toThrow(/request failed: net::ERR_ABORTED/);
  });

  it('reports a refresh still in flight at the deadline without snapshotting', async () => {
    const page = fakePage();
    const tracker = trackRefreshes(page);
    page.emit('request', refreshReq());
    const ctx = { storageState: vi.fn(async () => ({})) };
    await expect(
      snapshotAfterMountRefresh(ctx, page, tracker, { pollMs: 5, deadlineMs: 50 })
    ).rejects.toThrow(/1 still in flight/);
    expect(ctx.storageState).not.toHaveBeenCalled();
  });

  it('re-snapshots when a refresh starts AND finishes inside storageState()', async () => {
    const page = fakePage();
    const tracker = trackRefreshes(page);
    const first = refreshReq();
    page.emit('request', first);
    page.emit('requestfinished', first);
    let calls = 0;
    const ctx = {
      storageState: async () => {
        calls++;
        if (calls === 1) {
          const late = refreshReq();
          page.emit('request', late);
          page.emit('requestfinished', late);
        }
        return { calls };
      },
    };
    const snap = await snapshotAfterMountRefresh(ctx, page, tracker, { pollMs: 5 });
    expect(snap.calls).toBe(2);
  });

  it('ignores non-refresh requests', () => {
    const page = fakePage();
    const tracker = trackRefreshes(page);
    const get = { method: () => 'GET', url: () => 'http://x.test/api/v1/auth/refresh', failure: () => null };
    const login = { method: () => 'POST', url: () => 'http://x.test/api/v1/auth/login', failure: () => null };
    page.emit('request', get);
    page.emit('request', login);
    page.emit('response', { request: () => login, status: () => 500 });
    expect(tracker.starts).toBe(0);
    expect(tracker.failures).toEqual([]);
  });
});
