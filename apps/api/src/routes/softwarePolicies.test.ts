import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { AuthContext } from '../middleware/auth';

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db/schema', () => ({
  devices: {
    id: 'devices.id',
    orgId: 'devices.orgId',
    siteId: 'devices.siteId',
    hostname: 'devices.hostname',
    status: 'devices.status',
    osType: 'devices.osType',
  },
  softwareComplianceStatus: {
    id: 'softwareComplianceStatus.id',
    policyId: 'softwareComplianceStatus.policyId',
    deviceId: 'softwareComplianceStatus.deviceId',
    status: 'softwareComplianceStatus.status',
    violations: 'softwareComplianceStatus.violations',
    lastChecked: 'softwareComplianceStatus.lastChecked',
    remediationStatus: 'softwareComplianceStatus.remediationStatus',
    lastRemediationAttempt: 'softwareComplianceStatus.lastRemediationAttempt',
  },
  softwarePolicies: { id: 'id', orgId: 'orgId', mode: 'mode', name: 'name', isActive: 'isActive' },
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => next()),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
}));

vi.mock('../jobs/softwareComplianceWorker', () => ({
  scheduleSoftwareComplianceCheck: vi.fn(),
}));

vi.mock('../jobs/softwareRemediationWorker', () => ({
  scheduleSoftwareRemediation: vi.fn(async () => 1),
}));

vi.mock('../services/softwarePolicyService', () => ({
  normalizeSoftwarePolicyRules: (r: any) => ({
    software: r.software ?? [],
    executable: r.executable,
    allowUnknown: r.allowUnknown,
  }),
  recordSoftwarePolicyAudit: vi.fn(async () => undefined),
}));

vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: vi.fn(),
}));

vi.mock('../services/sentry', () => ({
  captureException: vi.fn(),
}));

vi.mock('../services/permissions', () => ({
  PERMISSIONS: {
    DEVICES_READ: { resource: 'devices', action: 'read' },
    DEVICES_WRITE: { resource: 'devices', action: 'write' },
    DEVICES_EXECUTE: { resource: 'devices', action: 'execute' },
  },
  // Faithful to the real implementation: unrestricted callers (no
  // allowedSiteIds) always pass; otherwise the site must be in the allowlist.
  canAccessSite: (perms: any, siteId: string) =>
    !perms?.allowedSiteIds || perms.allowedSiteIds.includes(siteId),
}));

import {
  executableRuleSchema,
  resolveOrgIdForWrite,
  softwarePoliciesRoutes,
  softwareRulesSchema,
} from './softwarePolicies';
import { normalizeSoftwarePolicyRules } from '../services/softwarePolicyService';
import { db } from '../db';
import { authMiddleware } from '../middleware/auth';
import { scheduleSoftwareRemediation } from '../jobs/softwareRemediationWorker';

function makeOrgAuth(orgId: string): AuthContext {
  return {
    scope: 'organization',
    orgId,
    canAccessOrg: (id: string) => id === orgId,
    orgCondition: () => null,
    user: { id: 'user-1' },
    accessibleOrgIds: [orgId],
  } as unknown as AuthContext;
}

function makePartnerAuth(orgIds: string[]): AuthContext {
  return {
    scope: 'partner',
    orgId: undefined,
    canAccessOrg: (id: string) => orgIds.includes(id),
    orgCondition: () => null,
    user: { id: 'user-1' },
    accessibleOrgIds: orgIds,
  } as unknown as AuthContext;
}

describe('resolveOrgIdForWrite', () => {
  it('org-scope token cannot write to a different org', () => {
    const auth = makeOrgAuth('org-A');
    const result = resolveOrgIdForWrite(auth, 'org-B');
    expect(result.error).toBeDefined();
    expect(result.orgId).toBeUndefined();
  });

  it('org-scope token can write to its own org', () => {
    const auth = makeOrgAuth('org-A');
    const result = resolveOrgIdForWrite(auth, 'org-A');
    expect(result.orgId).toBe('org-A');
    expect(result.error).toBeUndefined();
  });

  it('org-scope token uses its own org when no requestedOrgId', () => {
    const auth = makeOrgAuth('org-A');
    const result = resolveOrgIdForWrite(auth);
    expect(result.orgId).toBe('org-A');
  });

  it('partner-scope token denied for inaccessible org', () => {
    const auth = makePartnerAuth(['org-A', 'org-B']);
    const result = resolveOrgIdForWrite(auth, 'org-C');
    expect(result.error).toBeDefined();
  });

  it('partner-scope token allowed for accessible org', () => {
    const auth = makePartnerAuth(['org-A', 'org-B']);
    const result = resolveOrgIdForWrite(auth, 'org-B');
    expect(result.orgId).toBe('org-B');
  });
});

