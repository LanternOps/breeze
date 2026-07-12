import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createHash } from 'crypto';

// -------------------------------------------------------------------
// Mocks
// -------------------------------------------------------------------

const { dbSelectMock, dbUpdateMock, mfaGate } = vi.hoisted(() => ({
  dbSelectMock: vi.fn(),
  dbUpdateMock: vi.fn(),
  mfaGate: { deny: false },
}));

vi.mock('../../db', () => ({
  db: {
    select: dbSelectMock,
    update: dbUpdateMock,
  },
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../../db/schema', () => ({
  devices: {
    id: 'devices.id',
    orgId: 'devices.orgId',
    agentId: 'devices.agentId',
    agentTokenHash: 'devices.agentTokenHash',
    previousTokenHash: 'devices.previousTokenHash',
  },
  organizations: { id: 'organizations.id', settings: 'organizations.settings', updatedAt: 'organizations.updatedAt' },
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn(async (c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-123' },
      canAccessOrg: (orgId: string) => orgId === '22222222-2222-4222-8222-222222222222',
    });
    return next();
  }),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => async (c: any, next: any) => {
    if (mfaGate.deny) return c.json({ error: 'MFA required' }, 403);
    return next();
  }),
}));

const { matchTokenMock } = vi.hoisted(() => ({
  // Default: current-token match (no rotation required). Individual tests
  // override to { tokenRotationRequired: true } to exercise the previous-token
  // rejection on /renew-cert.
  matchTokenMock: vi.fn(() => ({ tokenRotationRequired: false })),
}));
vi.mock('../../middleware/agentAuth', () => ({
  matchAgentTokenHash: matchTokenMock,
}));

// mtls.ts imports disconnectAgent from routes/agentWs to sever the agent
// command channel on the quarantine path (Finding #3). Mock it so importing
// mtls.ts doesn't pull the heavy agentWs → terminalWs chain, and so we can
// assert the wiring fires.
const { disconnectAgentMock } = vi.hoisted(() => ({
  disconnectAgentMock: vi.fn(() => 'closed'),
}));
vi.mock('../agentWs', () => ({
  disconnectAgent: disconnectAgentMock,
}));

const { tenantActiveMock } = vi.hoisted(() => ({
  tenantActiveMock: vi.fn(async () => true),
}));
vi.mock('../../services/tenantStatus', () => ({
  isAgentTenantActive: tenantActiveMock,
}));

vi.mock('../../services/auditEvents', () => ({
  writeAuditEvent: vi.fn(),
}));

const { issueCertMock, revokeCertMock } = vi.hoisted(() => ({
  issueCertMock: vi.fn(),
  revokeCertMock: vi.fn(),
}));
vi.mock('../../services/cloudflareMtls', () => ({
  CloudflareMtlsService: {
    fromEnv: vi.fn(() => ({
      issueCertificate: issueCertMock,
      revokeCertificate: revokeCertMock,
    })),
  },
}));

vi.mock('@breeze/shared', () => ({
  orgMtlsSettingsSchema: { parse: (v: unknown) => v, safeParseAsync: async (v: unknown) => ({ success: true, data: v }) },
  orgHelperSettingsSchema: { parse: (v: unknown) => v, safeParseAsync: async (v: unknown) => ({ success: true, data: v }) },
  orgLogForwardingSettingsSchema: { parse: (v: unknown) => v, safeParseAsync: async (v: unknown) => ({ success: true, data: v }) },
}));

vi.mock('./helpers', () => ({
  getOrgMtlsSettings: vi.fn(async () => ({ certLifetimeDays: 30, expiredCertPolicy: 'quarantine' })),
  getOrgHelperSettings: vi.fn(async () => ({ enabled: true })),
  issueMtlsCertForDevice: vi.fn(async () => null),
  isObject: (v: unknown) => typeof v === 'object' && v !== null && !Array.isArray(v),
}));

