import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
  },
  withDbAccessContext: vi.fn(async (_context: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db/schema', () => ({
  devices: {
    id: 'id',
    agentId: 'agentId',
    orgId: 'orgId',
    siteId: 'siteId',
    agentTokenHash: 'agentTokenHash',
    previousTokenHash: 'previousTokenHash',
    previousTokenExpiresAt: 'previousTokenExpiresAt',
    watchdogTokenHash: 'watchdogTokenHash',
    previousWatchdogTokenHash: 'previousWatchdogTokenHash',
    previousWatchdogTokenExpiresAt: 'previousWatchdogTokenExpiresAt',
    status: 'status',
    agentTokenSuspendedAt: 'agentTokenSuspendedAt',
    agentTokenSuspendedReason: 'agentTokenSuspendedReason',
    hostname: 'hostname',
    lastSeenIp: 'lastSeenIp',
    mtlsCertSerialNumber: 'mtlsCertSerialNumber',
  },
  // Security remediation Wave 5, Task 6 — services/agentCertificateBinding.ts
  // (imported transitively via agentAuthMiddleware) reads this table.
  deviceMtlsCertificates: {
    deviceId: 'deviceMtlsCertificates.deviceId',
    state: 'deviceMtlsCertificates.state',
    serialNumber: 'deviceMtlsCertificates.serialNumber',
    createdAt: 'deviceMtlsCertificates.createdAt',
  },
}));

vi.mock('../services', () => ({
  getRedis: vi.fn(),
  rateLimiter: vi.fn(),
}));

vi.mock('../services/auditService', () => ({
  createAuditLogAsync: vi.fn(async () => undefined),
}));

// Partial mock: only the IP SOURCE is stubbed. rateLimitIpKey (the IPv6 /64
// bucket folding used to build limiter keys) is kept REAL so the test exercises
// the same key the production path produces.
vi.mock('../services/clientIp', async (importOriginal) => ({
  rateLimitIpKey: (await importOriginal<typeof import('../services/clientIp')>()).rateLimitIpKey,
  getTrustedClientIp: vi.fn(() => 'unknown'),
  // Security remediation Wave 5, Task 6 — agentAuthMiddleware now calls
  // readAgentCertificateAssertion (services/agentCertificateBinding.ts),
  // which reads this. Defaults to untrusted; individual binding tests
  // override via vi.mocked(trustsForwardedHeadersFrom).
  trustsForwardedHeadersFrom: vi.fn(() => false),
}));

vi.mock('../services/tenantStatus', () => ({
  getAgentTenantState: vi.fn(async () => 'active'),
}));

// #3986 — the device-remove drain predicate. Mocked here because this suite
// runs against a fully faked drizzle surface: the predicate's OWN semantics
// (the `device_remove` reason clause, the unexpired-deadline clause, and the
// fact that an abuse-queued reason-less self_uninstall does NOT satisfy it)
// are proven against compiled SQL in services/deviceUninstallDrain.test.ts.
// What is under test HERE is the middleware's contract: predicate false =>
// byte-for-byte today's 403, predicate true => a narrow admitted surface.
vi.mock('../services/deviceUninstallDrain', () => ({
  isDeviceUninstallDraining: vi.fn(async () => false),
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((left, right) => ({ left, right })),
  and: vi.fn((...args) => ({ and: args })),
  isNull: vi.fn((col) => ({ isNull: col })),
  desc: vi.fn((col) => ({ desc: col })),
  ne: vi.fn((left, right) => ({ ne: [left, right] })),
  count: vi.fn(() => ({ count: true })),
}));

// #2728 — `resolveOrgRateLimit` is stubbed so a test can drive the ceiling
// directly (the real one needs Redis plus a COUNT query); its own math is
// covered in agentOrgRateLimit.test.ts. `isReservedIngestPath` and
// `computeReservedIngestLimit` stay REAL, so the reserved-lane wiring under
// test is the actual implementation.
//
// Without this stub the harness's drizzle/Redis mocks made every device-count
// lookup fail into the floor, so the org limit was silently always 600 no
// matter what the service computed — the reserved-lane assertions below were
// passing by coincidence.
vi.mock('../services/agentOrgRateLimit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/agentOrgRateLimit')>();
  return {
    ...actual,
    resolveOrgRateLimit: vi.fn(async () => 600),
  };
});

import type { Context } from 'hono';
import { createHash } from 'crypto';

import { db, withDbAccessContext, withSystemDbAccessContext } from '../db';
import { getRedis, rateLimiter } from '../services';
import { createAuditLogAsync } from '../services/auditService';
import { getTrustedClientIp, trustsForwardedHeadersFrom } from '../services/clientIp';
import { getAgentTenantState } from '../services/tenantStatus';
import { isDeviceUninstallDraining } from '../services/deviceUninstallDrain';
import { resolveOrgRateLimit } from '../services/agentOrgRateLimit';
import {
  agentAuthMiddleware,
  DRAIN_CLAIM_TYPE_ALLOWLIST,
  isAgentTokenRotationDue,
  matchAgentTokenHash,
  matchRoleScopedAgentTokenHash,
  suspendAgentToken,
} from './agentAuth';

function sha(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

describe('matchAgentTokenHash', () => {
  it('matches the current token hash without rotation requirement', () => {
    const result = matchAgentTokenHash({
      agentTokenHash: sha('brz_current'),
      previousTokenHash: sha('brz_previous'),
      previousTokenExpiresAt: new Date(Date.now() + 60_000),
      tokenHash: sha('brz_current'),
    });

    expect(result).toEqual({ tokenRotationRequired: false, pendingTokenPresented: false });
  });

  it('matches the previous token hash only while the grace window is active', () => {
    const result = matchAgentTokenHash({
      agentTokenHash: sha('brz_current'),
      previousTokenHash: sha('brz_previous'),
      previousTokenExpiresAt: new Date('2026-03-31T18:05:00Z'),
      tokenHash: sha('brz_previous'),
      now: new Date('2026-03-31T18:00:00Z'),
    });

    expect(result).toEqual({ tokenRotationRequired: true, pendingTokenPresented: false });
  });

  it('rejects the previous token once the grace window expires', () => {
    const result = matchAgentTokenHash({
      agentTokenHash: sha('brz_current'),
      previousTokenHash: sha('brz_previous'),
      previousTokenExpiresAt: new Date('2026-03-31T17:59:00Z'),
      tokenHash: sha('brz_previous'),
      now: new Date('2026-03-31T18:00:00Z'),
    });

    expect(result).toBeNull();
  });

  // Issue #2621 — the staged credential of an unconfirmed rotation must
  // authenticate. This is what keeps an agent alive if it crashes after writing
  // the new credentials to disk but before confirming them.
  it('accepts a live pending token and flags it as such', () => {
    const result = matchAgentTokenHash({
      agentTokenHash: sha('brz_current'),
      previousTokenHash: null,
      previousTokenExpiresAt: null,
      pendingTokenHash: sha('brz_pending'),
      pendingTokenExpiresAt: new Date('2026-03-31T19:00:00Z'),
      tokenHash: sha('brz_pending'),
      now: new Date('2026-03-31T18:00:00Z'),
    });

    expect(result).toEqual({ tokenRotationRequired: false, pendingTokenPresented: true });
  });

  // The current credential stays fully valid for the whole pending window —
  // that is the property that makes a failed/abandoned rotation harmless.
  it('still accepts the current token while a rotation is staged', () => {
    const result = matchAgentTokenHash({
      agentTokenHash: sha('brz_current'),
      previousTokenHash: null,
      previousTokenExpiresAt: null,
      pendingTokenHash: sha('brz_pending'),
      pendingTokenExpiresAt: new Date('2026-03-31T19:00:00Z'),
      tokenHash: sha('brz_current'),
      now: new Date('2026-03-31T18:00:00Z'),
    });

    expect(result).toEqual({ tokenRotationRequired: false, pendingTokenPresented: false });
  });

  it('rejects a pending token once the staging window expires', () => {
    const result = matchAgentTokenHash({
      agentTokenHash: sha('brz_current'),
      previousTokenHash: null,
      previousTokenExpiresAt: null,
      pendingTokenHash: sha('brz_pending'),
      pendingTokenExpiresAt: new Date('2026-03-31T17:59:00Z'),
      tokenHash: sha('brz_pending'),
      now: new Date('2026-03-31T18:00:00Z'),
    });

    expect(result).toBeNull();
  });
});

describe('matchRoleScopedAgentTokenHash', () => {
  it('returns agent role for normal agent tokens', () => {
    const result = matchRoleScopedAgentTokenHash({
      agentTokenHash: sha('brz_agent'),
      previousTokenHash: null,
      previousTokenExpiresAt: null,
      watchdogTokenHash: sha('brz_watchdog'),
      previousWatchdogTokenHash: null,
      previousWatchdogTokenExpiresAt: null,
      tokenHash: sha('brz_agent'),
    });

    expect(result).toEqual({ role: 'agent', tokenRotationRequired: false, pendingTokenPresented: false });
  });

  it('returns watchdog role for watchdog-scoped tokens', () => {
    const result = matchRoleScopedAgentTokenHash({
      agentTokenHash: sha('brz_agent'),
      previousTokenHash: null,
      previousTokenExpiresAt: null,
      watchdogTokenHash: sha('brz_watchdog'),
      previousWatchdogTokenHash: null,
      previousWatchdogTokenExpiresAt: null,
      tokenHash: sha('brz_watchdog'),
    });

    expect(result).toEqual({ role: 'watchdog', tokenRotationRequired: false, pendingTokenPresented: false });
  });
});

describe('isAgentTokenRotationDue', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('requires rotation when the token was never issued with a tracked timestamp', () => {
    expect(isAgentTokenRotationDue(null, new Date('2026-03-31T18:00:00Z'))).toBe(true);
  });

  it('uses the configured max age threshold', () => {
    vi.stubEnv('AGENT_TOKEN_ROTATION_MAX_AGE_DAYS', '7');

    expect(
      isAgentTokenRotationDue(
        new Date('2026-03-20T18:00:00Z'),
        new Date('2026-03-31T18:00:00Z')
      )
    ).toBe(true);

    expect(
      isAgentTokenRotationDue(
        new Date('2026-03-28T18:00:00Z'),
        new Date('2026-03-31T18:00:00Z')
      )
    ).toBe(false);
  });
});

