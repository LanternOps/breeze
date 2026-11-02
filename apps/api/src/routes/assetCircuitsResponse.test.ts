/**
 * The shared response builder behind GET /devices/:id/circuits and
 * GET /discovery/assets/:id/circuits: capability gating and the response contract.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const ORG = '55555555-5555-4555-8555-555555555555';
const SITE_A = '11111111-1111-4111-8111-111111111111';
const SITE_B = '22222222-2222-4222-8222-222222222222';
const ID = '77777777-7777-4777-8777-777777777777';

const m = vi.hoisted(() => ({
  auth: null as any,
  permissions: null as any,
  caps: { read: true, write: true } as { read: boolean; write: boolean },
  accessCalls: [] as unknown[][],
  listAssetCircuitDtos: vi.fn(),
}));

vi.mock('../db', () => ({ db: { select: vi.fn() } }));
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
    requireTopologySiteAccess: vi.fn(async (...args: unknown[]) => {
      m.accessCalls.push(args);
      const cap = args[3] as 'read' | 'write';
      if (!m.caps[cap]) throw new TopologyError('topology_permission_denied', 403, 'denied');
      return {};
    }),
  };
});
vi.mock('../services/circuitAssetView', () => ({ listAssetCircuitDtos: m.listAssetCircuitDtos }));

import { respondAssetCircuits } from './assetCircuitsResponse';

const subject = { kind: 'device' as const, id: ID, orgId: ORG, siteId: SITE_A };
const app = new Hono();
app.get('/x', async (c) => {
  c.set('auth', m.auth);
  return respondAssetCircuits(c, subject);
});

function caller(opts: { tokenSites?: string[]; permissionSites?: string[] } = {}) {
  m.auth = {
    user: { id: 'user-1' }, scope: 'organization', orgId: ORG, partnerId: null,
    allowedSiteIds: opts.tokenSites, canAccessOrg: (id: string) => id === ORG,
  };
  m.permissions = { scope: 'organization', orgId: ORG, permissions: [], allowedSiteIds: opts.permissionSites };
}

const view = { bound: true, interfaces: [{ id: 'i', name: 'e', kind: 'k', role: null, retired: false, circuitId: null }], interfacesTruncated: false, circuits: [] };

beforeEach(() => {
  vi.clearAllMocks();
  m.caps = { read: true, write: true };
  m.accessCalls = [];
  caller();
  m.listAssetCircuitDtos.mockResolvedValue(view);
});

describe('respondAssetCircuits', () => {
  it('assembles the contract with read+write capabilities', async () => {
    const res = await app.request('/x');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      subject,
      topology: { bound: true },
      capabilities: { interfacesVisible: true, wanRoleWritable: true },
      interfaces: view.interfaces,
      interfacesTruncated: false,
      circuits: [],
    });
    expect(m.accessCalls.map((a) => [a[2], a[3]])).toEqual([[SITE_A, 'read'], [SITE_A, 'write']]);
    expect(m.listAssetCircuitDtos).toHaveBeenCalledWith(
      subject,
      expect.objectContaining({ includeInterfaces: true, scope: { allowedSiteIds: null } }),
    );
  });

  it('hides interfaces without topology read and reports the capability false', async () => {
    m.caps = { read: false, write: false };
    m.listAssetCircuitDtos.mockResolvedValue({ ...view, interfaces: [] });
    const body = await (await app.request('/x')).json();
    expect(body.capabilities).toEqual({ interfacesVisible: false, wanRoleWritable: false });
    expect(body.interfaces).toEqual([]);
    expect(m.listAssetCircuitDtos).toHaveBeenCalledWith(subject, expect.objectContaining({ includeInterfaces: false }));
  });

  it('reports wanRoleWritable false with read-only topology access', async () => {
    m.caps = { read: true, write: false };
    const body = await (await app.request('/x')).json();
    expect(body.capabilities).toEqual({ interfacesVisible: true, wanRoleWritable: false });
  });

  it('passes the token ceiling intersected with the permission allowlist as scope', async () => {
    caller({ tokenSites: [SITE_A, SITE_B], permissionSites: [SITE_B] });
    await app.request('/x');
    expect(m.listAssetCircuitDtos).toHaveBeenCalledWith(
      subject,
      expect.objectContaining({ scope: { allowedSiteIds: [SITE_B] } }),
    );
  });

  it('applies the caller org ceiling via canAccessOrg', async () => {
    await app.request('/x');
    const opts = m.listAssetCircuitDtos.mock.calls[0]![1];
    expect(opts.canAccessOrg(ORG)).toBe(true);
    expect(opts.canAccessOrg('other')).toBe(false);
  });
});