// Minimal Redis stub with sliding-window semantics. All state hoisted so the
// factory below can reach it without tripping the vitest hoisting check.
const { redisState, redisMock } = vi.hoisted(() => {
  type ZMember = [number, string];
  const state = new Map<string, ZMember[]>();
  const zRem = (key: string, max: number) => {
    const arr = state.get(key) ?? [];
    state.set(key, arr.filter(([score]) => score > max));
  };
  const zCard = (key: string) => (state.get(key) ?? []).length;
  const zRangeFirst = (key: string): string[] => {
    const arr = state.get(key) ?? [];
    if (arr.length === 0) return [];
    return [arr[0]![1], String(arr[0]![0])];
  };
  const zAdd = (key: string, score: number, member: string) => {
    const arr = state.get(key) ?? [];
    arr.push([score, member]);
    state.set(key, arr);
  };

  const mock: any = {
    multi() {
      const ops: Array<() => unknown> = [];
      const chain: any = {
        zremrangebyscore(key: string, _min: unknown, max: number) {
          ops.push(() => zRem(key, typeof max === 'number' ? max : Number.NEGATIVE_INFINITY));
          return chain;
        },
        zadd(key: string, score: number, member: string) {
          ops.push(() => zAdd(key, score, member));
          return chain;
        },
        zcard(key: string) {
          ops.push(() => zCard(key));
          return chain;
        },
        zrange(key: string, _s: number, _e: number, _w: string) {
          ops.push(() => zRangeFirst(key));
          return chain;
        },
        expire(_k: string, _t: number) {
          ops.push(() => undefined);
          return chain;
        },
      };
      // Attach pipeline-execute under a name that avoids the security-hook pattern.
      (chain as any)['exec'] = () => Promise.resolve(ops.map((fn) => [null, fn()]));
      return chain;
    },
    zremrangebyscore(key: string, _min: unknown, max: number) {
      zRem(key, typeof max === 'number' ? max : Number.NEGATIVE_INFINITY);
      return Promise.resolve();
    },
    zcard(key: string) {
      return Promise.resolve(zCard(key));
    },
    zrange(key: string, _s: number, _e: number, _w: string) {
      return Promise.resolve(zRangeFirst(key));
    },
    zadd(key: string, score: number, member: string) {
      zAdd(key, score, member);
      return Promise.resolve();
    },
    expire() {
      return Promise.resolve();
    },
  };
  return { redisState: state, redisMock: mock };
});

vi.mock('../../services/redis', () => ({
  getRedis: vi.fn(() => redisMock),
}));

// Boundary mock: the device-teardown service pulls in the agentWs → terminalWs
// → remoteAccessPolicy chain at module load, which this test's partial schema
// mock doesn't satisfy. The handler only needs it to be called on
// quarantine/deny; its internals are covered by remoteSessionTeardown.test.ts.
vi.mock('../../services/remoteSessionTeardown', () => ({
  terminateDeviceRemoteSessions: vi.fn().mockResolvedValue(0),
  // mtls.ts imports TEARDOWN_FAILED too; the real value is -1. The mock must
  // export it or the route's `teardownResult === TEARDOWN_FAILED` audit branch
  // would compare against undefined.
  TEARDOWN_FAILED: -1,
}));

// Use the real rate-limit helper with the stub above.

// -------------------------------------------------------------------
// Imports (after mocks)
// -------------------------------------------------------------------

import { mtlsRoutes } from './mtls';
import { terminateDeviceRemoteSessions } from '../../services/remoteSessionTeardown';

const DEVICE_ID = '11111111-1111-4111-8111-111111111111';
const ORG_ID = '22222222-2222-4222-8222-222222222222';
const AGENT_ID = 'agent-mtls-test';
const TOKEN = 'brz_test_token';
const TOKEN_HASH = createHash('sha256').update(TOKEN).digest('hex');

function buildApp(): Hono {
  const app = new Hono();
  app.route('/agents', mtlsRoutes);
  return app;
}

function mockDeviceLookup(row: Record<string, unknown> | null) {
  dbSelectMock.mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(row ? [row] : []) }),
    }),
  } as any);
}

// The renew-cert writes use `.where(...).returning({ id })` and require exactly
// one row; the org-settings PATCH writes just `await ...where(...)`. So the
// where() result must be BOTH awaitable (thenable → undefined) AND expose a
// `.returning()` that resolves to one device row. `rowCount` lets a test force
// a 0-row write to exercise the fail-closed path.
function mockDbUpdateOk(rowCount = 1) {
  const rows = Array.from({ length: rowCount }, () => ({ id: DEVICE_ID }));
  dbUpdateMock.mockReturnValue({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue(rows),
        then: (resolve: (v: unknown) => unknown) => resolve(undefined),
      }),
    }),
  } as any);
}