type TestContext = Context & {
  _getResponseHeaders: () => Record<string, string>;
  _getResponse: () => { status: number; body: unknown } | null;
};

const VALID_TOKEN = 'brz_test_token';
const VALID_HASH = sha(VALID_TOKEN);

function buildSelectMock(result: unknown[]) {
  vi.mocked(db.select).mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(result),
      }),
    }),
  } as any);
}

function makeDevice(overrides: Record<string, unknown> = {}) {
  return {
    id: 'device-1',
    agentId: 'agent-1',
    orgId: 'org-1',
    siteId: 'site-1',
    agentTokenHash: VALID_HASH,
    previousTokenHash: null,
    previousTokenExpiresAt: null,
    watchdogTokenHash: null,
    previousWatchdogTokenHash: null,
    previousWatchdogTokenExpiresAt: null,
    status: 'active',
    hostname: 'box-1',
    lastSeenIp: null,
    ...overrides,
  };
}

function createContext(
  opts: { agentId?: string; token?: string; path?: string; headers?: Record<string, string> } = {},
): TestContext {
  const headers: Record<string, string> = {};
  const store = new Map<string, unknown>();
  const reqHeaders: Record<string, string> = {};
  if (opts.token) {
    reqHeaders['authorization'] = `Bearer ${opts.token}`;
  }
  for (const [key, value] of Object.entries(opts.headers ?? {})) {
    reqHeaders[key.toLowerCase()] = value;
  }

  let response: { status: number; body: unknown } | null = null;

  return {
    req: {
      header: (name: string) => reqHeaders[name.toLowerCase()],
      param: (_name: string) => opts.agentId ?? 'agent-1',
      path: opts.path ?? '',
    },
    header: (name: string, value: string) => {
      headers[name] = value;
    },
    set: (key: string, value: unknown) => {
      store.set(key, value);
    },
    get: (key: string) => store.get(key),
    json: (body: unknown, status?: number) => {
      response = { status: status ?? 200, body };
      return response;
    },
    _getResponseHeaders: () => headers,
    _getResponse: () => response,
  } as unknown as TestContext;
}

describe('agentAuthMiddleware - tenant-status gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.mocked(getRedis).mockReturnValue({} as any);
    vi.mocked(getAgentTenantState).mockResolvedValue('active');
    vi.mocked(rateLimiter).mockResolvedValue({
      allowed: true,
      remaining: 100,
      resetAt: new Date(Date.now() + 60_000),
    });
  });

  it('rejects with an opaque 401 when the device org/partner tenant is not active', async () => {
    buildSelectMock([makeDevice()]);
    vi.mocked(getAgentTenantState).mockResolvedValue(null);

    const c = createContext({ token: VALID_TOKEN });
    const next = vi.fn();

    await expect(agentAuthMiddleware(c, next)).rejects.toMatchObject({
      status: 401,
      message: 'Invalid agent credentials',
    });
    expect(next).not.toHaveBeenCalled();
    expect(getAgentTenantState).toHaveBeenCalledWith('org-1');
  });

  it('proceeds to next() when the device tenant is active', async () => {
    buildSelectMock([makeDevice()]);
    vi.mocked(getAgentTenantState).mockResolvedValue('active');

    const c = createContext({ token: VALID_TOKEN });
    const next = vi.fn().mockResolvedValue(undefined);

    await agentAuthMiddleware(c, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(getAgentTenantState).toHaveBeenCalledWith('org-1');
  });

  // #1105 — the reliability ingest route self-manages a short org-scoped
  // withDbAccessContext around only its lookup+insert (see reliability.ts),
  // so the middleware must NOT also wrap the whole request in its own
  // request-long org transaction for this route.
  it('skips the request-long org wrap for the self-managed reliability route', async () => {
    buildSelectMock([makeDevice()]);
    vi.mocked(getAgentTenantState).mockResolvedValue('active');

    const c = createContext({ token: VALID_TOKEN, path: '/api/v1/agents/agent-1/reliability' });
    const next = vi.fn().mockResolvedValue(undefined);

    await agentAuthMiddleware(c, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(vi.mocked(withDbAccessContext)).not.toHaveBeenCalled();
  });

  // #1105 — the GET command poll claims commands inside its own
  // withSystemDbAccessContext (see routes/agents/commands.ts). Wrapping the
  // request in the org transaction on top made every poll hold TWO pooled
  // connections at once and self-deadlocked the pool under load (US prod
  // outage, 2026-07-24), so the middleware must NOT add the request-long wrap.
  it('skips the request-long org wrap for the self-managed commands poll route', async () => {
    buildSelectMock([makeDevice()]);
    vi.mocked(getAgentTenantState).mockResolvedValue('active');

    const c = createContext({ token: VALID_TOKEN, path: '/api/v1/agents/agent-1/commands' });
    const next = vi.fn().mockResolvedValue(undefined);

    await agentAuthMiddleware(c, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(vi.mocked(withDbAccessContext)).not.toHaveBeenCalled();
  });

  // The command RESULT route ends in `result`, not `commands` — it must keep
  // the request-long org wrap.
  it('keeps the request-long org wrap for the command result route', async () => {
    buildSelectMock([makeDevice()]);
    vi.mocked(getAgentTenantState).mockResolvedValue('active');

    const c = createContext({
      token: VALID_TOKEN,
      path: '/api/v1/agents/agent-1/commands/cmd-1/result',
    });
    const next = vi.fn().mockResolvedValue(undefined);

    await agentAuthMiddleware(c, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(vi.mocked(withDbAccessContext)).toHaveBeenCalledTimes(1);
  });
});

// Security remediation Wave 5, Task 6 — the shared certificate/device
// binding decision (services/agentCertificateBinding.ts) runs inside
// agentAuthMiddleware after bearer + tenant-status checks. Sequenced select
// mock: 1st call is the device lookup (buildSelectMock's persistent shape
// won't do here since the binding check issues its OWN db.select call(s)).
const ACTIVE_SERIAL = 'AABBCCDDEEFF00112233';
const OTHER_SERIAL = '00112233AABBCCDDEEFF';

function queueSelectOnce(rows: unknown[]) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
        orderBy: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(rows) }),
      }),
    }),
  } as any);
}

function assertionHeaders(serial: string): Record<string, string> {
  return {
    'X-Breeze-Client-Cert-Verified': 'true',
    'X-Breeze-Client-Cert-Serial': serial,
  };
}

