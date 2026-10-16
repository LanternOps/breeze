import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { gates, permsState, readMocks } = vi.hoisted(() => ({
  gates: { permission: false },
  permsState: { value: undefined as undefined | Record<string, unknown> },
  readMocks: {
    resolveEdrReadScope: vi.fn(),
    listEdrDetections: vi.fn(),
    getEdrStatus: vi.fn(),
  },
}));

vi.mock('../../middleware/auth', () => ({
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (c: any, next: any) => {
    if (gates.permission) return c.json({ error: 'Forbidden' }, 403);
    c.set('permissions', permsState.value);
    return next();
  }),
}));

vi.mock('../../services/permissions', () => ({
  PERMISSIONS: { DEVICES_READ: { resource: 'devices', action: 'read' } },
}));

vi.mock('../../services/edrProviders/read', async () => {
  class EdrReadError extends Error {
    constructor(public status: number, message: string) { super(message); }
  }
  return { ...readMocks, EdrReadError, EDR_DETECTIONS_MAX_LIMIT: 200 };
});

import { edrDetectionRoutes } from './detections';
import { EdrReadError } from '../../services/edrProviders/read';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '22222222-2222-4222-8222-222222222222';
const COVERAGE = { orgsWithEdr: 0, partial: true, notes: ['No EDR provider endpoints are visible for this organization.'] };

describe('EDR detection read routes', () => {
  let app: Hono;
  const auth = { scope: 'organization', orgId: ORG_ID };

  beforeEach(() => {
    vi.clearAllMocks();
    gates.permission = false;
    permsState.value = { allowedSiteIds: undefined };
    readMocks.resolveEdrReadScope.mockImplementation(async (a: unknown) => ({ auth: a, allowedDeviceIds: null, allowedSiteIds: null }));
    readMocks.listEdrDetections.mockResolvedValue({ rows: [], total: 0, coverage: COVERAGE });
    readMocks.getEdrStatus.mockResolvedValue({ providers: [], coverage: COVERAGE });
    app = new Hono();
    app.use('*', async (c, next) => {
      c.set('auth' as never, auth as never);
      return next();
    });
    app.route('/edr', edrDetectionRoutes);
  });

  describe('GET /edr/detections', () => {
    it('an empty list still carries coverage (empty is not "clean")', async () => {
      const res = await app.request('/edr/detections');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toEqual([]);
      expect(body.coverage).toEqual(COVERAGE);
      expect(body.pagination).toEqual({ limit: 50, offset: 0, total: 0 });
    });

    it('passes filters through and defaults status to open', async () => {
      await app.request(`/edr/detections?orgId=${ORG_ID}&severity=critical,high&provider=bitdefender&limit=10&offset=20`);
      expect(readMocks.listEdrDetections).toHaveBeenCalledWith(
        expect.objectContaining({ auth }),
        { orgId: ORG_ID, deviceId: undefined, severity: ['critical', 'high'], status: 'open', provider: 'bitdefender', limit: 10, offset: 20 },
      );
    });

    it('clamps limit to 200', async () => {
      await app.request('/edr/detections?limit=5000');
      expect(readMocks.listEdrDetections.mock.calls[0]![1].limit).toBe(200);
    });

    it('rejects malformed filters with 400', async () => {
      for (const q of ['severity=nope', 'status=bogus', `deviceId=not-a-uuid`, 'orgId=x', 'limit=0']) {
        expect((await app.request(`/edr/detections?${q}`)).status, q).toBe(400);
      }
    });

    it('maps a scope refusal (foreign orgId) to its status', async () => {
      readMocks.listEdrDetections.mockRejectedValueOnce(new EdrReadError(403, 'Access to this organization denied'));
      const res = await app.request(`/edr/detections?orgId=${OTHER_ORG}`);
      expect(res.status).toBe(403);
    });

    it('resolves the site restriction from the caller permissions', async () => {
      permsState.value = { allowedSiteIds: ['s1'] };
      await app.request('/edr/detections');
      expect(readMocks.resolveEdrReadScope).toHaveBeenCalledWith(auth, { allowedSiteIds: ['s1'] });
    });

    it('never returns vendor jsonb even if the read model handed it over', async () => {
      readMocks.listEdrDetections.mockResolvedValueOnce({
        rows: [{ id: 'x', title: 't', details: { secret: 1 }, vendorRaw: { a: 1 } }], total: 1, coverage: COVERAGE,
      });
      const body = await (await app.request('/edr/detections')).json();
      expect(body.data[0]).not.toHaveProperty('details');
      expect(body.data[0]).not.toHaveProperty('vendorRaw');
    });

    it('is gated on devices:read', async () => {
      gates.permission = true;
      expect((await app.request('/edr/detections')).status).toBe(403);
      expect(readMocks.listEdrDetections).not.toHaveBeenCalled();
    });
  });

  describe('GET /edr/status', () => {
    it('returns the status summary', async () => {
      const res = await app.request(`/edr/status?orgId=${ORG_ID}`);
      expect(res.status).toBe(200);
      expect((await res.json()).data).toEqual({ providers: [], coverage: COVERAGE });
      expect(readMocks.getEdrStatus).toHaveBeenCalledWith(expect.objectContaining({ auth }), { orgId: ORG_ID });
    });

    it('is gated on devices:read', async () => {
      gates.permission = true;
      expect((await app.request('/edr/status')).status).toBe(403);
    });
  });
});
