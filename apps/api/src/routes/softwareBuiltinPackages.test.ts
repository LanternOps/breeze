import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// Chain-friendly Drizzle mock (mirrors softwareInstallMethods.test.ts): every
// builder call returns the same proxy; awaiting it resolves the queued value.
function chainMock(terminalValue: unknown): any {
  const p: any = new Proxy(() => p, {
    get: (_t, prop) => (prop === 'then' ? (resolve: any) => resolve(terminalValue) : () => p),
  });
  return p;
}

const { state } = vi.hoisted(() => ({
  state: {
    auth: null as null | Record<string, unknown>,
    granted: new Set<string>(),
    mfa: true,
    selectQueue: [] as unknown[],
  },
}));

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(() => chainMock(state.selectQueue.length ? state.selectQueue.shift() : [])),
  },
}));

vi.mock('../db/schema', () => ({
  softwareCatalog: { id: 'id', partnerId: 'partner_id', builtinPackageKey: 'builtin_package_key', deletedAt: 'deleted_at' },
  partners: { id: 'p_id' },
}));

// Realistic gates: scope, per-permission grants and MFA are all enforced, so
// the tests prove which gate the route mounts rather than stubbing them away.
vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    if (!state.auth) return c.json({ error: 'Unauthorized' }, 401);
    c.set('auth', state.auth);
    return next();
  }),
  requireScope: vi.fn((...scopes: string[]) => async (c: any, next: any) => {
    if (!scopes.includes(c.get('auth').scope)) return c.json({ error: 'Insufficient scope' }, 403);
    return next();
  }),
  requirePermission: vi.fn((resource: string, action: string) => async (c: any, next: any) => {
    if (!state.granted.has(`${resource}:${action}`)) return c.json({ error: 'Permission denied' }, 403);
    return next();
  }),
  requireMfa: vi.fn(() => async (c: any, next: any) => {
    if (!state.mfa) return c.json({ error: 'MFA required' }, 403);
    return next();
  }),
}));

vi.mock('../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));

vi.mock('../services/builtinDeploymentPackages', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/builtinDeploymentPackages')>();
  return { ...actual, ensurePinnedBuiltinPackage: vi.fn() };
});