describe('agentAuthMiddleware - certificate/device binding (Wave 5 Task 6)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    delete process.env.AGENT_MTLS_BINDING_MODE;
    vi.mocked(getRedis).mockReturnValue({} as any);
    vi.mocked(getAgentTenantState).mockResolvedValue('active');
    vi.mocked(rateLimiter).mockResolvedValue({
      allowed: true,
      remaining: 100,
      resetAt: new Date(Date.now() + 60_000),
    });
    vi.mocked(trustsForwardedHeadersFrom).mockReturnValue(false);
  });

  afterEach(() => {
    delete process.env.AGENT_MTLS_BINDING_MODE;
  });

  it('mode off (default): never queries the certificate identity table', async () => {
    queueSelectOnce([makeDevice()]);
    const c = createContext({ token: VALID_TOKEN });
    const next = vi.fn().mockResolvedValue(undefined);

    await agentAuthMiddleware(c, next);

    expect(next).toHaveBeenCalledTimes(1);
    // Only the device lookup select — no second call for cert identity.
    expect(vi.mocked(db.select)).toHaveBeenCalledTimes(1);
  });

  it('mode enforce: allows through with a trusted, matching certificate assertion', async () => {
    process.env.AGENT_MTLS_BINDING_MODE = 'enforce';
    vi.mocked(trustsForwardedHeadersFrom).mockReturnValue(true);
    queueSelectOnce([makeDevice()]);
    queueSelectOnce([{ serialNumber: ACTIVE_SERIAL, state: 'active' }]);

    const c = createContext({ token: VALID_TOKEN, headers: assertionHeaders(ACTIVE_SERIAL) });
    const next = vi.fn().mockResolvedValue(undefined);

    await agentAuthMiddleware(c, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('mode enforce: rejects with an opaque 401 when no assertion is presented and an active cert is on file', async () => {
    process.env.AGENT_MTLS_BINDING_MODE = 'enforce';
    queueSelectOnce([makeDevice()]);
    queueSelectOnce([{ serialNumber: ACTIVE_SERIAL, state: 'active' }]);

    const c = createContext({ token: VALID_TOKEN });
    const next = vi.fn().mockResolvedValue(undefined);

    await expect(agentAuthMiddleware(c, next)).rejects.toMatchObject({
      status: 401,
      message: 'Invalid agent credentials',
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('mode enforce: rejects a certificate assertion naming a DIFFERENT device\'s serial (bearer token cannot choose another device\'s identity)', async () => {
    process.env.AGENT_MTLS_BINDING_MODE = 'enforce';
    vi.mocked(trustsForwardedHeadersFrom).mockReturnValue(true);
    queueSelectOnce([makeDevice()]);
    queueSelectOnce([{ serialNumber: ACTIVE_SERIAL, state: 'active' }]);

    // The assertion names a serial that is NOT this device's active serial
    // (e.g. a different device's certificate) — must be denied even though
    // the assertion itself is trusted + verified.
    const c = createContext({ token: VALID_TOKEN, headers: assertionHeaders(OTHER_SERIAL) });
    const next = vi.fn().mockResolvedValue(undefined);

    await expect(agentAuthMiddleware(c, next)).rejects.toMatchObject({ status: 401 });
    expect(next).not.toHaveBeenCalled();
  });

  it('mode enforce: ignores a verified claim from an untrusted source (spoofed header) and denies', async () => {
    process.env.AGENT_MTLS_BINDING_MODE = 'enforce';
    vi.mocked(trustsForwardedHeadersFrom).mockReturnValue(false); // untrusted source
    queueSelectOnce([makeDevice()]);
    queueSelectOnce([{ serialNumber: ACTIVE_SERIAL, state: 'active' }]);

    const c = createContext({ token: VALID_TOKEN, headers: assertionHeaders(ACTIVE_SERIAL) });
    const next = vi.fn().mockResolvedValue(undefined);

    await expect(agentAuthMiddleware(c, next)).rejects.toMatchObject({ status: 401 });
    expect(next).not.toHaveBeenCalled();
  });

  it('mode audit: a mismatched assertion is observed but never blocks the request', async () => {
    process.env.AGENT_MTLS_BINDING_MODE = 'audit';
    vi.mocked(trustsForwardedHeadersFrom).mockReturnValue(true);
    queueSelectOnce([makeDevice()]);
    queueSelectOnce([{ serialNumber: ACTIVE_SERIAL, state: 'active' }]);

    const c = createContext({ token: VALID_TOKEN, headers: assertionHeaders(OTHER_SERIAL) });
    const next = vi.fn().mockResolvedValue(undefined);

    await agentAuthMiddleware(c, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('mode enforce: a legacy device with no certificate identity at all is allowed through (compatibility)', async () => {
    process.env.AGENT_MTLS_BINDING_MODE = 'enforce';
    queueSelectOnce([makeDevice()]);
    queueSelectOnce([]); // no active row
    queueSelectOnce([]); // no historical row either
    queueSelectOnce([{ legacySerial: null }]); // no legacy column either

    const c = createContext({ token: VALID_TOKEN });
    const next = vi.fn().mockResolvedValue(undefined);

    await agentAuthMiddleware(c, next);

    expect(next).toHaveBeenCalledTimes(1);
  });
});

// #2774 — during an `offboarding` drain the agent stays authenticated, but
// only on the surface self_uninstall delivery needs. Everything else 403s.
describe('agentAuthMiddleware - offboarding drain mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.mocked(getRedis).mockReturnValue({} as any);
    vi.mocked(getAgentTenantState).mockResolvedValue('draining');
    vi.mocked(rateLimiter).mockResolvedValue({
      allowed: true,
      remaining: 100,
      resetAt: new Date(Date.now() + 60_000),
    });
  });

  const allowedPaths = [
    '/api/v1/agents/agent-1/heartbeat',
    '/api/v1/agents/agent-1/commands',
    '/api/v1/agents/agent-1/commands/cmd-1/result',
    '/api/v1/agents/agent-1/rotate-token',
    '/api/v1/agents/agent-1/rotate-token/confirm',
    '/api/v1/agents/agent-1/logs',
  ];

  for (const path of allowedPaths) {
    it(`allows ${path} while draining`, async () => {
      buildSelectMock([makeDevice()]);

      const c = createContext({ token: VALID_TOKEN, path });
      const next = vi.fn().mockResolvedValue(undefined);

      await agentAuthMiddleware(c, next);

      expect(next).toHaveBeenCalledTimes(1);
    });
  }

  const blockedPaths = [
    '/api/v1/agents/agent-1/hardware',
    '/api/v1/agents/agent-1/software',
    '/api/v1/agents/agent-1/config',
    '/api/v1/agents/agent-1/monitoring-results',
    '/api/v1/agents/agent-1/patches',
    '/api/v1/agents/agent-1/eventlogs',
    // This middleware also serves the extension gateway
    // (extensions/gateway.ts mounts /ext/<name>/agent/:id/* — singular
    // "agent"). Matching on the trailing segment alone would admit every
    // extension route whose last segment happens to be an allowed action, so
    // the allowlist is anchored on the core `agents/<id>/<action>` shape. An
    // extension route may NOT join the drain surface even by mimicking a core
    // action name exactly.
    '/api/v1/ext/acme/agent/agent-1/heartbeat',
    '/api/v1/ext/acme/agent/agent-1/commands',
    '/api/v1/ext/acme/agent/agent-1/commands/cmd-1/result',
    '/api/v1/ext/acme/agent/agent-1/rotate-token/confirm',
    '/api/v1/ext/acme/agent/agent-1/extra/heartbeat',
    // Nested path under a real agent route with an attacker-chosen final
    // segment (winget-bootstrap/file/:name).
    '/api/v1/agents/agent-1/winget-bootstrap/file/heartbeat',
  ];

  for (const path of blockedPaths) {
    it(`blocks ${path} with 403 tenant_offboarding while draining`, async () => {
      buildSelectMock([makeDevice()]);

      const c = createContext({ token: VALID_TOKEN, path });
      const next = vi.fn();

      const result = await agentAuthMiddleware(c, next);

      expect(next).not.toHaveBeenCalled();
      expect((result as any).status).toBe(403);
      expect((result as any).body).toEqual({ error: 'tenant_offboarding' });
    });
  }

  it('sets tenantDraining on the agent context while draining', async () => {
    buildSelectMock([makeDevice()]);

    const c = createContext({ token: VALID_TOKEN, path: '/api/v1/agents/agent-1/heartbeat' });
    const next = vi.fn().mockResolvedValue(undefined);

    await agentAuthMiddleware(c, next);

    expect((c.get('agent') as { tenantDraining?: boolean }).tenantDraining).toBe(true);
  });

  it('leaves tenantDraining false for a fully active tenant', async () => {
    vi.mocked(getAgentTenantState).mockResolvedValue('active');
    buildSelectMock([makeDevice()]);

    const c = createContext({ token: VALID_TOKEN, path: '/api/v1/agents/agent-1/hardware' });
    const next = vi.fn().mockResolvedValue(undefined);

    await agentAuthMiddleware(c, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect((c.get('agent') as { tenantDraining?: boolean }).tenantDraining).toBe(false);
  });
});

// #3986 — a REMOVED device (status='decommissioned') is still denied by
// default. The single exception is the device-remove uninstall drain: the
// `self_uninstall` queued by DELETE /devices/:id?uninstallAgent=true has to be
// collectable, and it cannot be if the agent is 403'd before it can heartbeat.
//
// Four separate layers are asserted here:
//   L1  — the auth gate itself (denied unless the shared predicate says drain)
//   L1b — role: main agent only, never the watchdog credential
//   L2  — the route surface a draining device gets (heartbeat/commands/result/
//         logs/rotate-token, and NOTHING else — the layer that keeps
//         recovery-key ingest, PAM elevation, inventory and every extension
//         `<prefix>/agent/:id/*` route shut)
//   L3  — one derived command-type allowlist on the agent context
describe('agentAuthMiddleware - device-remove uninstall drain (#3986)', () => {
  const WATCHDOG_TOKEN = 'brz_watchdog_token';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.mocked(getRedis).mockReturnValue({} as any);
    // `vi.clearAllMocks()` clears CALLS, not implementations, so both of these
    // are restored explicitly — the system-context test below installs its own
    // and would otherwise leak into every later test in the file.
    vi.mocked(withSystemDbAccessContext).mockImplementation((async (fn: () => Promise<unknown>) =>
      fn()) as never);
    vi.mocked(getAgentTenantState).mockResolvedValue('active');
    vi.mocked(isDeviceUninstallDraining).mockResolvedValue(false);
    vi.mocked(rateLimiter).mockResolvedValue({
      allowed: true,
      remaining: 100,
      resetAt: new Date(Date.now() + 60_000),
    });
  });

  afterEach(() => {
    // Implementations survive vi.clearAllMocks(), so a custom one installed by
    // a test here would otherwise leak into every LATER describe in this file.
    vi.mocked(withSystemDbAccessContext).mockImplementation((async (fn: () => Promise<unknown>) =>
      fn()) as never);
    vi.mocked(isDeviceUninstallDraining).mockResolvedValue(false);
  });

  // ---- Layer 1: the deny side. Three DIFFERENT reasons the shared predicate
  // returns false; all three must land on exactly today's 403. Which of the
  // three a given row is in is decided inside isDeviceUninstallDraining (see
  // the mock note at the top of this file) — what matters here is that the
  // middleware never second-guesses it and never softens the refusal.

  it('still 403s a removed device with NO device_remove drain', async () => {
    // DELETE /devices/:id with uninstallAgent:false — decommissioned, but no
    // self_uninstall was ever queued, so the predicate reports not-draining.
    vi.mocked(isDeviceUninstallDraining).mockResolvedValue(false);
    buildSelectMock([makeDevice({ status: 'decommissioned' })]);

    const c = createContext({ token: VALID_TOKEN, path: '/api/v1/agents/agent-1/heartbeat' });
    const next = vi.fn();

    await expect(agentAuthMiddleware(c, next)).rejects.toMatchObject({
      status: 403,
      message: 'Device has been decommissioned',
    });
    expect(next).not.toHaveBeenCalled();
    expect(isDeviceUninstallDraining).toHaveBeenCalledWith('device-1');
  });

  it('still 403s a removed device whose drain deadline has passed', async () => {
    // device_remove_expires_at <= now(): the window closed, the uninstall is no
    // longer exempt from expiry, and the machine must go back to being denied.
    vi.mocked(isDeviceUninstallDraining).mockResolvedValue(false);
    buildSelectMock([makeDevice({ status: 'decommissioned' })]);

    const c = createContext({ token: VALID_TOKEN, path: '/api/v1/agents/agent-1/commands' });
    const next = vi.fn();

    await expect(agentAuthMiddleware(c, next)).rejects.toMatchObject({
      status: 403,
      message: 'Device has been decommissioned',
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('still 403s a removed device carrying only an abuse-queued uninstall', async () => {
    // THE incident guard. routes/admin/abuse.ts queues self_uninstall across a
    // suspended partner's whole fleet with NO uninstall_reasons and NO
    // deadline, including onto already-decommissioned rows. A predicate of the
    // shape "decommissioned + any pending self_uninstall" would re-open the
    // agent channel for every one of those, and on un-suspension deliver a
    // fleet-wide uninstall to a reinstated customer. The reason clause keeps
    // them out; the middleware must not widen past it.
    vi.mocked(isDeviceUninstallDraining).mockResolvedValue(false);
    buildSelectMock([makeDevice({ status: 'decommissioned' })]);

    const c = createContext({ token: VALID_TOKEN, path: '/api/v1/agents/agent-1/heartbeat' });
    const next = vi.fn();

    await expect(agentAuthMiddleware(c, next)).rejects.toMatchObject({
      status: 403,
      message: 'Device has been decommissioned',
    });
    expect(next).not.toHaveBeenCalled();
  });

  // ---- Layer 1b: role.

  it('refuses a WATCHDOG credential on a draining removed device', async () => {
    // The predicate says "draining" — the ONLY thing refusing this request is
    // the role gate. The watchdog heartbeat branch writes device state without
    // the terminal-status guard the main branch has, and self_uninstall is
    // targetRole='agent' anyway, so a watchdog has nothing to collect.
    vi.mocked(isDeviceUninstallDraining).mockResolvedValue(true);
    buildSelectMock([
      makeDevice({
        status: 'decommissioned',
        agentTokenHash: sha('brz_some_other_agent_token'),
        watchdogTokenHash: sha(WATCHDOG_TOKEN),
      }),
    ]);

    const c = createContext({ token: WATCHDOG_TOKEN, path: '/api/v1/agents/agent-1/heartbeat' });
    const next = vi.fn();

    await expect(agentAuthMiddleware(c, next)).rejects.toMatchObject({
      status: 403,
      message: 'Device has been decommissioned',
    });
    expect(next).not.toHaveBeenCalled();
    // Short-circuited before the predicate query — a watchdog costs no round trip.
    expect(isDeviceUninstallDraining).not.toHaveBeenCalled();
  });

  it('admits the SAME device on the main-agent credential (proves the watchdog refusal is the role gate, not the fixture)', async () => {
    vi.mocked(isDeviceUninstallDraining).mockResolvedValue(true);
    buildSelectMock([
      makeDevice({
        status: 'decommissioned',
        agentTokenHash: VALID_HASH,
        watchdogTokenHash: sha(WATCHDOG_TOKEN),
      }),
    ]);

    const c = createContext({ token: VALID_TOKEN, path: '/api/v1/agents/agent-1/heartbeat' });
    const next = vi.fn().mockResolvedValue(undefined);

    await agentAuthMiddleware(c, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect((c.get('agent') as { role?: string }).role).toBe('agent');
  });

  // ---- Layer 1: the admit side.

  it('admits a draining removed device on heartbeat', async () => {
    vi.mocked(isDeviceUninstallDraining).mockResolvedValue(true);
    buildSelectMock([makeDevice({ status: 'decommissioned' })]);

    const c = createContext({ token: VALID_TOKEN, path: '/api/v1/agents/agent-1/heartbeat' });
    const next = vi.fn().mockResolvedValue(undefined);

    await agentAuthMiddleware(c, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('evaluates the drain predicate inside withSystemDbAccessContext (a contextless read would report "never draining" fleet-wide)', async () => {
    // The wrap is not decorative and its absence is SILENT. The predicate
    // joins `devices`, which is RLS-scoped; a contextless read defaults to
    // scope 'none', matches zero rows, and reports not-draining for EVERY
    // device — so every queued uninstall becomes permanently undeliverable
    // while the API and the audit log both say `uninstallQueued: true`, and
    // nothing anywhere throws. Stubbing the predicate (as this suite must,
    // see the mock note at the top of the file) means no other test in the
    // unit job can see the wrap at all: reverting to a bare
    // `isDeviceUninstallDraining(device.id)` left the whole Test API job
    // green. This asserts the CONTEXT the predicate observes at call time,
    // not merely that the helper was called somewhere in the request.
    let depth = 0;
    let contextAtPredicateCall: number | null = null;
    vi.mocked(withSystemDbAccessContext).mockImplementation((async (fn: () => Promise<unknown>) => {
      depth += 1;
      try {
        return await fn();
      } finally {
        depth -= 1;
      }
    }) as never);
    vi.mocked(isDeviceUninstallDraining).mockImplementation(async () => {
      contextAtPredicateCall = depth;
      return true;
    });
    buildSelectMock([makeDevice({ status: 'decommissioned' })]);

    const c = createContext({ token: VALID_TOKEN, path: '/api/v1/agents/agent-1/heartbeat' });
    const next = vi.fn().mockResolvedValue(undefined);

    await agentAuthMiddleware(c, next);

    expect(next).toHaveBeenCalledTimes(1);
    // Strictly greater than zero: the device lookup earlier in the middleware
    // opens (and closes) its own system context, so "the helper ran at some
    // point" proves nothing — only an OPEN context at predicate-call time does.
    expect(contextAtPredicateCall).toBeGreaterThan(0);
  });

  it('a QUARANTINED device is still refused outright, drain or not', async () => {
    // The quarantine throw is deliberately untouched by #3986; only the
    // decommissioned arm gained a conditional.
    vi.mocked(isDeviceUninstallDraining).mockResolvedValue(true);
    buildSelectMock([makeDevice({ status: 'quarantined' })]);

    const c = createContext({ token: VALID_TOKEN, path: '/api/v1/agents/agent-1/heartbeat' });
    const next = vi.fn();

    await expect(agentAuthMiddleware(c, next)).rejects.toMatchObject({
      status: 403,
      message: 'Device is quarantined pending admin approval',
    });
    expect(next).not.toHaveBeenCalled();
    expect(isDeviceUninstallDraining).not.toHaveBeenCalled();
  });

  it('never consults the drain predicate for a device that is not decommissioned', async () => {
    buildSelectMock([makeDevice({ status: 'online' })]);

    const c = createContext({ token: VALID_TOKEN, path: '/api/v1/agents/agent-1/hardware' });
    const next = vi.fn().mockResolvedValue(undefined);

    await agentAuthMiddleware(c, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(isDeviceUninstallDraining).not.toHaveBeenCalled();
  });

  // ---- Layer 2: the route surface.

  const drainAllowedPaths = [
    '/api/v1/agents/agent-1/heartbeat',
    '/api/v1/agents/agent-1/commands',
    '/api/v1/agents/agent-1/commands/cmd-1/result',
    // NOTE: `rotate-token` (the MINT half) is deliberately absent — see the
    // dedicated describe block below. `/confirm` stays allowed.
    '/api/v1/agents/agent-1/rotate-token/confirm',
    '/api/v1/agents/agent-1/logs',
  ];

  for (const path of drainAllowedPaths) {
    it(`allows ${path} for a draining removed device`, async () => {
      vi.mocked(isDeviceUninstallDraining).mockResolvedValue(true);
      buildSelectMock([makeDevice({ status: 'decommissioned' })]);

      const c = createContext({ token: VALID_TOKEN, path });
      const next = vi.fn().mockResolvedValue(undefined);

      await agentAuthMiddleware(c, next);

      expect(next).toHaveBeenCalledTimes(1);
    });
  }

  const drainBlockedPaths: Array<[string, string]> = [
    // BitLocker / FileVault recovery-key ingest. A removed machine must not be
    // able to plant or overwrite escrowed key material for the org.
    ['recovery-keys', '/api/v1/agents/agent-1/security/recovery-keys'],
    // PAM elevation requests.
    ['elevation-requests', '/api/v1/agents/agent-1/elevation-requests'],
    // PAM reconciliation ownership reads are intentionally unavailable while
    // either tenant or device drain has narrowed the agent surface.
    ['pam-reconciliation-bindings', '/api/v1/agents/agent-1/pam/reconciliation-bindings'],
    // Inventory push.
    ['inventory (hardware)', '/api/v1/agents/agent-1/hardware'],
    ['inventory (software)', '/api/v1/agents/agent-1/software'],
    ['patches', '/api/v1/agents/agent-1/patches'],
    ['config', '/api/v1/agents/agent-1/config'],
    // The extension gateway mounts agent routes at `<prefix>/agent/:id/*`
    // (singular) through THIS middleware. The drain allowlist is anchored on
    // the core `agents/<id>/<action>` shape, so no extension namespace can
    // join the drain surface — even by mimicking an allowed action name.
    ['extension gateway agent path', '/api/v1/ext/acme/agent/agent-1/heartbeat'],
    ['extension gateway agent subpath', '/api/v1/ext/acme/agent/agent-1/commands/cmd-1/result'],
    // Nested path under a real agent route with an attacker-chosen final segment.
    ['nested winget-bootstrap path', '/api/v1/agents/agent-1/winget-bootstrap/file/heartbeat'],
    // The CRAFTED TAIL. The old predicate indexed from the END, so any path
    // whose tail read `agents/<id>/<action>` matched — and the AGENT supplies
    // the tail, so no extension-author complicity was needed. Extension route
    // paths are copied verbatim with no validation
    // (extensions/contributionRegistry.ts), and the gateway mounts agent routes
    // at both `<prefix>/agent/<id>/*` and `/api/v1/<routeNamespace>/agent/<id>/*`.
    ['crafted extension tail (heartbeat)', '/api/v1/ext/acme/agent/agent-1/agents/agent-1/heartbeat'],
    ['crafted extension tail (rotate-token)', '/api/v1/ext/acme/agent/agent-1/agents/agent-1/rotate-token'],
    ['crafted extension tail (commands result)', '/api/v1/ext/acme/agent/agent-1/agents/agent-1/commands/cmd-1/result'],
    ['crafted namespace tail', '/api/v1/workspace/agent/agent-1/agents/agent-1/commands'],
    // Right shape, wrong mount root.
    ['wrong api version', '/api/v2/agents/agent-1/heartbeat'],
    ['missing api prefix', '/v1/agents/agent-1/heartbeat'],
    // Right mount, wrong agent id in the id position.
    //
    // WEAK GUARD, deliberately kept and labelled: `createContext`'s `param()`
    // hardcodes 'agent-1' regardless of the path, so this asserts only that the
    // id position is still compared to the authenticated agent id. The OLD
    // from-the-end predicate compared it too, so no revert probe fails on this
    // row — it is regression cover for the index arithmetic surviving the
    // rewrite, NOT evidence of a hole the rewrite closed. Deriving `param()`
    // from the path would make it strictly worse (the ids would then agree).
    ['another agent id', '/api/v1/agents/agent-99/heartbeat'],
  ];

  for (const [label, path] of drainBlockedPaths) {
    it(`refuses a draining removed device on ${label}`, async () => {
      vi.mocked(isDeviceUninstallDraining).mockResolvedValue(true);
      buildSelectMock([makeDevice({ status: 'decommissioned' })]);

      const c = createContext({ token: VALID_TOKEN, path });
      const next = vi.fn();

      const result = await agentAuthMiddleware(c, next);

      expect(next).not.toHaveBeenCalled();
      expect((result as any).status).toBe(403);
      expect((result as any).body).toEqual({ error: 'device_uninstall_draining' });
    });
  }

  // ---- Layer 3: one derived claim allowlist.

  it('carries the derived claim allowlist (and deviceUninstallDraining) on the agent context', async () => {
    vi.mocked(isDeviceUninstallDraining).mockResolvedValue(true);
    buildSelectMock([makeDevice({ status: 'decommissioned' })]);

    const c = createContext({ token: VALID_TOKEN, path: '/api/v1/agents/agent-1/commands' });
    const next = vi.fn().mockResolvedValue(undefined);

    await agentAuthMiddleware(c, next);

    const ctx = c.get('agent') as {
      deviceUninstallDraining?: boolean;
      tenantDraining?: boolean;
      claimTypeAllowlist?: readonly string[];
    };
    expect(ctx.deviceUninstallDraining).toBe(true);
    // The tenant is perfectly healthy — only this ONE device is being removed.
    expect(ctx.tenantDraining).toBe(false);
    expect(ctx.claimTypeAllowlist).toEqual(['self_uninstall']);
    expect(DRAIN_CLAIM_TYPE_ALLOWLIST).toEqual(['self_uninstall']);
  });

  it('leaves claimTypeAllowlist UNDEFINED (unrestricted) for a healthy device on a healthy tenant', async () => {
    buildSelectMock([makeDevice({ status: 'online' })]);

    const c = createContext({ token: VALID_TOKEN, path: '/api/v1/agents/agent-1/hardware' });
    const next = vi.fn().mockResolvedValue(undefined);

    await agentAuthMiddleware(c, next);

    const ctx = c.get('agent') as { claimTypeAllowlist?: readonly string[]; deviceUninstallDraining?: boolean };
    expect(ctx.claimTypeAllowlist).toBeUndefined();
    expect(ctx.deviceUninstallDraining).toBe(false);
  });

  it('derives the same claim allowlist for a TENANT drain (#2774), with the tenant_offboarding refusal code preserved', async () => {
    vi.mocked(getAgentTenantState).mockResolvedValue('draining');
    buildSelectMock([makeDevice({ status: 'online' })]);

    const allowed = createContext({ token: VALID_TOKEN, path: '/api/v1/agents/agent-1/heartbeat' });
    await agentAuthMiddleware(allowed, vi.fn().mockResolvedValue(undefined));
    const ctx = allowed.get('agent') as {
      claimTypeAllowlist?: readonly string[];
      deviceUninstallDraining?: boolean;
    };
    expect(ctx.claimTypeAllowlist).toEqual(['self_uninstall']);
    expect(ctx.deviceUninstallDraining).toBe(false);

    buildSelectMock([makeDevice({ status: 'online' })]);
    const blocked = createContext({ token: VALID_TOKEN, path: '/api/v1/agents/agent-1/hardware' });
    const result = await agentAuthMiddleware(blocked, vi.fn());
    expect((result as any).body).toEqual({ error: 'tenant_offboarding' });
  });
});

// #3986 fix round 1, HIGH-1 — `rotate-token` (the MINT half) is off the DEVICE
// drain surface. `routes/agents/token.ts` carries no `devices.status` guard of
// its own, and the credentials it mints OUTLIVE the drain window: nothing
// revokes a staged or promoted rotation when the deadline passes, and
// POST /devices/:id/restore touches no token hash. A stolen token on a removed
// device could therefore be rotated into a fresh agent + watchdog + helper set
// that lies dormant behind the post-expiry 403 and becomes the LIVE credential
// the moment an operator restores the device. Rotation also demotes the
// legitimate token, letting a thief deny the very uninstall the window exists
// to deliver.
describe('agentAuthMiddleware - rotate-token is off the device drain surface (#3986)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.mocked(getRedis).mockReturnValue({} as any);
    vi.mocked(getAgentTenantState).mockResolvedValue('active');
    vi.mocked(isDeviceUninstallDraining).mockResolvedValue(true);
    vi.mocked(rateLimiter).mockResolvedValue({
      allowed: true,
      remaining: 100,
      resetAt: new Date(Date.now() + 60_000),
    });
  });

  it('refuses a draining removed device on rotate-token (credential MINT)', async () => {
    buildSelectMock([makeDevice({ status: 'decommissioned' })]);

    const c = createContext({ token: VALID_TOKEN, path: '/api/v1/agents/agent-1/rotate-token' });
    const next = vi.fn();

    const result = await agentAuthMiddleware(c, next);

    expect(next).not.toHaveBeenCalled();
    expect((result as any).status).toBe(403);
    expect((result as any).body).toEqual({ error: 'device_uninstall_draining' });
  });

  it('still allows rotate-token/confirm for a draining removed device (finish a staged rotation)', async () => {
    // The CONFIRM half is safe and necessary: it only promotes a credential the
    // agent already holds on disk. Blocking it would lock out an agent that
    // crashed mid-rotation, which is the crash window two-phase rotation exists
    // to survive.
    buildSelectMock([makeDevice({ status: 'decommissioned' })]);

    const c = createContext({
      token: VALID_TOKEN,
      path: '/api/v1/agents/agent-1/rotate-token/confirm',
    });
    const next = vi.fn().mockResolvedValue(undefined);

    await agentAuthMiddleware(c, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('a mid-rotation agent can still heartbeat on its STAGED credential — so dropping rotate-token strands nothing', async () => {
    // The whole justification for keeping rotate-token open was "don't strand a
    // mid-stage rotation". A staged (pending) credential authenticates as
    // role:'agent' through matchRoleScopedAgentTokenHash, so it clears Layer 1b
    // and collects the uninstall without ever calling rotate-token.
    const STAGED_TOKEN = 'brz_staged_token';
    buildSelectMock([
      makeDevice({
        status: 'decommissioned',
        agentTokenHash: sha('brz_old_current_token'),
        pendingTokenHash: sha(STAGED_TOKEN),
        pendingTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      }),
    ]);

    const c = createContext({ token: STAGED_TOKEN, path: '/api/v1/agents/agent-1/heartbeat' });
    const next = vi.fn().mockResolvedValue(undefined);

    await agentAuthMiddleware(c, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect((c.get('agent') as { role?: string }).role).toBe('agent');
    expect((c.get('agent') as { deviceUninstallDraining?: boolean }).deviceUninstallDraining).toBe(true);
  });

  // Composition. Until this fix the two gates composed by "tenant wins", which
  // in the only case that differs is a UNION: a device removed with
  // uninstallAgent:true inside an org whose status is `offboarding` got
  // `rotate-token` back — precisely the hole the device set exists to close,
  // reopened by the combination. No test set BOTH states, so the whole
  // describe above proved nothing about it.
  it('refuses rotate-token when BOTH drains apply (two narrowing gates intersect; they never union)', async () => {
    vi.mocked(getAgentTenantState).mockResolvedValue('draining');
    vi.mocked(isDeviceUninstallDraining).mockResolvedValue(true);
    buildSelectMock([makeDevice({ status: 'decommissioned' })]);

    const c = createContext({ token: VALID_TOKEN, path: '/api/v1/agents/agent-1/rotate-token' });
    const next = vi.fn();

    const result = await agentAuthMiddleware(c, next);

    expect(next).not.toHaveBeenCalled();
    expect((result as any).status).toBe(403);
    // The error CODE still reports the tenant drain (it is the longer-lived,
    // agent-visible condition and #2774's clients parse it); only the action
    // SET intersects. Asserting the code here also pins that this 403 came
    // from the tenant-drain branch — i.e. the tenant state really was
    // 'draining' and the refusal is the intersection at work, not the device
    // branch having quietly won instead.
    expect((result as any).body).toEqual({ error: 'tenant_offboarding' });
  });

  it('still allows rotate-token/confirm when BOTH drains apply (the CONFIRM half is in both sets)', async () => {
    vi.mocked(getAgentTenantState).mockResolvedValue('draining');
    vi.mocked(isDeviceUninstallDraining).mockResolvedValue(true);
    buildSelectMock([makeDevice({ status: 'decommissioned' })]);

    const c = createContext({
      token: VALID_TOKEN,
      path: '/api/v1/agents/agent-1/rotate-token/confirm',
    });
    const next = vi.fn().mockResolvedValue(undefined);

    await agentAuthMiddleware(c, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('still allows heartbeat when BOTH drains apply (positive control: the intersection is not an empty set)', async () => {
    // Without this, the two refusals above would also pass if the
    // intersection were computed as {} and the whole surface were blocked —
    // the uninstall would then be undeliverable, which is the opposite
    // failure and just as bad.
    vi.mocked(getAgentTenantState).mockResolvedValue('draining');
    vi.mocked(isDeviceUninstallDraining).mockResolvedValue(true);
    buildSelectMock([makeDevice({ status: 'decommissioned' })]);

    const c = createContext({ token: VALID_TOKEN, path: '/api/v1/agents/agent-1/heartbeat' });
    const next = vi.fn().mockResolvedValue(undefined);

    await agentAuthMiddleware(c, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('a TENANT drain keeps rotate-token (the #2774 surface is unchanged)', async () => {
    // The two drain kinds have different action sets on purpose. An offboarding
    // customer's machines are legitimately alive and still need rotations to
    // complete; a removed machine does not.
    vi.mocked(getAgentTenantState).mockResolvedValue('draining');
    vi.mocked(isDeviceUninstallDraining).mockResolvedValue(false);
    buildSelectMock([makeDevice({ status: 'online' })]);

    const c = createContext({ token: VALID_TOKEN, path: '/api/v1/agents/agent-1/rotate-token' });
    const next = vi.fn().mockResolvedValue(undefined);

    await agentAuthMiddleware(c, next);

    expect(next).toHaveBeenCalledTimes(1);
  });
});

// #3986 fix round 1, MEDIUM-1 — the drain path predicate and the self-managed
// DB-context predicate are both anchored ABSOLUTELY on the core mount, not on
// trailing segments.
describe('agentAuthMiddleware - core agent path anchoring (#3986)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.mocked(getRedis).mockReturnValue({} as any);
    vi.mocked(getAgentTenantState).mockResolvedValue('active');
    vi.mocked(isDeviceUninstallDraining).mockResolvedValue(false);
    vi.mocked(rateLimiter).mockResolvedValue({
      allowed: true,
      remaining: 100,
      resetAt: new Date(Date.now() + 60_000),
    });
  });

  it('pins CORE_AGENT_MOUNT_SEGMENTS to the actual mount lines in index.ts', async () => {
    // The predicate hardcodes ['api','v1','agents']. If the mount ever moves,
    // drain mode fails CLOSED (refuses the whole fleet) — a silent, fleet-wide
    // outage. Catch it here instead.
    const { readFileSync } = await import('node:fs');
    const indexSource = readFileSync(
      new URL('../index.ts', import.meta.url),
      'utf-8',
    );
    expect(indexSource).toContain("app.route('/api/v1', api)");
    expect(indexSource).toContain("api.route('/agents', agentRoutes)");
    // Occurrence counts, not just presence: a SECOND mount of either sub-app
    // (e.g. agentRoutes also mounted under another prefix) would leave both
    // strings intact while giving agent requests a path shape the anchored
    // predicate refuses during a drain.
    expect(indexSource.split("api.route('/agents', agentRoutes)")).toHaveLength(2);
    expect(indexSource.split("app.route('/api/v1', api)")).toHaveLength(2);
    // Residual limitation, stated rather than papered over: this is still a
    // source-text check. Re-mounting `agentRoutes` inside a DIFFERENT sub-app
    // whose own prefix is not `/api/v1` would slip past it. Anchoring fails
    // CLOSED in that case (drain mode refuses), so the blast radius is a loud
    // refusal, not a silent admit.
  });

  it('a crafted `agents/<id>/<action>` TAIL under an extension mount does not opt out of the request DB context', async () => {
    // Same shape as the drain hole, on the self-managed-context predicate. The
    // trailing-segment match used to let any path ending in `heartbeat` skip
    // the request-long org wrap; a handler that assumed the ambient context
    // would then run contextless, which under RLS is a silent zero-row read.
    buildSelectMock([makeDevice({ status: 'online' })]);

    const c = createContext({
      token: VALID_TOKEN,
      path: '/api/v1/ext/acme/agent/agent-1/agents/agent-1/heartbeat',
    });
    const next = vi.fn().mockResolvedValue(undefined);

    await agentAuthMiddleware(c, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(vi.mocked(withDbAccessContext)).toHaveBeenCalledTimes(1);
  });

  it('the REAL core heartbeat still opts out of the request DB context', async () => {
    // Positive control: the anchoring must not have broken the #1105 opt-out
    // for the three core routes that genuinely self-manage their context.
    buildSelectMock([makeDevice({ status: 'online' })]);

    const c = createContext({ token: VALID_TOKEN, path: '/api/v1/agents/agent-1/heartbeat' });
    const next = vi.fn().mockResolvedValue(undefined);

    await agentAuthMiddleware(c, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(vi.mocked(withDbAccessContext)).not.toHaveBeenCalled();
  });

  it('a crafted TAIL is refused during a TENANT drain too, not just a device drain', async () => {
    vi.mocked(getAgentTenantState).mockResolvedValue('draining');
    buildSelectMock([makeDevice({ status: 'online' })]);

    const c = createContext({
      token: VALID_TOKEN,
      path: '/api/v1/ext/acme/agent/agent-1/agents/agent-1/rotate-token',
    });
    const next = vi.fn();

    const result = await agentAuthMiddleware(c, next);

    expect(next).not.toHaveBeenCalled();
    expect((result as any).status).toBe(403);
    expect((result as any).body).toEqual({ error: 'tenant_offboarding' });
  });
});

describe('agentAuthMiddleware - per-org rate limit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.mocked(getRedis).mockReturnValue({} as any);
    vi.mocked(getAgentTenantState).mockResolvedValue('active');
  });

  it('returns 429 with org_rate_limit_exceeded body and Retry-After:60 when org limit is exceeded', async () => {
    buildSelectMock([makeDevice()]);

    // Per-agent passes, per-org fails
    vi.mocked(rateLimiter)
      .mockResolvedValueOnce({ allowed: true, remaining: 119, resetAt: new Date(Date.now() + 60_000) })
      .mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt: new Date(Date.now() + 60_000) });

    const c = createContext({ token: VALID_TOKEN, agentId: 'agent-1' });
    const next = vi.fn();

    const result = await agentAuthMiddleware(c, next);

    // Middleware returned a Response (json call) without invoking next
    expect(next).not.toHaveBeenCalled();
    expect((result as any).status).toBe(429);
    expect((result as any).body).toEqual({ error: 'org_rate_limit_exceeded' });

    const headers = c._getResponseHeaders();
    expect(headers['Retry-After']).toBe('60');

    // Verify the org rate limiter was called with the expected key + default 600/60
    expect(rateLimiter).toHaveBeenNthCalledWith(2, expect.anything(), 'agent_org_rate:org-1', 600, 60);

    // Ordering invariant: the tenant-status gate runs AFTER the rate limiters,
    // so an org-limit-exceeded request short-circuits to 429 WITHOUT driving an
    // (uncached) tenant lookup. Pins the DoS-hardening order.
    expect(getAgentTenantState).not.toHaveBeenCalled();
  });

  // #2728 — the ceiling is now resolved by services/agentOrgRateLimit (scaled
  // by enrolled device count, with AGENT_ORG_RATE_LIMIT_PER_MIN as the floor).
  // The middleware's contract is simply to apply whatever the resolver returns;
  // the floor/scaling/ceiling math is covered in agentOrgRateLimit.test.ts.
  it('applies the ceiling returned by the resolver to the org bucket', async () => {
    buildSelectMock([makeDevice()]);
    vi.mocked(resolveOrgRateLimit).mockResolvedValue(900);

    vi.mocked(rateLimiter)
      .mockResolvedValueOnce({ allowed: true, remaining: 100, resetAt: new Date(Date.now() + 60_000) })
      .mockResolvedValueOnce({ allowed: true, remaining: 800, resetAt: new Date(Date.now() + 60_000) });

    const c = createContext({ token: VALID_TOKEN });
    const next = vi.fn();

    await agentAuthMiddleware(c, next);

    expect(resolveOrgRateLimit).toHaveBeenCalledWith(expect.anything(), 'org-1');
    expect(rateLimiter).toHaveBeenNthCalledWith(2, expect.anything(), 'agent_org_rate:org-1', 900, 60);
  });

  it('triggers per-agent limit independently of per-org (does not increment org bucket)', async () => {
    buildSelectMock([makeDevice()]);

    // Per-agent limit fails — per-org limiter must NOT be called
    vi.mocked(rateLimiter).mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      resetAt: new Date(Date.now() + 30_000),
    });

    const c = createContext({ token: VALID_TOKEN });
    const next = vi.fn();

    await expect(agentAuthMiddleware(c, next)).rejects.toMatchObject({
      status: 429,
      message: 'Agent rate limit exceeded',
    });

    // Only the per-agent limiter should have been called
    expect(rateLimiter).toHaveBeenCalledTimes(1);
    expect(rateLimiter).toHaveBeenCalledWith(expect.anything(), 'agent_rate:agent-1', 120, 60);
    expect(next).not.toHaveBeenCalled();
  });

  it('passes both limits and proceeds to next() when under both budgets', async () => {
    buildSelectMock([makeDevice()]);

    vi.mocked(rateLimiter)
      .mockResolvedValueOnce({ allowed: true, remaining: 119, resetAt: new Date(Date.now() + 60_000) })
      .mockResolvedValueOnce({ allowed: true, remaining: 599, resetAt: new Date(Date.now() + 60_000) });

    const c = createContext({ token: VALID_TOKEN });
    const next = vi.fn().mockResolvedValue(undefined);

    await agentAuthMiddleware(c, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(c._getResponse()).toBeNull();
    expect(rateLimiter).toHaveBeenCalledTimes(2);
    expect(c.get('agent')).toMatchObject({
      deviceId: 'device-1',
      agentId: 'agent-1',
      orgId: 'org-1',
      siteId: 'site-1',
      role: 'agent',
    });
  });

  it('authenticates watchdog-scoped tokens as watchdog role', async () => {
    buildSelectMock([
      makeDevice({
        agentTokenHash: sha('brz_agent_token'),
        watchdogTokenHash: sha('brz_watchdog_token'),
      }),
    ]);

    vi.mocked(rateLimiter)
      .mockResolvedValueOnce({ allowed: true, remaining: 119, resetAt: new Date(Date.now() + 60_000) })
      .mockResolvedValueOnce({ allowed: true, remaining: 599, resetAt: new Date(Date.now() + 60_000) });

    const c = createContext({ token: 'brz_watchdog_token' });
    const next = vi.fn().mockResolvedValue(undefined);

    await agentAuthMiddleware(c, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(c.get('agent')).toMatchObject({
      deviceId: 'device-1',
      agentId: 'agent-1',
      orgId: 'org-1',
      siteId: 'site-1',
      role: 'watchdog',
    });
  });
});

// Issue #2728 — the org bucket is shared with no per-device fairness, so a
// fleet of chatty heartbeats could drain it and starve the once-per-24h patch
// upload that carries operator-facing posture. A reserved overflow lane keeps
// low-frequency inventory ingest admissible.
describe('agentAuthMiddleware - reserved ingest lane (#2728)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.mocked(getRedis).mockReturnValue({} as any);
    vi.mocked(getAgentTenantState).mockResolvedValue('active');
    vi.mocked(resolveOrgRateLimit).mockResolvedValue(600);
  });

  // The headline behavior of #2728: the org ceiling must actually track the
  // resolved (device-count-scaled) limit end-to-end through the middleware,
  // and the reserved lane must be sized off that SCALED value — not off the
  // floor.
  it('applies the resolved device-count-scaled ceiling to the org bucket', async () => {
    buildSelectMock([makeDevice()]);
    vi.mocked(resolveOrgRateLimit).mockResolvedValue(20_000);
    vi.mocked(rateLimiter)
      .mockResolvedValueOnce({ allowed: true, remaining: 119, resetAt: new Date(Date.now() + 60_000) })
      .mockResolvedValueOnce({ allowed: true, remaining: 19_999, resetAt: new Date(Date.now() + 60_000) });

    const c = createContext({ token: VALID_TOKEN, path: '/api/v1/agents/agent-1/heartbeat' });
    await agentAuthMiddleware(c, vi.fn().mockResolvedValue(undefined));

    expect(rateLimiter).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      'agent_org_rate:org-1',
      20_000,
      60,
    );
  });

  it('sizes the reserved lane from the scaled ceiling, not the floor', async () => {
    buildSelectMock([makeDevice()]);
    vi.mocked(resolveOrgRateLimit).mockResolvedValue(20_000);
    vi.mocked(rateLimiter)
      .mockResolvedValueOnce({ allowed: true, remaining: 119, resetAt: new Date(Date.now() + 60_000) })
      .mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt: new Date(Date.now() + 60_000) })
      .mockResolvedValueOnce({ allowed: true, remaining: 3_999, resetAt: new Date(Date.now() + 60_000) });

    const c = createContext({
      token: VALID_TOKEN,
      path: '/api/v1/agents/agent-1/patches/pending',
    });
    await agentAuthMiddleware(c, vi.fn().mockResolvedValue(undefined));

    // 20% of 20000.
    expect(rateLimiter).toHaveBeenNthCalledWith(
      3,
      expect.anything(),
      'agent_org_rate_reserved:org-1',
      4_000,
      60,
    );
  });

  const overOrgLimit = () => {
    vi.mocked(rateLimiter)
      // per-agent: fine
      .mockResolvedValueOnce({ allowed: true, remaining: 119, resetAt: new Date(Date.now() + 60_000) })
      // per-org: exhausted
      .mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt: new Date(Date.now() + 30_000) });
  };

  it('admits a patch upload from the reserved lane when the org bucket is drained', async () => {
    buildSelectMock([makeDevice()]);
    overOrgLimit();
    // reserved lane: has room
    vi.mocked(rateLimiter).mockResolvedValueOnce({
      allowed: true,
      remaining: 119,
      resetAt: new Date(Date.now() + 60_000),
    });

    const c = createContext({
      token: VALID_TOKEN,
      path: '/api/v1/agents/agent-1/patches/pending',
    });
    const next = vi.fn().mockResolvedValue(undefined);

    await agentAuthMiddleware(c, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(c._getResponse()).toBeNull();
    expect(rateLimiter).toHaveBeenNthCalledWith(
      3,
      expect.anything(),
      'agent_org_rate_reserved:org-1',
      120, // 20% of the 600 floor
      60,
    );
  });

  it('rejects a patch upload when the reserved lane is ALSO exhausted', async () => {
    buildSelectMock([makeDevice()]);
    overOrgLimit();
    vi.mocked(rateLimiter).mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      resetAt: new Date(Date.now() + 30_000),
    });

    const c = createContext({
      token: VALID_TOKEN,
      path: '/api/v1/agents/agent-1/patches/pending',
    });
    const next = vi.fn();

    const result = await agentAuthMiddleware(c, next);

    expect(next).not.toHaveBeenCalled();
    expect((result as any).status).toBe(429);
    expect((result as any).body).toEqual({ error: 'org_rate_limit_exceeded' });
  });

  it('does NOT consult the reserved lane for high-frequency heartbeat traffic', async () => {
    buildSelectMock([makeDevice()]);
    overOrgLimit();

    const c = createContext({
      token: VALID_TOKEN,
      path: '/api/v1/agents/agent-1/heartbeat',
    });
    const next = vi.fn();

    const result = await agentAuthMiddleware(c, next);

    expect(next).not.toHaveBeenCalled();
    expect((result as any).status).toBe(429);
    // Only per-agent + per-org — the reserved bucket must not be spent by the
    // very traffic class it exists to protect against.
    expect(rateLimiter).toHaveBeenCalledTimes(2);
  });

  it('costs no extra Redis round-trip when the org bucket is not exhausted', async () => {
    buildSelectMock([makeDevice()]);
    vi.mocked(rateLimiter)
      .mockResolvedValueOnce({ allowed: true, remaining: 119, resetAt: new Date(Date.now() + 60_000) })
      .mockResolvedValueOnce({ allowed: true, remaining: 599, resetAt: new Date(Date.now() + 60_000) });

    const c = createContext({
      token: VALID_TOKEN,
      path: '/api/v1/agents/agent-1/patches/pending',
    });
    const next = vi.fn().mockResolvedValue(undefined);

    await agentAuthMiddleware(c, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(rateLimiter).toHaveBeenCalledTimes(2);
  });

  // Regression guard: an earlier revision of this fix derived Retry-After from
  // `resetAt`. Under SUSTAINED saturation `resetAt` is when one slot frees —
  // i.e. ~now — so the header collapsed to 1s and turned agent backoff into a
  // hot loop, amplifying the overload. Retry-After must advertise the full
  // window regardless of how close the next slot is.
  it('advertises the full window even when the next slot frees immediately', async () => {
    buildSelectMock([makeDevice()]);
    vi.mocked(rateLimiter)
      .mockResolvedValueOnce({ allowed: true, remaining: 119, resetAt: new Date(Date.now() + 60_000) })
      // Deeply saturated: oldest entry is ~60s old, so resetAt is ~now.
      .mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt: new Date(Date.now() + 50) });

    const c = createContext({ token: VALID_TOKEN, path: '/api/v1/agents/agent-1/heartbeat' });

    await agentAuthMiddleware(c, vi.fn());

    expect(c._getResponseHeaders()['Retry-After']).toBe('60');
  });
});

// Task 18: agent token auto-suspend (cross-tenant probe defense).
describe('Task 18 — agentAuthMiddleware rejects suspended tokens', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getRedis).mockReturnValue({} as any);
  });

  it('returns 401 when the device has agentTokenSuspendedAt set', async () => {
    buildSelectMock([
      makeDevice({ agentTokenSuspendedAt: new Date('2026-05-25T10:00:00Z') }),
    ]);
    // Rate limiter must NOT be consulted — auth gate fails earlier.
    vi.mocked(rateLimiter).mockResolvedValue({
      allowed: true,
      remaining: 119,
      resetAt: new Date(Date.now() + 60_000),
    });

    const c = createContext({ token: VALID_TOKEN });
    const next = vi.fn();

    await expect(agentAuthMiddleware(c, next)).rejects.toMatchObject({
      status: 401,
      message: 'Invalid agent credentials',
    });
    expect(next).not.toHaveBeenCalled();
    // Auth gate fails before rate limiter is touched.
    expect(rateLimiter).not.toHaveBeenCalled();
  });

  it('does NOT leak the suspension reason in the 401 response', async () => {
    buildSelectMock([
      makeDevice({
        agentTokenSuspendedAt: new Date('2026-05-25T10:00:00Z'),
        agentTokenSuspendedReason: 'cross-tenant-probe',
      }),
    ]);

    const c = createContext({ token: VALID_TOKEN });
    const next = vi.fn();

    let thrown: unknown;
    try {
      await agentAuthMiddleware(c, next);
    } catch (err) {
      thrown = err;
    }

    const message = (thrown as { message?: string })?.message ?? '';
    expect(message).not.toContain('cross-tenant-probe');
    expect(message).not.toContain('suspended');
    expect(message).toBe('Invalid agent credentials');
  });

  it('proceeds normally when agentTokenSuspendedAt is null', async () => {
    buildSelectMock([makeDevice({ agentTokenSuspendedAt: null })]);
    vi.mocked(rateLimiter)
      .mockResolvedValueOnce({ allowed: true, remaining: 119, resetAt: new Date(Date.now() + 60_000) })
      .mockResolvedValueOnce({ allowed: true, remaining: 599, resetAt: new Date(Date.now() + 60_000) });

    const c = createContext({ token: VALID_TOKEN });
    const next = vi.fn().mockResolvedValue(undefined);

    await agentAuthMiddleware(c, next);

    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('Task 18 — suspendAgentToken helper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes agentTokenSuspendedAt + reason via UPDATE', async () => {
    const setMock = vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    });
    vi.mocked(db.update).mockReturnValue({ set: setMock } as any);

    await suspendAgentToken('device-1', 'cross-tenant-probe');

    expect(setMock).toHaveBeenCalledTimes(1);
    const arg = setMock.mock.calls[0]?.[0];
    expect(arg).toMatchObject({ agentTokenSuspendedReason: 'cross-tenant-probe' });
    expect(arg.agentTokenSuspendedAt).toBeInstanceOf(Date);
  });

  it('truncates reasons longer than 100 chars to fit the column', async () => {
    const setMock = vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    });
    vi.mocked(db.update).mockReturnValue({ set: setMock } as any);

    const longReason = 'x'.repeat(250);
    // Cast past the AgentTokenSuspendReason union: the canonical reasons are all
    // < 100 chars, but this exercises the defensive runtime .slice(0, 100) that
    // guards the varchar(100) column against any future non-canonical caller.
    await suspendAgentToken('device-1', longReason as never);

    const arg = setMock.mock.calls[0]?.[0];
    expect(arg.agentTokenSuspendedReason.length).toBe(100);
  });

  it('swallows DB errors so callers never crash', async () => {
    vi.mocked(db.update).mockImplementation(() => {
      throw new Error('connection refused');
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      suspendAgentToken('device-1', 'cross-tenant-probe')
    ).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalledWith(
      '[agentAuth] suspendAgentToken failed',
      expect.objectContaining({ deviceId: 'device-1' })
    );
    errSpy.mockRestore();
  });
});