describe('executableRuleSchema', () => {
  it('accepts a fully-populated executable rule', () => {
    const parsed = executableRuleSchema.parse({
      name: 'Adobe Reader',
      sha256: 'a'.repeat(64),
      signer: 'Adobe Inc.',
      publisher: 'Adobe Systems Incorporated',
      pathGlob: 'C:\\Program Files\\Adobe\\**\\*.exe',
    });
    expect(parsed.name).toBe('Adobe Reader');
  });

  it('rejects sha256 that is not 64 hex chars', () => {
    expect(() => executableRuleSchema.parse({ name: 'X', sha256: 'not-a-hash' })).toThrow();
    expect(() => executableRuleSchema.parse({ name: 'X', sha256: 'a'.repeat(63) })).toThrow();
  });

  it('accepts uppercase sha256 (case-insensitive regex)', () => {
    expect(() => executableRuleSchema.parse({ name: 'X', sha256: 'A'.repeat(64) })).not.toThrow();
  });

  it('enforces caps on signer / publisher / pathGlob', () => {
    expect(() => executableRuleSchema.parse({ name: 'X', signer: 'a'.repeat(256) })).toThrow();
    expect(() => executableRuleSchema.parse({ name: 'X', publisher: 'a'.repeat(256) })).toThrow();
    expect(() => executableRuleSchema.parse({ name: 'X', pathGlob: 'a'.repeat(501) })).toThrow();
  });
});

describe('softwareRulesSchema — PAM-only / inventory-only / mixed', () => {
  it('accepts a PAM-only policy (executable[] populated, no software[])', () => {
    const parsed = softwareRulesSchema.parse({
      executable: [{ name: 'Adobe Reader', sha256: 'a'.repeat(64) }],
    });
    expect(parsed.executable).toHaveLength(1);
    expect(parsed.software).toBeUndefined();
  });

  it('accepts an inventory-only policy', () => {
    const parsed = softwareRulesSchema.parse({
      software: [{ name: 'Firefox' }],
    });
    expect(parsed.software).toHaveLength(1);
    expect(parsed.executable).toBeUndefined();
  });

  it('accepts a mixed policy', () => {
    const parsed = softwareRulesSchema.parse({
      software: [{ name: 'Firefox' }],
      executable: [{ name: 'Adobe', sha256: 'a'.repeat(64) }],
    });
    expect(parsed.software).toHaveLength(1);
    expect(parsed.executable).toHaveLength(1);
  });

  it('rejects a policy with neither software[] nor executable[]', () => {
    expect(() => softwareRulesSchema.parse({})).toThrow();
    expect(() => softwareRulesSchema.parse({ software: [], executable: [] })).toThrow();
  });

  it('PAM-only payload round-trips through validator + normalizer without losing executable[]', () => {
    // This is the regression Todd flagged: the previous schema stripped
    // `executable` because it was not defined on the Zod object. The
    // PAM bridge then loaded policies whose `executable[]` was always
    // undefined → always {match: null} in production.
    const payload = {
      executable: [{ name: 'Adobe Reader', sha256: 'a'.repeat(64), signer: 'Adobe Inc.' }],
    };
    const validated = softwareRulesSchema.parse(payload);
    const normalized = normalizeSoftwarePolicyRules(validated);
    expect(normalized.executable).toBeDefined();
    expect(normalized.executable).toHaveLength(1);
    expect(normalized.executable?.[0]?.name).toBe('Adobe Reader');
    expect(normalized.executable?.[0]?.sha256).toBe('a'.repeat(64));
    expect(normalized.executable?.[0]?.signer).toBe('Adobe Inc.');
    expect(normalized.software).toEqual([]);
  });
});

