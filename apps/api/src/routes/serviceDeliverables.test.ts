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
  listDeliverables: vi.fn(),
  getDeliverable: vi.fn(),
  createDeliverable: vi.fn(),
  updateDeliverable: vi.fn(),
  deactivateDeliverable: vi.fn(),
  listOccurrences: vi.fn(),
  deliverOccurrence: vi.fn(),
  waiveOccurrence: vi.fn(),
  reopenOccurrence: vi.fn(),
  rescheduleOccurrence: vi.fn(),
  addEvidence: vi.fn(),
  removeEvidence: vi.fn(),
}));
vi.mock('../services/serviceDeliverableService', () => ({
  ...serviceMocks,
  DeliverableServiceError: class DeliverableServiceError extends Error {
    constructor(msg: string, public status = 400, public code = 'ERR', public details?: unknown) { super(msg); }
  },
}));

const templateMocks = vi.hoisted(() => ({ applyTemplateSet: vi.fn() }));
vi.mock('../services/deliverableTemplateService', () => ({
  ...templateMocks,
  TemplateServiceError: class TemplateServiceError extends Error {
    constructor(msg: string, public status = 400, public code = 'ERR', public details?: unknown) { super(msg); }
  },
}));

import { authMiddleware } from '../middleware/auth';
import { serviceDeliverableRoutes } from './serviceDeliverables';

const {
  listDeliverables, getDeliverable, createDeliverable, updateDeliverable, deactivateDeliverable,
  listOccurrences, deliverOccurrence, waiveOccurrence, reopenOccurrence, rescheduleOccurrence,
  addEvidence, removeEvidence,
} = serviceMocks;

const ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DEL = '11111111-1111-4111-8111-111111111111';
const OCC = '22222222-2222-4222-8222-222222222222';
const EVID = '33333333-3333-4333-8333-333333333333';
const RUN = '44444444-4444-4444-8444-444444444444';
const NO_PERM = { authorization: 'Bearer token' };
const AUTH = { authorization: 'Bearer token', 'x-allow': 'true' };
const JSON_AUTH = { ...AUTH, 'content-type': 'application/json' };
const ACTOR = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: ['org1'] };
const post = (path: string, body: unknown) =>
  app.request(path, { method: 'POST', headers: JSON_AUTH, body: JSON.stringify(body) });

const app = new Hono();
app.use('*', authMiddleware);
app.route('/', serviceDeliverableRoutes);

const validCreate = {
  name: 'Quarterly review',
  cadence: 'quarterly',
  anchorDueDate: '2026-10-01',
  effectiveFrom: '2026-10-01',
};