// Task 19: per-source-IP rate limit + IP-change audit.
describe('Task 19 — per-source-IP rate limit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getRedis).mockReturnValue({
      set: vi.fn(async () => 'OK'),
    } as any);
    vi.mocked(getTrustedClientIp).mockReturnValue('203.0.113.5');
    // db.update is invoked fire-and-forget for last_seen_ip persistence;
    // mock it so the chain doesn't throw.
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    } as any);
  });

  it('rejects with 429 when the per-IP bucket is exhausted (before per-agent and per-org)', async () => {
    buildSelectMock([makeDevice({ lastSeenIp: '203.0.113.5' })]);

    // The first rateLimiter call is the per-IP check — make it fail.
    vi.mocked(rateLimiter).mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      resetAt: new Date(Date.now() + 45_000),
    });

    const c = createContext({ token: VALID_TOKEN });
    const next = vi.fn();

    await expect(agentAuthMiddleware(c, next)).rejects.toMatchObject({
      status: 429,
      message: 'Agent per-source-IP rate limit exceeded',
    });

    // Only the per-IP limiter should have been called — per-agent + per-org
    // are skipped so the stolen-IP source can't burn the legit budgets.
    expect(rateLimiter).toHaveBeenCalledTimes(1);
    expect(rateLimiter).toHaveBeenCalledWith(
      expect.anything(),
      'agent_rate_ip:device-1:203.0.113.5',
      30,
      60,
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('checks the per-IP bucket BEFORE the per-agent + per-org buckets', async () => {
    buildSelectMock([makeDevice({ lastSeenIp: '203.0.113.5' })]);
    vi.mocked(rateLimiter)
      .mockResolvedValueOnce({ allowed: true, remaining: 29, resetAt: new Date(Date.now() + 60_000) })
      .mockResolvedValueOnce({ allowed: true, remaining: 119, resetAt: new Date(Date.now() + 60_000) })
      .mockResolvedValueOnce({ allowed: true, remaining: 599, resetAt: new Date(Date.now() + 60_000) });

    const c = createContext({ token: VALID_TOKEN });
    const next = vi.fn().mockResolvedValue(undefined);

    await agentAuthMiddleware(c, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(rateLimiter).toHaveBeenCalledTimes(3);
    expect(rateLimiter).toHaveBeenNthCalledWith(1, expect.anything(), 'agent_rate_ip:device-1:203.0.113.5', 30, 60);
    expect(rateLimiter).toHaveBeenNthCalledWith(2, expect.anything(), 'agent_rate:agent-1', 120, 60);
    expect(rateLimiter).toHaveBeenNthCalledWith(3, expect.anything(), 'agent_org_rate:org-1', 600, 60);
  });

  it('skips the per-IP check entirely when the trusted client IP is unknown', async () => {
    vi.mocked(getTrustedClientIp).mockReturnValue('unknown');
    buildSelectMock([makeDevice()]);
    vi.mocked(rateLimiter)
      .mockResolvedValueOnce({ allowed: true, remaining: 119, resetAt: new Date(Date.now() + 60_000) })
      .mockResolvedValueOnce({ allowed: true, remaining: 599, resetAt: new Date(Date.now() + 60_000) });

    const c = createContext({ token: VALID_TOKEN });
    const next = vi.fn().mockResolvedValue(undefined);

    await agentAuthMiddleware(c, next);

    expect(rateLimiter).toHaveBeenCalledTimes(2);
    expect(rateLimiter).toHaveBeenNthCalledWith(1, expect.anything(), 'agent_rate:agent-1', 120, 60);
    expect(createAuditLogAsync).not.toHaveBeenCalled();
  });
});