// ───────────────── POST /:id/remediate — site scope ─────────────────
// A site-restricted org user (permissions.allowedSiteIds set) triggers
// remediation actions ON target devices. Site is an app-layer-only authz
// axis — Postgres RLS does NOT defend it — so a site-restricted caller must
// not remediate devices in sites outside their allowlist, whether named
// explicitly via body.deviceIds or selected implicitly from violations.
describe('POST /:id/remediate — site scope', () => {
  const ORG_ID = '11111111-1111-1111-1111-111111111111';
  const POLICY_ID = '22222222-2222-2222-2222-222222222222';
  const SITE_ALLOWED = 'aaaaaaaa-0000-0000-0000-000000000001';
  const SITE_DENIED = 'bbbbbbbb-0000-0000-0000-000000000002';
  const DEVICE_ALLOWED = '33333333-3333-3333-3333-333333333333';
  const DEVICE_DENIED = '55555555-5555-5555-5555-555555555555';

  let app: Hono;

  function setAuth(allowedSiteIds?: string[]) {
    vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
      c.set('auth', {
        scope: 'organization',
        orgId: ORG_ID,
        accessibleOrgIds: [ORG_ID],
        canAccessOrg: (orgId: string) => orgId === ORG_ID,
        orgCondition: () => undefined,
        user: { id: 'user-123', email: 'test@example.com' },
      });
      if (allowedSiteIds) c.set('permissions', { allowedSiteIds });
      return next();
    });
  }

  // Mocks the policy lookup that getPolicyWithAccess runs first.
  function mockPolicyLookup() {
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([
            { id: POLICY_ID, orgId: ORG_ID, mode: 'blocklist', name: 'Block X' },
          ]),
        }),
      }),
    } as any);
  }

  // Mocks the site-resolution select (org devices) that a restricted caller
  // runs after the policy lookup: db.select({id, siteId}).from(devices).where(...)
  function mockSiteResolution(rows: Array<{ id: string; siteId: string | null }>) {
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(rows),
      }),
    } as any);
  }

  // Mocks the explicit-deviceIds resolution select:
  // db.select({id}).from(devices).where(...)
  function mockExplicitDeviceSelect(rows: Array<{ id: string }>) {
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(rows),
      }),
    } as any);
  }

  // Mocks the implicit violations select:
  // db.select({deviceId}).from(softwareComplianceStatus).innerJoin(devices).where(...).limit(...)
  function mockViolationsSelect(rows: Array<{ deviceId: string }>) {
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue(rows),
          }),
        }),
      }),
    } as any);
  }

  // The compliance-status UPDATE the route runs after scheduling.
  function mockComplianceUpdate() {
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    } as any);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(scheduleSoftwareRemediation).mockResolvedValue(1 as any);
    mockComplianceUpdate();
    app = new Hono();
    app.route('/software-policies', softwarePoliciesRoutes);
  });

  it('denies the batch when an explicit deviceId is outside the caller site allowlist (403)', async () => {
    setAuth([SITE_ALLOWED]);
    mockPolicyLookup();
    // Site resolution: only DEVICE_ALLOWED is in-scope.
    mockSiteResolution([
      { id: DEVICE_ALLOWED, siteId: SITE_ALLOWED },
      { id: DEVICE_DENIED, siteId: SITE_DENIED },
    ]);

    const res = await app.request(`/software-policies/${POLICY_ID}/remediate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceIds: [DEVICE_ALLOWED, DEVICE_DENIED] }),
    });

    expect(res.status).toBe(403);
    expect(vi.mocked(scheduleSoftwareRemediation)).not.toHaveBeenCalled();
  });

  it('narrows implicit remediation to in-scope devices for a restricted caller', async () => {
    setAuth([SITE_ALLOWED]);
    mockPolicyLookup();
    mockSiteResolution([
      { id: DEVICE_ALLOWED, siteId: SITE_ALLOWED },
      { id: DEVICE_DENIED, siteId: SITE_DENIED },
    ]);
    // Implicit violations query — the route must have narrowed it to in-scope
    // devices, so only DEVICE_ALLOWED comes back.
    mockViolationsSelect([{ deviceId: DEVICE_ALLOWED }]);

    const res = await app.request(`/software-policies/${POLICY_ID}/remediate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    expect(vi.mocked(scheduleSoftwareRemediation)).toHaveBeenCalledTimes(1);
    const targeted = vi.mocked(scheduleSoftwareRemediation).mock.calls[0]![1];
    expect(targeted).toEqual([DEVICE_ALLOWED]);
    expect(targeted).not.toContain(DEVICE_DENIED);
  });

  it('allows an explicit in-scope deviceId for a restricted caller', async () => {
    setAuth([SITE_ALLOWED]);
    mockPolicyLookup();
    mockSiteResolution([{ id: DEVICE_ALLOWED, siteId: SITE_ALLOWED }]);
    mockExplicitDeviceSelect([{ id: DEVICE_ALLOWED }]);

    const res = await app.request(`/software-policies/${POLICY_ID}/remediate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceIds: [DEVICE_ALLOWED] }),
    });

    expect(res.status).toBe(200);
    expect(vi.mocked(scheduleSoftwareRemediation)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(scheduleSoftwareRemediation).mock.calls[0]![1]).toEqual([DEVICE_ALLOWED]);
  });

  it('does not narrow for an unrestricted caller (no allowedSiteIds)', async () => {
    // No permissions set — NO site-resolution select runs; only the policy
    // lookup + the implicit violations query.
    setAuth();
    mockPolicyLookup();
    mockViolationsSelect([{ deviceId: DEVICE_ALLOWED }, { deviceId: DEVICE_DENIED }]);

    const res = await app.request(`/software-policies/${POLICY_ID}/remediate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    expect(vi.mocked(scheduleSoftwareRemediation)).toHaveBeenCalledTimes(1);
    const targeted = vi.mocked(scheduleSoftwareRemediation).mock.calls[0]![1];
    expect(targeted).toEqual(expect.arrayContaining([DEVICE_ALLOWED, DEVICE_DENIED]));
  });
});

