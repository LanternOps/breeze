/**
 * Circuit routes: site-scoped technicians (spec 7.2). Auth, permissions and the
 * data layer are mocked; the real route code, site rule and DTO redaction run.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const SITE_A = '11111111-1111-4111-8111-111111111111';
const SITE_B = '22222222-2222-4222-8222-222222222222';
const SITE_C = '33333333-3333-4333-8333-333333333333';
const CIRCUIT_ID = '44444444-4444-4444-8444-444444444444';
const ORG_ID = '55555555-5555-4555-8555-555555555555';

const m = vi.hoisted(() => ({
  auth: null as any,
  permissions: null as any,
  writableSites: [] as string[],
  getCircuitDto: vi.fn(),
  createCircuit: vi.fn(),
  listCircuitDtos: vi.fn(),
  updateCircuit: vi.fn(),
  deleteCircuit: vi.fn(),
  setCircuitServedSites: vi.fn(),
  clearCircuitTermination: vi.fn(),
}));

vi.mock('../db', () => ({ db: { select: vi.fn() } }));
vi.mock('../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('auth', m.auth);
    return next();
  },
  requireMfa: () => async (_c: any, next: any) => next(),
  requirePermission: () => async (_c: any, next: any) => next(),
  requireScope: () => async (_c: any, next: any) => next(),
}));
vi.mock('../services/permissions', async () => ({
  ...(await vi.importActual<object>('../services/permissions')),
  getUserPermissions: vi.fn(async () => m.permissions),
}));
vi.mock('../services/topology/access', () => {
  class TopologyError extends Error {
    constructor(public readonly code: string, public readonly status: 403 | 404, message: string) {
      super(message);
    }
  }
  return {
    TopologyError,
    requireTopologySiteAccess: vi.fn(async (_auth: unknown, _perms: unknown, siteId: string) => {
      if (!m.writableSites.includes(siteId)) throw new TopologyError('topology_site_not_found', 404, 'Topology site not found');
      return {};
    }),
  };
});
vi.mock('../services/circuits', async () => ({
  ...(await vi.importActual<object>('../services/circuits')),
  getCircuitDto: m.getCircuitDto,
  createCircuit: m.createCircuit,
  listCircuitDtos: m.listCircuitDtos,
  updateCircuit: m.updateCircuit,
  deleteCircuit: m.deleteCircuit,
  setCircuitServedSites: m.setCircuitServedSites,
  clearCircuitTermination: m.clearCircuitTermination,
}));

import { circuitRoutes } from './circuits';

const app = new Hono();
app.route('/circuits', circuitRoutes);

function circuit(primary: string | null, served: string[] = []) {
  return {
    id: CIRCUIT_ID,
    orgId: ORG_ID,
    providerName: 'Acme',
    cid: 'CID-1',
    bandwidthBps: null,
    serviceType: null,
    administrativeStatus: 'active',
    terminationState: primary ? 'assigned' : 'unassigned',
    termination: primary
      ? {
          interfaceId: '66666666-6666-4666-8666-666666666666',
          interfaceName: 'Gi0/1',
          asset: null,
          primarySite: { id: primary, name: 'Primary' },
          placement: null,
        }
      : null,
    additionalServedSites: served.map((id) => ({ id, name: `Served ${id.slice(0, 2)}` })),
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function caller(opts: { tokenSites?: string[]; permissionSites?: unknown } = {}) {
  m.auth = {
    user: { id: 'user-1' },
    scope: 'organization',
    orgId: ORG_ID,
    partnerId: null,
    allowedSiteIds: opts.tokenSites,
    canAccessOrg: () => true,
    orgCondition: () => undefined,
  };
  m.permissions = { scope: 'organization', orgId: ORG_ID, permissions: [], allowedSiteIds: opts.permissionSites };
}

const json = { 'content-type': 'application/json' };

beforeEach(() => {
  vi.clearAllMocks();
  m.writableSites = [];
  caller();
});

describe('POST /circuits', () => {
  const payload = { providerName: 'Acme', cid: 'CID-1' };

  it('creates in the organization context when orgId is omitted', async () => {
    m.createCircuit.mockResolvedValue(circuit(null));
    const res = await app.request('/circuits', { method: 'POST', headers: json, body: JSON.stringify(payload) });
    expect(res.status).toBe(201);
    expect(m.createCircuit).toHaveBeenCalledWith(ORG_ID, payload);
  });

  it('lets a partner-scope caller select an accessible organization explicitly', async () => {
    const canAccessOrg = vi.fn((id: string) => id === ORG_ID);
    m.auth = { ...m.auth, scope: 'partner', orgId: null, partnerId: 'partner-1', canAccessOrg };
    m.createCircuit.mockResolvedValue(circuit(null));

    const res = await app.request('/circuits', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ ...payload, orgId: ORG_ID }),
    });

    expect(res.status).toBe(201);
    expect(canAccessOrg).toHaveBeenCalledWith(ORG_ID);
    expect(m.createCircuit).toHaveBeenCalledWith(ORG_ID, payload);
  });

  it('rejects an explicit organization outside the caller access set', async () => {
    m.auth = { ...m.auth, scope: 'partner', orgId: null, partnerId: 'partner-1', canAccessOrg: vi.fn(() => false) };
    const res = await app.request('/circuits', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ ...payload, orgId: ORG_ID }),
    });
    expect(res.status).toBe(403);
    expect(m.createCircuit).not.toHaveBeenCalled();
  });

  it('requires orgId when the caller has no organization context', async () => {
    m.auth = { ...m.auth, scope: 'partner', orgId: null, partnerId: 'partner-1' };
    const res = await app.request('/circuits', { method: 'POST', headers: json, body: JSON.stringify(payload) });
    expect(res.status).toBe(400);
    expect(m.createCircuit).not.toHaveBeenCalled();
  });
});

describe('GET /circuits/:id', () => {
  it('returns 404 for a circuit whose primary site the caller cannot reach', async () => {
    caller({ permissionSites: [SITE_A] });
    m.getCircuitDto.mockResolvedValue(circuit(SITE_B));
    const res = await app.request(`/circuits/${CIRCUIT_ID}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Circuit not found' });
  });

  it('does not expose a circuit through an accessible served site alone when it has a termination', async () => {
    caller({ permissionSites: [SITE_B] });
    m.getCircuitDto.mockResolvedValue(circuit(SITE_A, [SITE_B]));
    expect((await app.request(`/circuits/${CIRCUIT_ID}`)).status).toBe(404);
  });

  it('returns the circuit with only the served sites the caller can access', async () => {
    caller({ permissionSites: [SITE_A, SITE_B] });
    m.getCircuitDto.mockResolvedValue(circuit(SITE_A, [SITE_B, SITE_C]));
    const res = await app.request(`/circuits/${CIRCUIT_ID}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.additionalServedSites.map((s: { id: string }) => s.id)).toEqual([SITE_B]);
    expect(JSON.stringify(body)).not.toContain(SITE_C);
  });

  it('returns a circuit without a termination through an accessible served site', async () => {
    caller({ permissionSites: [SITE_B] });
    m.getCircuitDto.mockResolvedValue(circuit(null, [SITE_B, SITE_C]));
    const res = await app.request(`/circuits/${CIRCUIT_ID}`);
    expect(res.status).toBe(200);
    expect((await res.json()).additionalServedSites.map((s: { id: string }) => s.id)).toEqual([SITE_B]);
  });

  it('intersects the token ceiling with the permission allowlist', async () => {
    caller({ tokenSites: [SITE_A], permissionSites: [SITE_A, SITE_B] });
    m.getCircuitDto.mockResolvedValue(circuit(SITE_B));
    expect((await app.request(`/circuits/${CIRCUIT_ID}`)).status).toBe(404);
  });

  it('fails closed on a malformed permission allowlist', async () => {
    caller({ permissionSites: 'not-an-array' });
    m.getCircuitDto.mockResolvedValue(circuit(SITE_A));
    expect((await app.request(`/circuits/${CIRCUIT_ID}`)).status).toBe(404);
  });

  it('shows everything to an unrestricted caller', async () => {
    m.getCircuitDto.mockResolvedValue(circuit(SITE_A, [SITE_B, SITE_C]));
    const res = await app.request(`/circuits/${CIRCUIT_ID}`);
    expect(res.status).toBe(200);
    expect((await res.json()).additionalServedSites).toHaveLength(2);
  });
});

describe('GET /circuits', () => {
  it('passes the resolved site scope and the page window to the list query', async () => {
    caller({ tokenSites: [SITE_A, SITE_B], permissionSites: [SITE_B, SITE_C] });
    m.listCircuitDtos.mockResolvedValue({ items: [], nextCursor: null });
    const res = await app.request('/circuits?limit=25');
    expect(res.status).toBe(200);
    expect(m.listCircuitDtos).toHaveBeenCalledWith(expect.objectContaining({ scope: { allowedSiteIds: [SITE_B] }, limit: 25 }));
    expect(await res.json()).toEqual({ data: [], nextCursor: null });
  });

  it('treats an unrestricted caller as null scope and uses the default page size', async () => {
    m.listCircuitDtos.mockResolvedValue({ items: [], nextCursor: null });
    await app.request('/circuits');
    expect(m.listCircuitDtos).toHaveBeenCalledWith(expect.objectContaining({ scope: { allowedSiteIds: null }, limit: 50 }));
  });

  it('rejects an out-of-range page size and a non-UUID cursor', async () => {
    expect((await app.request('/circuits?limit=1000')).status).toBe(400);
    expect((await app.request('/circuits?cursor=nope')).status).toBe(400);
    expect(m.listCircuitDtos).not.toHaveBeenCalled();
  });

  it('returns the next cursor from the service', async () => {
    m.listCircuitDtos.mockResolvedValue({ items: [circuit(SITE_A)], nextCursor: CIRCUIT_ID });
    const body = await (await app.request('/circuits')).json();
    expect(body.nextCursor).toBe(CIRCUIT_ID);
    expect(body.data).toHaveLength(1);
  });
});

describe('PATCH /circuits/:id', () => {
  const patch = () => app.request(`/circuits/${CIRCUIT_ID}`, { method: 'PATCH', headers: json, body: JSON.stringify({ administrativeStatus: 'suspended' }) });

  it('returns 404 and writes nothing for a circuit the caller cannot see', async () => {
    caller({ permissionSites: [SITE_A] });
    m.getCircuitDto.mockResolvedValue(circuit(SITE_B));
    expect((await patch()).status).toBe(404);
    expect(m.updateCircuit).not.toHaveBeenCalled();
  });

  it('returns 403 and writes nothing when the primary site is readable but not writable', async () => {
    caller({ permissionSites: [SITE_A] });
    m.getCircuitDto.mockResolvedValue(circuit(SITE_A));
    const res = await patch();
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('CIRCUIT_SITE_FORBIDDEN');
    expect(m.updateCircuit).not.toHaveBeenCalled();
  });

  it('updates when the primary site is writable and redacts the response', async () => {
    caller({ permissionSites: [SITE_A] });
    m.writableSites = [SITE_A];
    m.getCircuitDto.mockResolvedValue(circuit(SITE_A, [SITE_B]));
    m.updateCircuit.mockResolvedValue(circuit(SITE_A, [SITE_B]));
    const res = await patch();
    expect(res.status).toBe(200);
    expect(m.updateCircuit).toHaveBeenCalledOnce();
    expect((await res.json()).additionalServedSites).toEqual([]);
  });

  it('requires every served site to be writable for a restricted caller on a circuit without a termination', async () => {
    caller({ permissionSites: [SITE_B] });
    m.writableSites = [SITE_B];
    m.getCircuitDto.mockResolvedValue(circuit(null, [SITE_B, SITE_C]));
    expect((await patch()).status).toBe(403);
    expect(m.updateCircuit).not.toHaveBeenCalled();
  });
});

describe('DELETE /circuits/:id', () => {
  const del = () => app.request(`/circuits/${CIRCUIT_ID}`, { method: 'DELETE' });

  it('returns 404 and deletes nothing for a circuit the caller cannot see', async () => {
    caller({ permissionSites: [SITE_A] });
    m.getCircuitDto.mockResolvedValue(circuit(SITE_B));
    expect((await del()).status).toBe(404);
    expect(m.deleteCircuit).not.toHaveBeenCalled();
  });

  it('refuses with a generic 403 that names no site when a hidden served site is involved', async () => {
    caller({ permissionSites: [SITE_A] });
    m.writableSites = [SITE_A];
    m.getCircuitDto.mockResolvedValue(circuit(SITE_A, [SITE_B]));
    const res = await del();
    expect(res.status).toBe(403);
    const text = await res.text();
    expect(text).not.toContain(SITE_B);
    expect(text).not.toContain('Served');
    expect(m.deleteCircuit).not.toHaveBeenCalled();
  });

  it('deletes when the primary and every served site are writable', async () => {
    caller({ permissionSites: [SITE_A, SITE_B] });
    m.writableSites = [SITE_A, SITE_B];
    m.getCircuitDto.mockResolvedValue(circuit(SITE_A, [SITE_B]));
    expect((await del()).status).toBe(200);
    expect(m.deleteCircuit).toHaveBeenCalledWith(CIRCUIT_ID);
  });
});

describe('PUT /circuits/:id/served-sites', () => {
  const put = (siteIds: string[]) =>
    app.request(`/circuits/${CIRCUIT_ID}/served-sites`, { method: 'PUT', headers: json, body: JSON.stringify({ siteIds }) });

  it('returns 404 for a circuit the caller cannot see', async () => {
    caller({ permissionSites: [SITE_A] });
    m.getCircuitDto.mockResolvedValue(circuit(SITE_B));
    expect((await put([SITE_A])).status).toBe(404);
    expect(m.setCircuitServedSites).not.toHaveBeenCalled();
  });

  it('refuses to remove a served site the caller cannot write', async () => {
    caller({ permissionSites: [SITE_A] });
    m.writableSites = [SITE_A];
    m.getCircuitDto.mockResolvedValue(circuit(SITE_A, [SITE_B]));
    const res = await put([]);
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain(SITE_B);
    expect(m.setCircuitServedSites).not.toHaveBeenCalled();
  });

  it('applies the change when primary, added and removed sites are all writable', async () => {
    caller({ permissionSites: [SITE_A, SITE_B, SITE_C] });
    m.writableSites = [SITE_A, SITE_B, SITE_C];
    m.getCircuitDto.mockResolvedValue(circuit(SITE_A, [SITE_B]));
    m.setCircuitServedSites.mockResolvedValue(circuit(SITE_A, [SITE_C]));
    const res = await put([SITE_C]);
    expect(res.status).toBe(200);
    expect(m.setCircuitServedSites).toHaveBeenCalledWith(CIRCUIT_ID, [SITE_C]);
  });
});

describe('DELETE /circuits/:id/termination', () => {
  it('returns 404 for a circuit the caller cannot see', async () => {
    caller({ permissionSites: [SITE_A] });
    m.getCircuitDto.mockResolvedValue(circuit(SITE_B));
    expect((await app.request(`/circuits/${CIRCUIT_ID}/termination`, { method: 'DELETE' })).status).toBe(404);
    expect(m.clearCircuitTermination).not.toHaveBeenCalled();
  });
});
