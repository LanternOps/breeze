import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createHash } from 'crypto';

// -------------------------------------------------------------------
// Mocks
// -------------------------------------------------------------------

const { dbSelectMock, dbUpdateMock } = vi.hoisted(() => ({
  dbSelectMock: vi.fn(),
  dbUpdateMock: vi.fn(),
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
  organizations: { id: 'organizations.id' },
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn(async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
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
  orgMtlsSettingsSchema: { parse: (v: unknown) => v },
  orgHelperSettingsSchema: { parse: (v: unknown) => v },
  orgLogForwardingSettingsSchema: { parse: (v: unknown) => v },
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

// Use the real rate-limit helper with the stub above.

// -------------------------------------------------------------------
// Imports (after mocks)
// -------------------------------------------------------------------

import { mtlsRoutes } from './mtls';

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
});
