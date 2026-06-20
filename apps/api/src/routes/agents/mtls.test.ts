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

vi.mock('../../middleware/agentAuth', () => ({
  matchAgentTokenHash: vi.fn(() => ({ mode: 'primary' })),
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

vi.mock('../../services/tenantStatus', () => ({
  isAgentTenantActive: vi.fn(async () => true),
}));

// Use the real rate-limit helper with the stub above.

// -------------------------------------------------------------------
// Imports (after mocks)
// -------------------------------------------------------------------

import { mtlsRoutes } from './mtls';
import { terminateDeviceRemoteSessions } from '../../services/remoteSessionTeardown';
import { isAgentTenantActive } from '../../services/tenantStatus';

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

function mockDbUpdateOk() {
  dbUpdateMock.mockReturnValue({
    set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
  } as any);
}

describe('POST /renew-cert — E4 per-device cooldown', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisState.clear();
    issueCertMock.mockReset();
    revokeCertMock.mockReset();
    mockDbUpdateOk();
    vi.mocked(isAgentTenantActive).mockResolvedValue(true);
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

  it('rejects inactive tenants before issuing a certificate', async () => {
    vi.mocked(isAgentTenantActive).mockResolvedValue(false);
    mockDeviceLookup({
      id: DEVICE_ID,
      orgId: ORG_ID,
      agentId: AGENT_ID,
      hostname: 'host-1',
      status: 'online',
      agentTokenHash: TOKEN_HASH,
      previousTokenHash: null,
      previousTokenExpiresAt: null,
      agentTokenSuspendedAt: null,
      mtlsCertExpiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
      mtlsCertCfId: null,
    });

    const resp = await buildApp().request('/agents/renew-cert', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });

    expect(resp.status).toBe(401);
    expect(issueCertMock).not.toHaveBeenCalled();
    expect(isAgentTenantActive).toHaveBeenCalledWith(ORG_ID);
  });
});

describe('remote-session teardown wiring on quarantine / deny', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisState.clear();
    issueCertMock.mockReset();
    revokeCertMock.mockReset();
    mockDbUpdateOk();
    vi.mocked(isAgentTenantActive).mockResolvedValue(true);
  });

  it('POST /renew-cert quarantine branch tears down live remote sessions', async () => {
    // Expired cert + org expiredCertPolicy 'quarantine' (the getOrgMtlsSettings
    // mock default) drives the renew handler into the quarantine branch, which
    // must cut any in-flight desktop/terminal session to the now-isolated
    // device. Dropping that call silently leaves live control running.
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