import { softwareBuiltinPackagesRoutes } from './softwareBuiltinPackages';
import { ensurePinnedBuiltinPackage } from '../services/builtinDeploymentPackages';
import { writeRouteAudit } from '../services/auditEvents';
import { PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../services/partnerWideAccess';

const PARTNER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_PARTNER_ID = '22222222-2222-4222-8222-222222222222';
const CATALOG_ID = '33333333-3333-4333-8333-333333333333';
const VERSION_ID = '44444444-4444-4444-8444-444444444444';

const ALL_PERMS = ['devices:read', 'devices:write', 'devices:execute'];

function asPartner(overrides: Record<string, unknown> = {}) {
  state.auth = {
    scope: 'partner',
    partnerId: PARTNER_ID,
    orgId: null,
    partnerOrgAccess: 'all',
    user: { id: 'user-1', email: 'admin@example.test' },
    ...overrides,
  };
}
function asSystem() {
  state.auth = { scope: 'system', partnerId: null, orgId: null, user: { id: 'sys', email: 'sys@example.test' } };
}
function asOrg() {
  state.auth = { scope: 'organization', partnerId: PARTNER_ID, orgId: 'org-1', user: { id: 'u', email: 'u@example.test' } };
}

function app() {
  const a = new Hono();
  a.route('/software/builtin-packages', softwareBuiltinPackagesRoutes);
  return a;
}
const get = (path = '') => app().request(`/software/builtin-packages${path}`);
const post = (key: string, query = '', body?: unknown) =>
  app().request(`/software/builtin-packages/${key}${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  state.auth = null;
  state.granted = new Set(ALL_PERMS);
  state.mfa = true;
  state.selectQueue = [];
  vi.mocked(ensurePinnedBuiltinPackage).mockResolvedValue({ catalogId: CATALOG_ID, versionId: VERSION_ID });
});

describe('GET /software/builtin-packages', () => {
  it('401 without auth', async () => {
    expect((await get()).status).toBe(401);
  });

  it('403 for org scope', async () => {
    asOrg();
    expect((await get()).status).toBe(403);
  });

  it('403 without devices.read', async () => {
    asPartner();
    state.granted = new Set(['devices:write', 'devices:execute']);
    expect((await get()).status).toBe(403);
  });

  it('partner scope: lists visible keys (hidden omitted) with provisioned state', async () => {
    asPartner();
    state.selectQueue.push([
      { id: CATALOG_ID, builtinPackageKey: 'controld_windows', deletedAt: null },
      { id: 'archived-id', builtinPackageKey: 'nextdns_windows', deletedAt: new Date('2026-10-01T00:00:00Z') },
    ]);
    const res = await get();
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.map((r: any) => r.key)).toEqual(['controld_windows', 'nextdns_windows']);
    expect(data[0]).toEqual({
      key: 'controld_windows',
      name: 'Control D (Windows)',
      vendor: 'Control D',
      os: 'windows',
      version: '1.5.8',
      fileType: 'zip',
      requiredVars: ['controld_provisioning_code'],
      uninstallCommand: 'C:\\ControlD\\ctrld.exe uninstall',
      catalogId: CATALOG_ID,
      archived: false,
    });
    expect(data[1]).toMatchObject({ key: 'nextdns_windows', catalogId: 'archived-id', archived: true });
  });

  it('partner scope: an unprovisioned key has catalogId null', async () => {
    asPartner();
    const { data } = await (await get()).json();
    expect(data.every((r: any) => r.catalogId === null && r.archived === false)).toBe(true);
  });

  it('partner scope ignores a ?partnerId= for another partner', async () => {
    asPartner();
    const res = await get(`?partnerId=${OTHER_PARTNER_ID}`);
    expect(res.status).toBe(200);
    // The route queried with auth.partnerId; the RLS partner branch enforces the rest.
    const { data } = await res.json();
    expect(data).toHaveLength(2);
  });

  it('system scope: 400 without ?partnerId=', async () => {
    asSystem();
    expect((await get()).status).toBe(400);
  });

  it('system scope: includes hidden keys', async () => {
    asSystem();
    const res = await get(`?partnerId=${PARTNER_ID}`);
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.map((r: any) => r.key)).toEqual(['controld_windows', 'controld_macos', 'nextdns_windows']);
  });
});

describe('POST /software/builtin-packages/:key', () => {
  it('201 for a full partner admin; partner is always auth.partnerId', async () => {
    asPartner();
    const res = await post('controld_windows', `?partnerId=${OTHER_PARTNER_ID}`, { partnerId: OTHER_PARTNER_ID });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ catalogId: CATALOG_ID, versionId: VERSION_ID });
    expect(ensurePinnedBuiltinPackage).toHaveBeenCalledWith({ key: 'controld_windows', partnerId: PARTNER_ID });
    expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      orgId: null,
      partnerId: PARTNER_ID,
      action: 'software.builtin_package.provision',
      resourceType: 'software_catalog',
      resourceId: CATALOG_ID,
    }));
  });

  it('201 again when already provisioned (ensure is idempotent)', async () => {
    asPartner();
    expect((await post('nextdns_windows')).status).toBe(201);
    expect((await post('nextdns_windows')).status).toBe(201);
    expect(ensurePinnedBuiltinPackage).toHaveBeenCalledTimes(2);
  });

  it('404 for an unknown key', async () => {
    asPartner();
    expect((await post('not_a_key')).status).toBe(404);
    expect((await post('__proto__')).status).toBe(404);
    expect(ensurePinnedBuiltinPackage).not.toHaveBeenCalled();
  });

  it('404 for a hidden key in partner scope', async () => {
    asPartner();
    expect((await post('controld_macos')).status).toBe(404);
    expect(ensurePinnedBuiltinPackage).not.toHaveBeenCalled();
  });

  it('system scope may provision a hidden key, with ?partnerId=', async () => {
    asSystem();
    state.selectQueue.push([{ id: PARTNER_ID }]);
    const res = await post('controld_macos', `?partnerId=${PARTNER_ID}`);
    expect(res.status).toBe(201);
    expect(ensurePinnedBuiltinPackage).toHaveBeenCalledWith({ key: 'controld_macos', partnerId: PARTNER_ID });
  });

  it('system scope: 400 without ?partnerId=, 404 for an unknown partner', async () => {
    asSystem();
    expect((await post('controld_windows')).status).toBe(400);
    expect((await post('controld_windows', '?partnerId=not-a-uuid')).status).toBe(400);
    state.selectQueue.push([]);
    expect((await post('controld_windows', `?partnerId=${PARTNER_ID}`)).status).toBe(404);
    expect(ensurePinnedBuiltinPackage).not.toHaveBeenCalled();
  });

  it('403 for org scope', async () => {
    asOrg();
    expect((await post('controld_windows')).status).toBe(403);
    expect(ensurePinnedBuiltinPackage).not.toHaveBeenCalled();
  });

  it('403 for org scope even with every grant and a forged partnerOrgAccess (requireScope is the gate)', async () => {
    asOrg();
    state.auth = { ...state.auth!, partnerOrgAccess: 'all' };
    const res = await post('controld_windows');
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('Insufficient scope');
    expect(ensurePinnedBuiltinPackage).not.toHaveBeenCalled();
  });

  it('401 without auth', async () => {
    expect((await post('controld_windows')).status).toBe(401);
  });

  it('system scope audits the provision against the named partner', async () => {
    asSystem();
    state.selectQueue.push([{ id: PARTNER_ID }]);
    expect((await post('nextdns_windows', `?partnerId=${PARTNER_ID}`)).status).toBe(201);
    expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      orgId: null,
      partnerId: PARTNER_ID,
      action: 'software.builtin_package.provision',
    }));
  });

  it('403 for a partner user with orgAccess=selected (partner-wide write gate)', async () => {
    asPartner({ partnerOrgAccess: 'selected' });
    const res = await post('controld_windows');
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe(PARTNER_WIDE_WRITE_DENIED_MESSAGE);
    expect(ensurePinnedBuiltinPackage).not.toHaveBeenCalled();
  });

  it.each([
    ['devices.write', ['devices:read', 'devices:execute']],
    ['devices.execute', ['devices:read', 'devices:write']],
  ])('403 without %s', async (_label, perms) => {
    asPartner();
    state.granted = new Set(perms);
    expect((await post('controld_windows')).status).toBe(403);
    expect(ensurePinnedBuiltinPackage).not.toHaveBeenCalled();
  });

  it('403 without MFA', async () => {
    asPartner();
    state.mfa = false;
    expect((await post('controld_windows')).status).toBe(403);
    expect(ensurePinnedBuiltinPackage).not.toHaveBeenCalled();
  });

  it('403 for a partner-scope token with no partnerId', async () => {
    asPartner({ partnerId: null });
    expect((await post('controld_windows')).status).toBe(403);
    expect(ensurePinnedBuiltinPackage).not.toHaveBeenCalled();
  });
});
