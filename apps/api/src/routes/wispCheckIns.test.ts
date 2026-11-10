/**
 * Wisp check-in timers W05 (#10996) Task 11 — GET/DELETE
 * /wisp/thread/:id/check-ins. The hub gates (flag, partner scope,
 * ai_sessions:use, entitlement) are W02's and covered by wisp.test.ts; this
 * file pins ownership, the grant-keyed service calls, the DTO and the audit.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const h = vi.hoisted(() => ({
  loadOwnThread: vi.fn(),
  listCheckIns: vi.fn(),
  cancelCheckIn: vi.fn(),
  writeRouteAudit: vi.fn(),
}));

vi.mock('./wispThreads', () => ({ loadOwnThread: h.loadOwnThread }));
vi.mock('../services/wisp/checkIns', () => ({
  listCheckIns: h.listCheckIns,
  cancelCheckIn: h.cancelCheckIn,
  // The real mapper is pure; this stand-in proves the route maps every row through it.
  toCheckInDto: (row: { id: string; status: string }) => ({ dto: true, id: row.id, status: row.status }),
}));
vi.mock('../services/auditEvents', () => ({ writeRouteAudit: h.writeRouteAudit }));

const { wispCheckInRoutes } = await import('./wispCheckIns');

const PARTNER = '11111111-1111-4111-8111-111111111111';
const THREAD = '22222222-2222-4222-8222-222222222222';
const CHECK_IN = '33333333-3333-4333-8333-333333333333';
const GRANT = '44444444-4444-4444-8444-444444444444';
const ORG = '55555555-5555-4555-8555-555555555555';
const auth = { user: { id: 'u1' }, partnerId: PARTNER, scope: 'partner' };
const own = { thread: { id: THREAD, partnerId: PARTNER, grantId: GRANT }, grant: { id: GRANT, status: 'active' } };
const row = (id: string, status: string, orgId: string | null = ORG) => ({ id, status, orgId, threadId: THREAD, grantId: GRANT });

function app() {
  const a = new Hono();
  a.use('*', async (c, next) => { c.set('auth' as never, auth as never); await next(); });
  a.route('/thread', wispCheckInRoutes);
  return a;
}
const req = (method: string, path: string) => app().request(path, { method });

beforeEach(() => {
  vi.clearAllMocks();
  h.loadOwnThread.mockResolvedValue(own);
  h.listCheckIns.mockResolvedValue([]);
  h.cancelCheckIn.mockResolvedValue(null);
});

describe('GET /thread/:id/check-ins', () => {
  it('returns the grant\'s scheduled and fired check-ins as DTOs, at most 50', async () => {
    h.listCheckIns.mockResolvedValue([row('c1', 'scheduled'), row('c2', 'fired')]);
    const res = await req('GET', `/thread/${THREAD}/check-ins`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: { checkIns: [{ dto: true, id: 'c1', status: 'scheduled' }, { dto: true, id: 'c2', status: 'fired' }] },
    });
    expect(h.listCheckIns).toHaveBeenCalledWith(GRANT, { limit: 50 });
  });

  it('another user\'s thread (or a bad thread id) is the same existence-neutral 404', async () => {
    h.loadOwnThread.mockResolvedValue(null);
    const res = await req('GET', `/thread/${THREAD}/check-ins`);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'not_found' });
    expect(h.listCheckIns).not.toHaveBeenCalled();
  });

  it('works while the grant is paused (ownership only, no ceiling)', async () => {
    h.loadOwnThread.mockResolvedValue({ ...own, grant: { ...own.grant, status: 'paused' } });
    h.listCheckIns.mockResolvedValue([row('c1', 'scheduled')]);
    expect((await req('GET', `/thread/${THREAD}/check-ins`)).status).toBe(200);
  });
});

describe('DELETE /thread/:id/check-ins/:checkInId', () => {
  it('cancels through the grant-keyed service, audits and returns 204', async () => {
    h.cancelCheckIn.mockResolvedValue(row(CHECK_IN, 'cancelled'));
    const res = await req('DELETE', `/thread/${THREAD}/check-ins/${CHECK_IN}`);
    expect(res.status).toBe(204);
    expect(h.cancelCheckIn).toHaveBeenCalledWith(GRANT, CHECK_IN);
    expect(h.writeRouteAudit).toHaveBeenCalledTimes(1);
    expect(h.writeRouteAudit).toHaveBeenCalledWith(expect.anything(), {
      orgId: ORG,
      partnerId: PARTNER,
      action: 'wisp.thread.check_in_cancelled',
      resourceType: 'wisp_thread',
      resourceId: THREAD,
      details: { threadId: THREAD, checkInId: CHECK_IN },
    });
  });

  it('a partner-level check-in audits with a null org', async () => {
    h.cancelCheckIn.mockResolvedValue(row(CHECK_IN, 'cancelled', null));
    expect((await req('DELETE', `/thread/${THREAD}/check-ins/${CHECK_IN}`)).status).toBe(204);
    expect(h.writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ orgId: null }));
  });

  it('a consumed, cancelled, missing or other grant\'s check-in is 404; nothing audited', async () => {
    h.cancelCheckIn.mockResolvedValue(null);
    const res = await req('DELETE', `/thread/${THREAD}/check-ins/${CHECK_IN}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'not_found' });
    expect(h.writeRouteAudit).not.toHaveBeenCalled();
  });

  it('a malformed check-in id is 404 before any ownership read or cancel', async () => {
    const res = await req('DELETE', `/thread/${THREAD}/check-ins/not-a-uuid`);
    expect(res.status).toBe(404);
    expect(h.cancelCheckIn).not.toHaveBeenCalled();
    expect(h.loadOwnThread).not.toHaveBeenCalled();
  });

  it('another user\'s thread is 404 and cancels nothing', async () => {
    h.loadOwnThread.mockResolvedValue(null);
    const res = await req('DELETE', `/thread/${THREAD}/check-ins/${CHECK_IN}`);
    expect(res.status).toBe(404);
    expect(h.cancelCheckIn).not.toHaveBeenCalled();
    expect(h.writeRouteAudit).not.toHaveBeenCalled();
  });

  it('works while the grant is paused: a person can always drop their own reminder', async () => {
    h.loadOwnThread.mockResolvedValue({ ...own, grant: { ...own.grant, status: 'paused' } });
    h.cancelCheckIn.mockResolvedValue(row(CHECK_IN, 'cancelled'));
    expect((await req('DELETE', `/thread/${THREAD}/check-ins/${CHECK_IN}`)).status).toBe(204);
  });
});