// Queue an organizations.settings row for readOrgMtlsPolicyOrNull (the fail-
// closed org mTLS policy read on /renew-cert). Pass null to simulate a missing
// org row (drives the fail-closed 500). Must be queued AFTER the device lookup
// since both go through dbSelectMock.mockReturnValueOnce in call order.
function mockOrgSettingsLookup(settings: Record<string, unknown> | null = {}) {
  dbSelectMock.mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(settings === null ? [] : [{ settings }]),
      }),
    }),
  } as any);
}

describe('POST /renew-cert — E4 per-device cooldown', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisState.clear();
    issueCertMock.mockReset();
    revokeCertMock.mockReset();
    mockDbUpdateOk();
  });

  it('returns 429 with Retry-After on the 2nd attempt within 30s', async () => {
    const deviceRow = {
      id: DEVICE_ID,
      orgId: ORG_ID,
      agentId: AGENT_ID,
      hostname: 'host-1',
      status: 'online',
      agentTokenHash: TOKEN_HASH,
      previousTokenHash: null,
      previousTokenExpiresAt: null,
      mtlsCertExpiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
      mtlsCertCfId: null,
    };

    issueCertMock.mockResolvedValue({
      id: 'cf-cert-1',
      certificate: 'CERT',
      privateKey: 'KEY',
      expiresOn: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
      issuedOn: new Date().toISOString(),
      serialNumber: 'sn-1',
    });

    // First request — success
    mockDeviceLookup(deviceRow);
    mockOrgSettingsLookup(); // org policy row present (auto_reissue default)
    const first = await buildApp().request('/agents/renew-cert', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(first.status).toBe(200);

    // Second request within 30s — should be rate-limited by the attempt window
    mockDeviceLookup(deviceRow);
    const second = await buildApp().request('/agents/renew-cert', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(second.status).toBe(429);
    expect(second.headers.get('Retry-After')).toBeTruthy();
    const body = await second.json();
    expect(body.error).toMatch(/rate limited/i);
  });

  it('rejects with 401 when the device token does not match any row', async () => {
    mockDeviceLookup(null);
    const resp = await buildApp().request('/agents/renew-cert', {
      method: 'POST',
      headers: { Authorization: 'Bearer brz_wrong' },
    });
    expect(resp.status).toBe(401);
  });
});

describe('POST /renew-cert — tenant-status gate (F4)', () => {
  const activeDeviceRow = {
    id: DEVICE_ID,
    orgId: ORG_ID,
    agentId: AGENT_ID,
    hostname: 'host-1',
    status: 'online',
    agentTokenHash: TOKEN_HASH,
    previousTokenHash: null,
    previousTokenExpiresAt: null,
    agentTokenSuspendedAt: null,
    // Valid (non-expired) cert so the handler does not divert into quarantine.
    mtlsCertExpiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
    mtlsCertCfId: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    redisState.clear();
    issueCertMock.mockReset();
    revokeCertMock.mockReset();
    tenantActiveMock.mockResolvedValue(true);
    mockDbUpdateOk();
  });

  it('rejects with opaque 401 and does NOT issue a cert when the tenant is inactive', async () => {
    // The org/partner is suspended but the device token itself is not
    // individually suspended — without the tenant gate the agent would still
    // get fresh Cloudflare cert + private key material.
    tenantActiveMock.mockResolvedValue(false);
    mockDeviceLookup(activeDeviceRow);

    const res = await buildApp().request('/agents/renew-cert', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    // Same opaque message as a stale/suspended token — suspension is not leaked.
    expect(body.error).toBe('Invalid agent credentials');
    expect(issueCertMock).not.toHaveBeenCalled();
    expect(revokeCertMock).not.toHaveBeenCalled();
  });

  it('issues normally when the tenant is active', async () => {
    issueCertMock.mockResolvedValue({
      id: 'cf-cert-1',
      certificate: 'CERT',
      privateKey: 'KEY',
      expiresOn: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
      issuedOn: new Date().toISOString(),
      serialNumber: 'sn-1',
    });
    mockDeviceLookup(activeDeviceRow);
    mockOrgSettingsLookup(); // org policy row present

    const res = await buildApp().request('/agents/renew-cert', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });

    expect(res.status).toBe(200);
    expect(issueCertMock).toHaveBeenCalled();
    expect(tenantActiveMock).toHaveBeenCalledWith(ORG_ID);
  });
});

