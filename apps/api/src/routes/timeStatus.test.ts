import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
const m = vi.hoisted(() => ({
  authorized: true,
  permitted: true,
  list: vi.fn(),
  current: vi.fn(),
  history: vi.fn(),
  context: vi.fn(),
  org: '11111111-1111-4111-8111-111111111111',
}));
vi.mock('../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    // The real middleware throws; the route's onError must not swallow it.
    if (!m.authorized) throw new HTTPException(401, { message: 'Unauthorized' });
    c.set('auth', {
      scope: 'organization',
      orgId: m.org,
      orgCondition: () => undefined,
      canAccessOrg: (id: string) => id === m.org,
    });
    await next();
  },
  requireScope: () => async (_c: any, next: any) => next(),
  requirePermission: () => async (_c: any, next: any) => {
    if (!m.permitted) throw new HTTPException(403, { message: 'Forbidden' });
    await next();
  },
}));
vi.mock('../db', () => ({
  db: { select: vi.fn() },
  getCurrentDbAccessContext: () => ({ scope: 'organization', orgId: m.org }),
  runOutsideDbContext: (fn: any) => fn(),
  withDbAccessContext: m.context,
}));
vi.mock('../services/timeSync/fleet', async (original) => ({
  ...(await original<typeof import('../services/timeSync/fleet')>()),
  listFleetTimeStatus: m.list,
}));
vi.mock('../services/timeSync/exports', async (original) => ({
  ...(await original<typeof import('../services/timeSync/exports')>()),
  exportCurrentTimeCsv: m.current,
  exportHistoryTimeCsv: m.history,
}));
import { timeStatusRoutes } from './timeStatus';
const app = new Hono().route('/time-status', timeStatusRoutes);
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-28T12:00:00Z'));
  m.authorized = true;
  m.permitted = true;
  m.list
    .mockReset()
    .mockResolvedValue({ data: [], total: 0, page: 1, limit: 50, domains: [] });
  m.context
    .mockReset()
    .mockImplementation(async (_context: any, fn: any) => fn());
  m.current.mockReset().mockImplementation(async function* () {
    yield 'current\r\n';
  });
  m.history.mockReset().mockImplementation(async function* () {
    yield 'history\r\n';
  });
});
afterEach(() => vi.useRealTimers());
it('requires authentication and device read for all three routes', async () => {
  for (const path of [
    '/time-status',
    '/time-status/export',
    '/time-status/history/export?from=2026-09-28&to=2026-09-28',
  ]) {
    m.authorized = false;
    expect((await app.request(path)).status).toBe(401);
    m.authorized = true;
    m.permitted = false;
    expect((await app.request(path)).status).toBe(403);
    m.permitted = true;
  }
  expect(m.list).not.toHaveBeenCalled();
  expect(m.current).not.toHaveBeenCalled();
  expect(m.history).not.toHaveBeenCalled();
});
it('returns a paginated result and rejects invalid filters', async () => {
  expect(
    (
      await app.request(
        '/time-status?finding=sync_stale&role=member&page=2&limit=10',
      )
    ).status,
  ).toBe(200);
  expect(m.list.mock.calls[0]![0]).toMatchObject({
    finding: 'sync_stale',
    role: 'member',
    page: 2,
    limit: 10,
  });
  expect(m.list.mock.calls[0]![1]).toMatchObject({
    scope: 'organization',
    orgId: m.org,
  });
  for (const query of [
    'limit=101',
    'page=0',
    'finding=bad',
    'orgId=invalid',
    'role=bad',
  ])
    expect((await app.request(`/time-status?${query}`)).status).toBe(400);
});
it('denies foreign organization exports before creating the iterator', async () => {
  expect(
    (
      await app.request(
        '/time-status/export?orgId=22222222-2222-4222-8222-222222222222',
      )
    ).status,
  ).toBe(403);
  expect(m.current).not.toHaveBeenCalled();
});
it('streams both exports inside fresh caller contexts', async () => {
  for (const [path, text, file] of [
    ['/time-status/export', 'current\r\n', 'time-status.csv'],
    [
      '/time-status/history/export?from=2026-09-27&to=2026-09-28',
      'history\r\n',
      'time-status-history.csv',
    ],
  ]) {
    const response = await app.request(path!);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/csv');
    expect(response.headers.get('Content-Disposition')).toContain(file!);
    expect(await response.text()).toBe(text);
  }
  expect(m.context).toHaveBeenCalled();
  for (const [context] of m.context.mock.calls)
    expect(context).toEqual({ scope: 'organization', orgId: m.org });
});
it('rejects missing dates and overlong/future ranges', async () => {
  for (const query of [
    '',
    '?from=2026-09-28',
    '?from=2025-08-24&to=2026-09-28',
    '?from=2026-09-29&to=2026-09-29',
  ])
    expect(
      (await app.request(`/time-status/history/export${query}`)).status,
    ).toBe(400);
  expect(m.history).not.toHaveBeenCalled();
});
it('surfaces a service error as HTTP 500', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  m.list.mockRejectedValueOnce(new Error('database unavailable'));
  const response = await app.request('/time-status');
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({
    error: 'Failed to read time synchronization data',
  });
  log.mockRestore();
});
