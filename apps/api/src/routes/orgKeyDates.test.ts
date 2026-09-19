import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    if (!c.req.header('authorization')) return c.json({ error: 'Unauthorized' }, 401);
    c.set('auth', { user: { id: 'u1' }, partnerId: 'p1', accessibleOrgIds: ['org1'], scope: 'partner' });
    c.set('permissions', { permissions: [{ resource: 'contracts', action: 'read' }] });
    return next();
  },
  requireScope: () => async (_c: any, next: any) => next(),
  requirePermission: () => async (c: any, next: any) =>
    c.req.header('x-allow') === 'true' ? next() : c.json({ error: 'Forbidden' }, 403),
}));

const serviceMocks = vi.hoisted(() => ({
  listKeyDates: vi.fn(),
  createKeyDate: vi.fn(),
  updateKeyDate: vi.fn(),
  deleteKeyDate: vi.fn(),
}));
vi.mock('../services/orgKeyDateService', () => serviceMocks);
vi.mock('../services/serviceDeliverableService', () => ({
  // The router shares actor/error helpers with serviceDeliverables.ts, which imports every service name.
  listDeliverables: vi.fn(), getDeliverable: vi.fn(), createDeliverable: vi.fn(), updateDeliverable: vi.fn(), deactivateDeliverable: vi.fn(), listOccurrences: vi.fn(), deliverOccurrence: vi.fn(), waiveOccurrence: vi.fn(), reopenOccurrence: vi.fn(), rescheduleOccurrence: vi.fn(), addEvidence: vi.fn(), removeEvidence: vi.fn(),
  DeliverableServiceError: class DeliverableServiceError extends Error {
    constructor(msg: string, public status = 400, public code = 'ERR', public details?: unknown) { super(msg); }
  },
}));

import { authMiddleware } from '../middleware/auth';
import { orgKeyDateRoutes } from './orgKeyDates';

const { listKeyDates, createKeyDate, updateKeyDate, deleteKeyDate } = serviceMocks;

const ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const KD = '11111111-1111-4111-8111-111111111111';
const NO_PERM = { authorization: 'Bearer token' };
const AUTH = { authorization: 'Bearer token', 'x-allow': 'true' };
const JSON_AUTH = { ...AUTH, 'content-type': 'application/json' };
const ACTOR = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] };

const app = new Hono();
app.use('*', authMiddleware);
app.route('/', orgKeyDateRoutes);

describe('org key date routes (#5573 W01)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listKeyDates.mockResolvedValue([{ id: KD, source: 'key_date' }]);
    createKeyDate.mockResolvedValue({ id: KD, label: 'Cyber insurance renewal' });
    updateKeyDate.mockResolvedValue({ id: KD, label: 'Renamed' });
    deleteKeyDate.mockResolvedValue(undefined);
  });

  it('401 unauthenticated', async () =>
    expect((await app.request(`/${ORG}/key-dates`)).status).toBe(401));

  it('403 without permission', async () =>
    expect((await app.request(`/${ORG}/key-dates`, { headers: NO_PERM })).status).toBe(403));

  it('GET → 200 { data } with actor', async () => {
    const res = await app.request(`/${ORG}/key-dates`, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [{ id: KD, source: 'key_date' }] });
    expect(listKeyDates).toHaveBeenCalledWith(ORG, ACTOR, expect.anything());
  });

  it('404 when the service reports NOT_FOUND', async () => {
    listKeyDates.mockRejectedValueOnce({ status: 404, code: 'NOT_FOUND', message: 'Not found' });
    const res = await app.request(`/${ORG}/key-dates`, { headers: AUTH });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found', code: 'NOT_FOUND' });
  });

  it('POST → 200 { data } with defaults applied', async () => {
    const res = await app.request(`/${ORG}/key-dates`, {
      method: 'POST', headers: JSON_AUTH, body: JSON.stringify({ label: 'Cyber insurance renewal', date: '2027-03-01' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { id: KD, label: 'Cyber insurance renewal' } });
    expect(createKeyDate).toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({ label: 'Cyber insurance renewal', date: '2027-03-01', kind: 'other', recursAnnually: false }),
      ACTOR,
    );
  });

  it('POST → 400 without a label or with a non-ISO date', async () => {
    const bad = async (body: unknown) =>
      (await app.request(`/${ORG}/key-dates`, { method: 'POST', headers: JSON_AUTH, body: JSON.stringify(body) })).status;
    expect(await bad({ date: '2027-03-01' })).toBe(400);
    expect(await bad({ label: 'x', date: '01/03/2027' })).toBe(400);
    expect(createKeyDate).not.toHaveBeenCalled();
  });

  it('PATCH → 200 { data }; 400 on unknown field (strict)', async () => {
    const res = await app.request(`/${ORG}/key-dates/${KD}`, {
      method: 'PATCH', headers: JSON_AUTH, body: JSON.stringify({ label: 'Renamed' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { id: KD, label: 'Renamed' } });
    expect(updateKeyDate).toHaveBeenCalledWith(ORG, KD, { label: 'Renamed' }, ACTOR);
    const strict = await app.request(`/${ORG}/key-dates/${KD}`, {
      method: 'PATCH', headers: JSON_AUTH, body: JSON.stringify({ bogus: 1 }),
    });
    expect(strict.status).toBe(400);
  });

  it('DELETE → { data: { ok: true } }', async () => {
    const res = await app.request(`/${ORG}/key-dates/${KD}`, { method: 'DELETE', headers: AUTH });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { ok: true } });
    expect(deleteKeyDate).toHaveBeenCalledWith(ORG, KD, ACTOR);
  });

  it('409 mapping for an INVALID_OCCURRENCE_TRANSITION-shaped error', async () => {
    updateKeyDate.mockRejectedValueOnce({ status: 409, code: 'INVALID_OCCURRENCE_TRANSITION', message: 'nope' });
    const res = await app.request(`/${ORG}/key-dates/${KD}`, {
      method: 'PATCH', headers: JSON_AUTH, body: JSON.stringify({ label: 'x' }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'nope', code: 'INVALID_OCCURRENCE_TRANSITION' });
  });

  it('400 for a non-guid org or key-date id', async () => {
    expect((await app.request(`/bad/key-dates`, { headers: AUTH })).status).toBe(400);
    expect((await app.request(`/${ORG}/key-dates/bad`, { method: 'DELETE', headers: AUTH })).status).toBe(400);
  });
});