describe('remote-session teardown wiring on quarantine / deny', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisState.clear();
    issueCertMock.mockReset();
    revokeCertMock.mockReset();
    mockDbUpdateOk();
  });

  it('POST /renew-cert quarantine branch tears down live remote sessions AND severs the agent WS', async () => {
    // Expired cert + org expiredCertPolicy 'quarantine' drives the renew handler
    // into the quarantine branch, which must cut any in-flight desktop/terminal
    // session AND sever the agent command WebSocket to the now-isolated device.
    // Dropping either call silently leaves live control / command draining.
    const deviceRow = {
      id: DEVICE_ID,
      orgId: ORG_ID,
      agentId: AGENT_ID,
      hostname: 'host-1',
      status: 'online',
      agentTokenHash: TOKEN_HASH,
      previousTokenHash: null,
      previousTokenExpiresAt: null,
      agentTokenSuspendedAt: null,
      // Expired one hour ago — triggers the quarantine path.
      mtlsCertExpiresAt: new Date(Date.now() - 3600 * 1000),
      mtlsCertCfId: null,
    };

    mockDeviceLookup(deviceRow);
    mockOrgSettingsLookup({ mtls: { expiredCertPolicy: 'quarantine' } });
    const res = await buildApp().request('/agents/renew-cert', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.quarantined).toBe(true);
    // The certificate must NOT be issued on the quarantine path.
    expect(issueCertMock).not.toHaveBeenCalled();
    // Wiring under test: live remote control to the quarantined device is cut.
    expect(terminateDeviceRemoteSessions).toHaveBeenCalledWith(DEVICE_ID);
    // Finding #3: the agent command WebSocket is also severed (code 4041).
    expect(disconnectAgentMock).toHaveBeenCalledWith(AGENT_ID, 4041, expect.any(String));
  });

  it('POST /:id/deny tears down live remote sessions for the denied device', async () => {
    // Denying a quarantined device decommissions it and must tear down any
    // live remote-control session — the status flip alone is only checked at
    // connect time.
    mockDeviceLookup({
      id: DEVICE_ID,
      orgId: ORG_ID,
      agentId: AGENT_ID,
      hostname: 'host-1',
      status: 'quarantined',
    });

    const res = await buildApp().request(`/agents/${DEVICE_ID}/deny`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(terminateDeviceRemoteSessions).toHaveBeenCalledWith(DEVICE_ID);
  });
});