describe('Task 19 — agent source-IP change audit', () => {
  let redisMock: { set: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    redisMock = { set: vi.fn(async () => 'OK') };
    vi.mocked(getRedis).mockReturnValue(redisMock as any);
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    } as any);
    // Allow all rate limiters in this block.
    vi.mocked(rateLimiter).mockResolvedValue({
      allowed: true,
      remaining: 99,
      resetAt: new Date(Date.now() + 60_000),
    });
  });

  it('does NOT audit when source IP matches lastSeenIp', async () => {
    vi.mocked(getTrustedClientIp).mockReturnValue('203.0.113.1');
    buildSelectMock([makeDevice({ lastSeenIp: '203.0.113.1' })]);

    const c = createContext({ token: VALID_TOKEN });
    await agentAuthMiddleware(c, vi.fn().mockResolvedValue(undefined));

    expect(createAuditLogAsync).not.toHaveBeenCalled();
    expect(redisMock.set).not.toHaveBeenCalled();
  });

  it('does NOT audit on first sighting (lastSeenIp is NULL) but still records the IP', async () => {
    vi.mocked(getTrustedClientIp).mockReturnValue('203.0.113.7');
    buildSelectMock([makeDevice({ lastSeenIp: null })]);

    const c = createContext({ token: VALID_TOKEN });
    await agentAuthMiddleware(c, vi.fn().mockResolvedValue(undefined));

    expect(createAuditLogAsync).not.toHaveBeenCalled();
    // last_seen_ip update is fire-and-forget — verify db.update was called.
    expect(db.update).toHaveBeenCalled();
  });

  it('audits ONCE when the IP changes (Redis SET NX returns OK)', async () => {
    vi.mocked(getTrustedClientIp).mockReturnValue('198.51.100.7');
    buildSelectMock([makeDevice({ lastSeenIp: '203.0.113.1' })]);

    const c = createContext({ token: VALID_TOKEN });
    await agentAuthMiddleware(c, vi.fn().mockResolvedValue(undefined));

    expect(redisMock.set).toHaveBeenCalledWith(
      'agent_ip_change:device-1:198.51.100.7',
      '1',
      'EX',
      24 * 60 * 60,
      'NX',
    );
    expect(createAuditLogAsync).toHaveBeenCalledTimes(1);
    expect(createAuditLogAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: 'org-1',
        actorType: 'agent',
        actorId: 'device-1',
        action: 'agent.source.ip.changed',
        resourceType: 'device',
        resourceId: 'device-1',
        details: { previousIp: '203.0.113.1', newIp: '198.51.100.7' },
        ipAddress: '198.51.100.7',
        result: 'success',
      }),
    );
  });

  it('dedupes audit events when the same (device, IP) pair is seen again within 24h (Redis SET NX returns null)', async () => {
    vi.mocked(getTrustedClientIp).mockReturnValue('198.51.100.7');
    redisMock.set.mockResolvedValueOnce(null); // dedup HIT — already logged
    buildSelectMock([makeDevice({ lastSeenIp: '203.0.113.1' })]);

    const c = createContext({ token: VALID_TOKEN });
    await agentAuthMiddleware(c, vi.fn().mockResolvedValue(undefined));

    expect(redisMock.set).toHaveBeenCalledTimes(1);
    expect(createAuditLogAsync).not.toHaveBeenCalled();
  });

  it('skips audit silently if Redis dedup write throws', async () => {
    vi.mocked(getTrustedClientIp).mockReturnValue('198.51.100.7');
    redisMock.set.mockRejectedValueOnce(new Error('redis down'));
    buildSelectMock([makeDevice({ lastSeenIp: '203.0.113.1' })]);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const c = createContext({ token: VALID_TOKEN });
    await agentAuthMiddleware(c, vi.fn().mockResolvedValue(undefined));

    expect(createAuditLogAsync).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith(
      '[agentAuth] ip-change dedup lookup failed:',
      expect.anything(),
    );
    errSpy.mockRestore();
  });
});