describe('service deliverable routes (#5573 W01)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listDeliverables.mockResolvedValue([{ id: DEL }]);
    getDeliverable.mockResolvedValue({ id: DEL });
    createDeliverable.mockResolvedValue({ id: DEL, name: 'Quarterly review' });
    updateDeliverable.mockResolvedValue({ id: DEL, name: 'Renamed' });
    deactivateDeliverable.mockResolvedValue(undefined);
    listOccurrences.mockResolvedValue([{ id: OCC }]);
    for (const m of [deliverOccurrence, waiveOccurrence, reopenOccurrence, rescheduleOccurrence, addEvidence, removeEvidence]) {
      m.mockResolvedValue({ id: OCC, status: 'delivered' });
    }
  });

  it('401 unauthenticated', async () =>
    expect((await app.request(`/${ORG}/deliverables`)).status).toBe(401));

  it('403 without permission', async () =>
    expect((await app.request(`/${ORG}/deliverables`, { headers: NO_PERM })).status).toBe(403));

  it('GET list → 200 { data } and passes query + actor', async () => {
    const res = await app.request(`/${ORG}/deliverables?contractId=${DEL}&includeInactive=true`, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [{ id: DEL }] });
    expect(listDeliverables).toHaveBeenCalledWith(ORG, { contractId: DEL, includeInactive: true }, ACTOR);
  });

  it('GET one → 200 { data }', async () => {
    const res = await app.request(`/${ORG}/deliverables/${DEL}`, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { id: DEL } });
    expect(getDeliverable).toHaveBeenCalledWith(ORG, DEL, ACTOR);
  });

  it('404 when the service reports NOT_FOUND', async () => {
    getDeliverable.mockRejectedValueOnce({ status: 404, code: 'NOT_FOUND', message: 'Not found' });
    const res = await app.request(`/${ORG}/deliverables/${DEL}`, { headers: AUTH });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found', code: 'NOT_FOUND' });
  });

  it('POST create → 200 { data } with defaults applied', async () => {
    const res = await post(`/${ORG}/deliverables`, validCreate);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { id: DEL, name: 'Quarterly review' } });
    expect(createDeliverable).toHaveBeenCalledWith(
      ORG, expect.objectContaining({ name: 'Quarterly review', leadDays: 7, graceDays: 14 }), ACTOR,
    );
  });

  it('POST create → 400 when name is missing', async () => {
    const { name: _n, ...noName } = validCreate;
    expect((await post(`/${ORG}/deliverables`, noName)).status).toBe(400);
    expect(createDeliverable).not.toHaveBeenCalled();
  });

  it('PATCH → 200 { data }', async () => {
    const res = await app.request(`/${ORG}/deliverables/${DEL}`, {
      method: 'PATCH', headers: JSON_AUTH, body: JSON.stringify({ name: 'Renamed' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { id: DEL, name: 'Renamed' } });
    expect(updateDeliverable).toHaveBeenCalledWith(ORG, DEL, { name: 'Renamed' }, ACTOR);
  });

  it('DELETE → deactivates and returns { data: { ok: true } }', async () => {
    const res = await app.request(`/${ORG}/deliverables/${DEL}`, { method: 'DELETE', headers: AUTH });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { ok: true } });
    expect(deactivateDeliverable).toHaveBeenCalledWith(ORG, DEL, ACTOR);
  });

  it('GET occurrences → 200 with the default limit', async () => {
    const res = await app.request(`/${ORG}/deliverables/${DEL}/occurrences`, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [{ id: OCC }] });
    expect(listOccurrences).toHaveBeenCalledWith(ORG, DEL, { limit: 24 }, ACTOR);
  });

  it('POST deliver → 200 and passes the body', async () => {
    const body = { note: 'done', evidence: [{ kind: 'report_run', reportRunId: RUN }] };
    const res = await post(`/${ORG}/deliverables/occurrences/${OCC}/deliver`, body);
    expect(res.status).toBe(200);
    expect(deliverOccurrence).toHaveBeenCalledWith(ORG, OCC, body, ACTOR);
    // "occurrences" must not be captured as a deliverable :id
    expect(getDeliverable).not.toHaveBeenCalled();
  });

  it('POST deliver → 400 for a document evidence kind (W03 widens the union)', async () => {
    const res = await post(`/${ORG}/deliverables/occurrences/${OCC}/deliver`, {
      evidence: [{ kind: 'document', documentId: RUN }],
    });
    expect(res.status).toBe(400);
    expect(deliverOccurrence).not.toHaveBeenCalled();
  });

  it('POST deliver → 409 on an invalid transition', async () => {
    deliverOccurrence.mockRejectedValueOnce({
      status: 409, code: 'INVALID_OCCURRENCE_TRANSITION', message: 'Cannot deliver an occurrence in status waived',
    });
    const res = await post(`/${ORG}/deliverables/occurrences/${OCC}/deliver`, {});
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'Cannot deliver an occurrence in status waived', code: 'INVALID_OCCURRENCE_TRANSITION',
    });
  });

  it('POST waive → 200; 400 without a reason', async () => {
    expect((await post(`/${ORG}/deliverables/occurrences/${OCC}/waive`, { reason: 'Customer paused' })).status).toBe(200);
    expect(waiveOccurrence).toHaveBeenCalledWith(ORG, OCC, { reason: 'Customer paused' }, ACTOR);
    expect((await post(`/${ORG}/deliverables/occurrences/${OCC}/waive`, {})).status).toBe(400);
  });

  it('POST reopen → 200', async () => {
    const res = await app.request(`/${ORG}/deliverables/occurrences/${OCC}/reopen`, { method: 'POST', headers: AUTH });
    expect(res.status).toBe(200);
    expect(reopenOccurrence).toHaveBeenCalledWith(ORG, OCC, ACTOR);
  });

  it('POST reschedule → 200 for ISO date; 400 for 31/10/2026', async () => {
    expect((await post(`/${ORG}/deliverables/occurrences/${OCC}/reschedule`, { dueAt: '2026-10-31' })).status).toBe(200);
    expect(rescheduleOccurrence).toHaveBeenCalledWith(ORG, OCC, { dueAt: '2026-10-31' }, ACTOR);
    expect((await post(`/${ORG}/deliverables/occurrences/${OCC}/reschedule`, { dueAt: '31/10/2026' })).status).toBe(400);
  });

  it('POST evidence → 200; DELETE evidence → 200', async () => {
    const ref = { kind: 'report_run', reportRunId: RUN };
    expect((await post(`/${ORG}/deliverables/occurrences/${OCC}/evidence`, ref)).status).toBe(200);
    expect(addEvidence).toHaveBeenCalledWith(ORG, OCC, ref, ACTOR);
    const res = await app.request(`/${ORG}/deliverables/occurrences/${OCC}/evidence/${EVID}`, { method: 'DELETE', headers: AUTH });
    expect(res.status).toBe(200);
    expect(removeEvidence).toHaveBeenCalledWith(ORG, OCC, EVID, ACTOR);
  });

  it('service error details are forwarded in the envelope', async () => {
    createDeliverable.mockRejectedValueOnce({ status: 422, code: 'BAD_CONTRACT', message: 'x', details: { contractId: DEL } });
    const res = await post(`/${ORG}/deliverables`, validCreate);
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'x', code: 'BAD_CONTRACT', details: { contractId: DEL } });
  });

  it('400 for a non-guid org or deliverable id', async () => {
    expect((await app.request(`/bad/deliverables`, { headers: AUTH })).status).toBe(400);
    expect((await app.request(`/${ORG}/deliverables/bad`, { headers: AUTH })).status).toBe(400);
  });

  // ── apply-template (W05) ────────────────────────────────────────────────
  it('POST apply-template returns { data } with created and skipped', async () => {
    templateMocks.applyTemplateSet.mockResolvedValueOnce({
      setId: DEL, setName: 'Best plan', orgId: ORG, contractId: null, effectiveFrom: '2026-10-01',
      created: [{ id: OCC, name: 'Sign-in log review', cadence: 'monthly', anchorDueDate: '2026-10-31' }],
      skipped: ['Firewall rule review'],
    });
    const res = await post(`/${ORG}/deliverables/apply-template`, { setId: DEL, effectiveFrom: '2026-10-01' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { skipped: ['Firewall rule review'] } });
    expect(templateMocks.applyTemplateSet).toHaveBeenCalledWith(
      ORG, DEL, { contractId: undefined, effectiveFrom: '2026-10-01', ownerUserId: undefined },
      expect.objectContaining({ scope: 'partner', partnerId: 'p1' }),
    );
  });

  it('POST apply-template surfaces 409 TEMPLATE_NAME_COLLISION with details.collisions', async () => {
    templateMocks.applyTemplateSet.mockRejectedValueOnce({
      status: 409, code: 'TEMPLATE_NAME_COLLISION', message: 'exists', details: { collisions: ['Sign-in log review'] },
    });
    const res = await post(`/${ORG}/deliverables/apply-template`, { setId: DEL });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'TEMPLATE_NAME_COLLISION', details: { collisions: ['Sign-in log review'] } });
  });

  it('POST apply-template 400s a non-ISO effectiveFrom before reaching the service', async () => {
    templateMocks.applyTemplateSet.mockClear();
    const res = await post(`/${ORG}/deliverables/apply-template`, { setId: DEL, effectiveFrom: '31/10/2026' });
    expect(res.status).toBe(400);
    expect(templateMocks.applyTemplateSet).not.toHaveBeenCalled();
  });

  it('apply-template is not swallowed by the /:id matcher', async () => {
    templateMocks.applyTemplateSet.mockResolvedValueOnce({ created: [], skipped: [] });
    const res = await post(`/${ORG}/deliverables/apply-template`, { setId: DEL });
    expect(res.status).toBe(200);
    expect(getDeliverable).not.toHaveBeenCalled();
  });
});