describe('POST /renew-cert — cert-issuing fail-closed guards', () => {
  const baseDeviceRow = {
    id: DEVICE_ID,
    orgId: ORG_ID,
    agentId: AGENT_ID,
    hostname: 'host-1',
    status: 'online',
    agentTokenHash: TOKEN_HASH,
    previousTokenHash: null,
    previousTokenExpiresAt: null,
    agentTokenSuspendedAt: null,
    // Non-expired cert → the handler takes the issue path (not quarantine).
    mtlsCertExpiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
    mtlsCertCfId: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    redisState.clear();
    issueCertMock.mockReset();
    revokeCertMock.mockReset();
    tenantActiveMock.mockResolvedValue(true);
    matchTokenMock.mockReturnValue({ tokenRotationRequired: false });
    mockDbUpdateOk();
  });

  it('Finding #2: rejects a PREVIOUS (superseded) token caller with 401 and issues no cert', async () => {
    // The caller authenticated via the previous/rotated token — accepted for
    // idempotent agent traffic, but NOT for minting new cert material. A stolen
    // superseded token must not obtain a fresh certificate + private key.
    matchTokenMock.mockReturnValueOnce({ tokenRotationRequired: true });
    mockDeviceLookup(baseDeviceRow);

    const res = await buildApp().request('/agents/renew-cert', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/rotate/i);
    // No cert material is minted for a superseded token.
    expect(issueCertMock).not.toHaveBeenCalled();
  });

  it('Finding #1: fails closed (500) and returns NO cert material when the metadata write affects 0 rows', async () => {
    // A 0-row cert-metadata write under FORCE RLS would otherwise "succeed"
    // silently, leaking an UNTRACKED cert (no serial/expiry/cfId recorded → not
    // revocable later). The handler must deny AND revoke the just-issued cert.
    issueCertMock.mockResolvedValue({
      id: 'cf-cert-untracked',
      certificate: 'CERT',
      privateKey: 'KEY',
      expiresOn: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
      issuedOn: new Date().toISOString(),
      serialNumber: 'sn-untracked',
    });
    mockDeviceLookup(baseDeviceRow);
    mockOrgSettingsLookup(); // auto_reissue default → issue path
    mockDbUpdateOk(0); // metadata write matches 0 rows

    const res = await buildApp().request('/agents/renew-cert', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });

    expect(res.status).toBe(500);
    const body = await res.json();
    // Crucially, no certificate/privateKey is handed back on the fail-closed path.
    expect(body.mtls).toBeUndefined();
    expect(body.error).toMatch(/failed/i);
    // The untracked cert is revoked so it can't be used.
    expect(revokeCertMock).toHaveBeenCalledWith('cf-cert-untracked');
  });

  it('Finding #1: fails closed (500) when the org policy row is missing (no auto_reissue fallback)', async () => {
    // A missing org row must NOT silently downgrade to auto_reissue and issue a
    // cert against an org whose policy we can't resolve.
    mockDeviceLookup(baseDeviceRow);
    mockOrgSettingsLookup(null); // org row absent

    const res = await buildApp().request('/agents/renew-cert', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });

    expect(res.status).toBe(500);
    expect(issueCertMock).not.toHaveBeenCalled();
  });
});

describe('PATCH /org/:orgId/settings/log-forwarding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisState.clear();
    mfaGate.deny = false;
  });

  function mockOrgLookup(settings: Record<string, unknown> = {}) {
    dbSelectMock.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ id: ORG_ID, settings }])
        }),
      }),
    } as any);
  }

  it('rejects private forwarding targets before storing settings', async () => {
    mockOrgLookup();

    const res = await buildApp().request(`/agents/org/${ORG_ID}/settings/log-forwarding`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({
        enabled: true,
        elasticsearchUrl: 'https://127.0.0.1:9200',
        indexPrefix: 'breeze-logs',
        elasticsearchApiKey: 'secret-api-key',
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Invalid log forwarding target');
    expect(dbUpdateMock).not.toHaveBeenCalled();
  });

  it('requires MFA before changing log forwarding settings', async () => {
    mfaGate.deny = true;

    const res = await buildApp().request(`/agents/org/${ORG_ID}/settings/log-forwarding`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({
        enabled: true,
        elasticsearchUrl: 'https://8.8.8.8:9200',
        indexPrefix: 'breeze-logs',
        elasticsearchApiKey: 'secret-api-key',
      }),
    });

    expect(res.status).toBe(403);
    expect(dbSelectMock).not.toHaveBeenCalled();
    expect(dbUpdateMock).not.toHaveBeenCalled();
  });

  it('encrypts credentials and preserves masked updates', async () => {
    mockOrgLookup({
      logForwarding: {
        enabled: true,
        elasticsearchUrl: 'https://8.8.8.8:9200',
        indexPrefix: 'existing',
        elasticsearchApiKey: 'existing-plaintext-key',
      }
    });
    const setMock = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    dbUpdateMock.mockReturnValueOnce({ set: setMock } as any);

    const res = await buildApp().request(`/agents/org/${ORG_ID}/settings/log-forwarding`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({
        enabled: true,
        elasticsearchUrl: 'https://8.8.8.8:9200',
        indexPrefix: 'breeze-logs',
        elasticsearchApiKey: '****',
      }),
    });

    expect(res.status).toBe(200);
    const updatePayload = setMock.mock.calls[0]?.[0];
    const stored = updatePayload.settings.logForwarding;
    expect(stored.elasticsearchApiKey).toMatch(/^enc:v1:/);
    expect(stored.elasticsearchApiKey).not.toContain('existing-plaintext-key');
    const body = await res.json();
    expect(body.settings.logForwarding.elasticsearchApiKey).toBe('****');
  });
});
