import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbMocks = vi.hoisted(() => ({
  tx: { marker: 'system-tx' },
  transaction: vi.fn(),
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db', () => ({
  db: { transaction: dbMocks.transaction },
  runOutsideDbContext: dbMocks.runOutsideDbContext,
  withSystemDbAccessContext: dbMocks.withSystemDbAccessContext,
}));

const capacity = vi.hoisted(() => ({ partnerAdmissionStatus: vi.fn() }));

vi.mock('../services/partnerDeviceCapacity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/partnerDeviceCapacity')>()),
  partnerAdmissionStatus: capacity.partnerAdmissionStatus,
}));

// The real scope/partner gates; only token verification is stubbed out (the
// test injects `auth` itself).
vi.mock('../middleware/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../middleware/auth')>()),
  authMiddleware: vi.fn(async (_c: unknown, next: () => Promise<void>) => next()),
}));

import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { partnerDeviceCapacityRoutes } from './partnerDeviceCapacity';
import { PartnerDeviceCapacityError } from '../services/partnerDeviceCapacity';

const PARTNER_ID = '22222222-2222-4222-8222-222222222222';

const partnerAuth = {
  principal: { kind: 'user_session' },
  scope: 'partner',
  partnerId: PARTNER_ID,
  partnerOrgAccess: 'all',
  orgId: null,
  user: { id: '11111111-1111-4111-8111-111111111111', email: 'owner@breeze.test' },
};

function buildApp(auth: Record<string, unknown> | null) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (auth) c.set('auth', auth as never);
    await next();
  });
  app.route('/partner/device-capacity', partnerDeviceCapacityRoutes);
  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    return c.json({ error: 'internal' }, 500);
  });
  return app;
}

async function get(auth: Record<string, unknown> | null) {
  return buildApp(auth).request('/partner/device-capacity');
}

describe('GET /partner/device-capacity', () => {
  beforeEach(() => {
    capacity.partnerAdmissionStatus.mockReset();
    dbMocks.transaction.mockReset();
    dbMocks.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(dbMocks.tx));
    dbMocks.runOutsideDbContext.mockClear();
    dbMocks.withSystemDbAccessContext.mockClear();
  });

  it('org-scoped users get 403', async () => {
    const res = await get({ ...partnerAuth, scope: 'organization', orgId: '33333333-3333-4333-8333-333333333333' });
    expect(res.status).toBe(403);
    expect(capacity.partnerAdmissionStatus).not.toHaveBeenCalled();
  });

  it('a partner-scoped token with no partner id gets 403', async () => {
    const res = await get({ ...partnerAuth, partnerId: null });
    expect(res.status).toBe(403);
    expect(capacity.partnerAdmissionStatus).not.toHaveBeenCalled();
  });

  it('an unauthenticated request gets 401', async () => {
    const res = await get(null);
    expect(res.status).toBe(401);
    expect(capacity.partnerAdmissionStatus).not.toHaveBeenCalled();
  });

  it('returns enrollmentPaused when activeCount >= limit', async () => {
    capacity.partnerAdmissionStatus.mockResolvedValueOnce({ limit: 110, activeCount: 110 });
    const atLimit = await get(partnerAuth);
    expect(atLimit.status).toBe(200);
    expect(await atLimit.json()).toEqual({
      limit: 110, activeCount: 110, enrollmentPaused: true, paused: true, reason: 'device_limit',
    });

    capacity.partnerAdmissionStatus.mockResolvedValueOnce({ limit: 110, activeCount: 125 });
    const over = await get(partnerAuth);
    expect(await over.json()).toEqual({
      limit: 110, activeCount: 125, enrollmentPaused: true, paused: true, reason: 'device_limit',
    });
  });

  it('is not paused below the limit or when there is no limit', async () => {
    capacity.partnerAdmissionStatus.mockResolvedValueOnce({ limit: 110, activeCount: 109 });
    expect(await (await get(partnerAuth)).json()).toEqual({
      limit: 110, activeCount: 109, enrollmentPaused: false, paused: false, reason: null,
    });

    capacity.partnerAdmissionStatus.mockResolvedValueOnce({ limit: null, activeCount: 4000 });
    expect(await (await get(partnerAuth)).json()).toEqual({
      limit: null, activeCount: 4000, enrollmentPaused: false, paused: false, reason: null,
    });
  });

  it("reads only the caller's own partner, in system scope outside the request context", async () => {
    capacity.partnerAdmissionStatus.mockResolvedValueOnce({ limit: 10, activeCount: 1 });
    await get(partnerAuth);
    expect(capacity.partnerAdmissionStatus).toHaveBeenCalledTimes(1);
    expect(capacity.partnerAdmissionStatus).toHaveBeenCalledWith(dbMocks.tx, PARTNER_ID);
    expect(dbMocks.runOutsideDbContext).toHaveBeenCalledTimes(1);
    expect(dbMocks.withSystemDbAccessContext).toHaveBeenCalledTimes(1);
  });

  it('ignores a partnerId query parameter', async () => {
    capacity.partnerAdmissionStatus.mockResolvedValueOnce({ limit: 10, activeCount: 1 });
    await buildApp(partnerAuth).request('/partner/device-capacity?partnerId=44444444-4444-4444-8444-444444444444');
    expect(capacity.partnerAdmissionStatus).toHaveBeenCalledWith(dbMocks.tx, PARTNER_ID);
  });

  // Ruling T15: partner-wide counts only for full-partner access
  // (canManagePartnerWidePolicies); everyone else gets the reason alone.
  it.each([
    ['selected', 'selected'],
    ['none', 'none'],
    ['undefined (fails closed)', undefined],
    ['null (fails closed)', null],
  ])('a %s-access partner user gets the paused reason without counts', async (_label, access) => {
    capacity.partnerAdmissionStatus.mockResolvedValueOnce({ limit: 110, activeCount: 110 });
    const paused = await get({ ...partnerAuth, partnerOrgAccess: access });
    expect(paused.status).toBe(200);
    expect(await paused.json()).toEqual({ paused: true, reason: 'device_limit' });

    capacity.partnerAdmissionStatus.mockResolvedValueOnce({ limit: 110, activeCount: 12 });
    const open = await get({ ...partnerAuth, partnerOrgAccess: access });
    expect(await open.json()).toEqual({ paused: false, reason: null });
  });

  it('an all-access partner user gets the counts', async () => {
    capacity.partnerAdmissionStatus.mockResolvedValueOnce({ limit: 110, activeCount: 12 });
    const body = await (await get(partnerAuth)).json();
    expect(body).toMatchObject({ limit: 110, activeCount: 12 });
  });

  it('a missing partner row is 404', async () => {
    capacity.partnerAdmissionStatus.mockRejectedValueOnce(
      new PartnerDeviceCapacityError('PARTNER_NOT_FOUND', 'Partner not found'),
    );
    const res = await get(partnerAuth);
    expect(res.status).toBe(404);
  });
});