// ───────────────── GET /violations — site scope ─────────────────
describe('GET /violations — site scope', () => {
  const ORG_ID = '11111111-1111-1111-1111-111111111111';
  const SITE_ALLOWED = 'aaaaaaaa-0000-0000-0000-000000000001';
  const SITE_DENIED = 'bbbbbbbb-0000-0000-0000-000000000002';
  const DEVICE_ALLOWED = '33333333-3333-3333-3333-333333333333';
  const DEVICE_DENIED = '55555555-5555-5555-5555-555555555555';

  let app: Hono;

  function dumpSql(value: unknown, seen = new WeakSet<object>()): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (typeof value === 'function') return '';
    if (typeof value !== 'object') return String(value);
    if (seen.has(value)) return '';
    seen.add(value);

    const parts: string[] = [value.constructor?.name ?? 'Object'];
    for (const key of Reflect.ownKeys(value)) {
      const prop = (value as Record<PropertyKey, unknown>)[key];
      parts.push(String(key), dumpSql(prop, seen));
    }
    return parts.join(' ');
  }

  function setAuth(allowedSiteIds?: string[]) {
    vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
      c.set('auth', {
        scope: 'organization',
        orgId: ORG_ID,
        accessibleOrgIds: [ORG_ID],
        canAccessOrg: (orgId: string) => orgId === ORG_ID,
        orgCondition: () => undefined,
        user: { id: 'user-123', email: 'test@example.com' },
      });
      if (allowedSiteIds) c.set('permissions', { allowedSiteIds });
      return next();
    });
  }

  function mockSiteResolution(rows: Array<{ id: string; siteId: string | null }>) {
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(rows),
      }),
    } as any);
  }

  function mockViolationsSelect(rows: any[], whereArgs: unknown[]) {
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn((where) => {
            whereArgs.push(where);
            return {
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue(rows),
              }),
            };
          }),
        }),
      }),
    } as any);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    setAuth();
    app = new Hono();
    app.route('/software-policies', softwarePoliciesRoutes);
  });

  it('returns 403 when an explicit deviceId is outside the caller site allowlist', async () => {
    setAuth([SITE_ALLOWED]);
    mockSiteResolution([
      { id: DEVICE_ALLOWED, siteId: SITE_ALLOWED },
      { id: DEVICE_DENIED, siteId: SITE_DENIED },
    ]);

    const res = await app.request(`/software-policies/violations?deviceId=${DEVICE_DENIED}`, {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Device not found or access denied' });
  });

  it('narrows violation list reads to allowed sites for a restricted caller', async () => {
    setAuth([SITE_ALLOWED]);
    mockSiteResolution([
      { id: DEVICE_ALLOWED, siteId: SITE_ALLOWED },
      { id: DEVICE_DENIED, siteId: SITE_DENIED },
    ]);
    const whereArgs: unknown[] = [];
    mockViolationsSelect([
      {
        device: { id: DEVICE_ALLOWED, hostname: 'allowed-device' },
        compliance: { id: 'compliance-1', status: 'violation' },
      },
    ], whereArgs);

    const res = await app.request('/software-policies/violations', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    expect((await res.json()).total).toBe(1);
    expect(whereArgs).toHaveLength(1);
    const rendered = dumpSql(whereArgs[0]);
    expect(rendered).toContain('devices.siteId');
    expect(rendered).toContain(SITE_ALLOWED);
    expect(rendered).not.toContain(SITE_DENIED);
  });

  it('keeps unrestricted violation reads unchanged with no site predicate', async () => {
    const whereArgs: unknown[] = [];
    mockViolationsSelect([
      { device: { id: DEVICE_ALLOWED }, compliance: { id: 'compliance-1' } },
      { device: { id: DEVICE_DENIED }, compliance: { id: 'compliance-2' } },
    ], whereArgs);

    const res = await app.request('/software-policies/violations', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    expect((await res.json()).total).toBe(2);
    expect(whereArgs).toHaveLength(1);
    expect(dumpSql(whereArgs[0])).not.toContain('devices.siteId');
  });
});
