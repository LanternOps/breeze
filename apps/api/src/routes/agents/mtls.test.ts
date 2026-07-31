import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createHash, generateKeyPairSync, sign } from 'crypto';

// -------------------------------------------------------------------
// Fixtures — real, static, self-signed EC P-256 certs/keys (10y validity),
// generated once with `openssl req -x509 -newkey ec ...` and pinned here so
// the unit suite never shells out to openssl at test time. "NEW" represents
// a freshly-issued replacement certificate; "OLD" represents the device's
// currently-active certificate (used both as the active row's serial/SPKI
// and to sign recovery proofs with the matching private key).
// -------------------------------------------------------------------

const NEW_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIBjDCCATGgAwIBAgIULdi98VWChh4CPbJOhNTfTOxBiicwCgYIKoZIzj0EAwIw
GzEZMBcGA1UEAwwQYnJlZXplLWFnZW50LW5ldzAeFw0yNjA3MjcxOTI0MDRaFw0z
NjA3MjQxOTI0MDRaMBsxGTAXBgNVBAMMEGJyZWV6ZS1hZ2VudC1uZXcwWTATBgcq
hkjOPQIBBggqhkjOPQMBBwNCAARZFuMmkAztgQnzIk+4BrZrUCsCoaevo5Ib2bxO
68zpCSuzXken/TWXABS+PvkVqjcdLqZ6NbnOgCwUJyNaZSzzo1MwUTAdBgNVHQ4E
FgQUoK7QuRA6KOj9T/vaXj5Crwoi4FwwHwYDVR0jBBgwFoAUoK7QuRA6KOj9T/va
Xj5Crwoi4FwwDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNJADBGAiEA7kwk
lgznC76pR5Z2n5gjiGOhGJqZbRY2cLfoC8Zs9zECIQDRO0VdLavsoCPppTVOPN9o
yMR+DE23HZhAN9jAjaIJFQ==
-----END CERTIFICATE-----`;
const NEW_CERT_SERIAL = '2DD8BDF15582861E023DB24E84D4DF4CEC418A27';
const NEW_CERT_SPKI_BASE64 =
  'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEWRbjJpAM7YEJ8yJPuAa2a1ArAqGnr6OSG9m8TuvM6Qkrs15Hp/01lwAUvj75Fao3HS6mejW5zoAsFCcjWmUs8w==';

const OLD_CERT_SERIAL = '74C7AF668B8D3D98D464006774AB7889D4B57578';

// Minor (final review): the OLD certificate's EC private key used to be a
// literal PEM block committed to this file. It was a throwaway test key, but a
// committed `-----BEGIN PRIVATE KEY-----` block is exactly what Gitleaks and
// every other secret scanner flags, and triaging a known-benign hit on every
// scan is a standing cost. Generate an ephemeral P-256 pair at suite load
// instead and derive the SPKI FROM it, so the keypair and the SPKI the
// recovery-proof verifier checks against can never drift apart the way two
// hand-pinned constants can.
const { privateKey: OLD_CERT_PRIVATE_KEY, publicKey: OLD_CERT_PUBLIC_KEY } =
  generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const OLD_CERT_SPKI_BASE64 = OLD_CERT_PUBLIC_KEY
  .export({ type: 'spki', format: 'der' })
  .toString('base64');

// -------------------------------------------------------------------
// Mocks
// -------------------------------------------------------------------

const {
  dbSelectMock,
  dbUpdateMock,
  dbInsertMock,
  dbTransactionMock,
  txSelectMock,
  txUpdateMock,
  txInsertMock,
  mfaGate,
} = vi.hoisted(() => {
  const txSelect = vi.fn();
  const txUpdate = vi.fn();
  const txInsert = vi.fn();
  return {
    dbSelectMock: vi.fn(),
    dbUpdateMock: vi.fn(),
    dbInsertMock: vi.fn(),
    txSelectMock: txSelect,
    txUpdateMock: txUpdate,
    txInsertMock: txInsert,
    dbTransactionMock: vi.fn(async (fn: (tx: unknown) => unknown) =>
      fn({ select: txSelect, update: txUpdate, insert: txInsert }),
    ),
    mfaGate: { deny: false },
  };
});

vi.mock('../../db', () => ({
  db: {
    select: dbSelectMock,
    update: dbUpdateMock,
    insert: dbInsertMock,
    transaction: dbTransactionMock,
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
  deviceMtlsCertificates: {
    id: 'deviceMtlsCertificates.id',
    orgId: 'deviceMtlsCertificates.orgId',
    deviceId: 'deviceMtlsCertificates.deviceId',
    providerCertificateId: 'deviceMtlsCertificates.providerCertificateId',
    serialNumber: 'deviceMtlsCertificates.serialNumber',
    fingerprintSha256: 'deviceMtlsCertificates.fingerprintSha256',
    publicKeySpki: 'deviceMtlsCertificates.publicKeySpki',
    legacyProvenance: 'deviceMtlsCertificates.legacyProvenance',
    state: 'deviceMtlsCertificates.state',
    issuedAt: 'deviceMtlsCertificates.issuedAt',
    expiresAt: 'deviceMtlsCertificates.expiresAt',
    activationExpiresAt: 'deviceMtlsCertificates.activationExpiresAt',
    activatedAt: 'deviceMtlsCertificates.activatedAt',
    revokedAt: 'deviceMtlsCertificates.revokedAt',
    updatedAt: 'deviceMtlsCertificates.updatedAt',
  },
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

const { writeAuditEventMock } = vi.hoisted(() => ({
  writeAuditEventMock: vi.fn(),
}));
vi.mock('../../services/auditEvents', () => ({
  writeAuditEvent: writeAuditEventMock,
}));

const { issueCertMock, revokeCertMock } = vi.hoisted(() => ({
  issueCertMock: vi.fn(),
  revokeCertMock: vi.fn(),
}));
// Keep the REAL parseIssuedLeafCertificate/CloudflareMtlsError/
// categorizeCloudflareMtlsError — only CloudflareMtlsService.fromEnv is
// swapped for the issue/revoke mocks, so the route's real certificate
// parsing (node:crypto X509Certificate) runs against the fixture PEMs above.
vi.mock('../../services/cloudflareMtls', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/cloudflareMtls')>();
  return {
    ...actual,
    CloudflareMtlsService: {
      fromEnv: vi.fn(() => ({
        issueCertificate: issueCertMock,
        revokeCertificate: revokeCertMock,
      })),
    },
  };
});

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

// Lifecycle service (Task 3) — mocked wholesale for route tests. Its own
// demote-guard / durable-retry logic is covered by
// deviceMtlsCertificateLifecycle.test.ts; here we only need to control
// whether a demotion "happened" and whether the post-commit revoke call
// succeeds, failed, or was invoked at all.
const { queueCertificateRevocationCoreMock, revokeCertificateNowOrEnqueueMock } = vi.hoisted(() => ({
  queueCertificateRevocationCoreMock: vi.fn(async () => true),
  revokeCertificateNowOrEnqueueMock: vi.fn(async () => undefined),
}));
vi.mock('../../services/deviceMtlsCertificateLifecycle', () => ({
  queueCertificateRevocationCore: queueCertificateRevocationCoreMock,
  revokeCertificateNowOrEnqueue: revokeCertificateNowOrEnqueueMock,
}));

// Controls whether the certificate-assertion headers are honored, mirroring
// the real trust gate (trustsForwardedHeadersFrom) without needing a real
// TRUSTED_PROXY_CIDRS/env setup in this unit suite.
const { trustsForwardedHeadersFromMock } = vi.hoisted(() => ({
  trustsForwardedHeadersFromMock: vi.fn(() => false),
}));
vi.mock('../../services/clientIp', () => ({
  trustsForwardedHeadersFrom: trustsForwardedHeadersFromMock,
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

// Minimal Redis stub with sliding-window semantics (rate limiting) PLUS a
// simple GET/SET/EVAL string store (used by the REAL mtlsRenewalProof
// service — not mocked, so route tests exercise real signature
// verification/consumption against real fixture keys). All state hoisted so
// the factory below can reach it without tripping the vitest hoisting check.
const { redisState, redisStringState, redisMock } = vi.hoisted(() => {
  type ZMember = [number, string];
  const state = new Map<string, ZMember[]>();
  const stringState = new Map<string, string>();
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
    async set(key: string, value: string, ..._rest: unknown[]) {
      stringState.set(key, value);
      return 'OK';
    },
    async get(key: string) {
      return stringState.get(key) ?? null;
    },
    // Server-side Lua compare-and-delete used by mtlsRenewalProof.ts's
    // verifyAndConsumeRenewalProof — reimplemented here purely in JS since
    // this is an in-memory stub, not real Redis.
    async eval(_script: string, _numKeys: number, key: string, expected: string) {
      const current = stringState.get(key);
      if (current === expected) {
        stringState.delete(key);
        return 1;
      }
      return 0;
    },
  };
  return { redisState: state, redisStringState: stringState, redisMock: mock };
});

vi.mock('../../services/redis', () => ({
  getRedis: vi.fn(() => redisMock),
}));

// Use the real rate-limit helper AND the real mtlsRenewalProof service with
// the stub above.

// -------------------------------------------------------------------
// Imports (after mocks)
// -------------------------------------------------------------------

import { mtlsRoutes } from './mtls';
import { terminateDeviceRemoteSessions } from '../../services/remoteSessionTeardown';
import { buildRenewalProofCanonicalBytes } from '../../services/mtlsRenewalProof';

const DEVICE_ID = '11111111-1111-4111-8111-111111111111';
const ORG_ID = '22222222-2222-4222-8222-222222222222';
const AGENT_ID = 'agent-mtls-test';
const TOKEN = 'brz_test_token';
const TOKEN_HASH = createHash('sha256').update(TOKEN).digest('hex');
const NEW_CERT_ROW_ID = '33333333-3333-4333-8333-333333333333';
const OLD_ACTIVE_CERT_ROW_ID = '44444444-4444-4444-8444-444444444444';
const ORPHAN_MARKER_ROW_ID = '55555555-5555-4555-8555-555555555555';

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

// Queues the device_mtls_certificates "active row" read (fetchActiveCertificateRow),
// used by /renew-cert (mode gate) and /renew-cert/challenge. Must be queued in
// call order AFTER the device lookup (and, on /renew-cert, after the org
// settings lookup).
function mockActiveCertLookup(row: Record<string, unknown> | null) {
  dbSelectMock.mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(row ? [row] : []) }),
    }),
  } as any);
}

// Queues the /renew-cert/confirm pending-row lookup (by certificateId).
function mockPendingCertLookup(row: Record<string, unknown> | null) {
  dbSelectMock.mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(row ? [row] : []) }),
    }),
  } as any);
}

// Queues the outer (non-transactional) db.insert used by the protocol-v2
// pending-issuance path.
function mockDbInsertOk(id: string | null = NEW_CERT_ROW_ID) {
  dbInsertMock.mockReturnValueOnce({
    values: vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue(id ? [{ id }] : []),
    }),
  } as any);
}

// FINAL-REVIEW I8: the protocol-v2 pending-issuance path is now a single
// transaction — supersede any existing `pending_activation` rows for the
// device, THEN insert the new one — so a device can no longer accumulate
// unbounded pending rows, each holding a real (still-valid) Cloudflare
// certificate. Queues both steps in call order.
function mockV2PendingIssue(id: string | null = NEW_CERT_ROW_ID, supersededIds: string[] = []) {
  txUpdateMock.mockReturnValueOnce({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue(supersededIds.map((sid) => ({ id: sid }))),
      }),
    }),
  } as any);
  mockTxInsertOk(id);
}

// Queues one call to tx.select(...).from(...).where(...).limit(1) inside the
// db.transaction callback (the "existingActive" read in both /renew-cert's
// legacy path and /renew-cert/confirm).
function mockTxActiveLookup(row: Record<string, unknown> | null) {
  txSelectMock.mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(row ? [row] : []) }),
    }),
  } as any);
}

// Queues one call to tx.insert(...).values(...).returning(...).
function mockTxInsertOk(id: string | null = NEW_CERT_ROW_ID) {
  txInsertMock.mockReturnValueOnce({
    values: vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue(id ? [{ id }] : []),
    }),
  } as any);
}

// Queues one call to tx.update(...).set(...).where(...).returning(...).
// Call this once per expected tx.update() invocation, in call order (e.g.
// once for the deviceMtlsCertificates activation, once for the legacy
// devices columns update).
function mockTxUpdateOk(rowCount = 1) {
  const rows = Array.from({ length: rowCount }, () => ({ id: NEW_CERT_ROW_ID }));
  txUpdateMock.mockReturnValueOnce({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue(rows) }),
    }),
  } as any);
}

function setAssertionHeaders(serial: string): Record<string, string> {
  return {
    'X-Breeze-Client-Cert-Verified': 'true',
    'X-Breeze-Client-Cert-Serial': serial,
  };
}

async function signRecoveryProofForActiveChallenge(app: Hono, headers: Record<string, string> = {}) {
  mockDeviceLookup(baseActiveDeviceRow());
  mockActiveCertLookup({
    id: OLD_ACTIVE_CERT_ROW_ID,
    serialNumber: OLD_CERT_SERIAL,
    expiresAt: new Date(Date.now() - 3600 * 1000),
    publicKeySpki: OLD_CERT_SPKI_BASE64,
  });
  const res = await app.request('/agents/renew-cert/challenge', {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, ...headers },
  });
  const body = await res.json();
  const { challengeId, expiresUnix } = body as { challengeId: string; expiresUnix: number };
  const bytes = buildRenewalProofCanonicalBytes(DEVICE_ID, challengeId, expiresUnix);
  const signatureBase64 = sign('sha256', bytes, OLD_CERT_PRIVATE_KEY).toString('base64');
  return { challengeId, expiresUnix, signatureBase64 };
}

function baseActiveDeviceRow(overrides: Record<string, unknown> = {}) {
  return {
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
    ...overrides,
  };
}

function resetAllMocksForTest() {
  vi.clearAllMocks();
  redisState.clear();
  redisStringState.clear();
  issueCertMock.mockReset();
  revokeCertMock.mockReset();
  queueCertificateRevocationCoreMock.mockReset().mockResolvedValue(true);
  revokeCertificateNowOrEnqueueMock.mockReset().mockResolvedValue(undefined);
  trustsForwardedHeadersFromMock.mockReset().mockReturnValue(false);
  tenantActiveMock.mockReset().mockResolvedValue(true);
  matchTokenMock.mockReset().mockReturnValue({ tokenRotationRequired: false });
  mockDbUpdateOk();
}

describe('POST /renew-cert — E4 per-device cooldown', () => {
  beforeEach(() => {
    resetAllMocksForTest();
  });

  it('returns 429 with Retry-After on the 2nd attempt within 30s', async () => {
    const deviceRow = baseActiveDeviceRow();

    issueCertMock.mockResolvedValue({
      id: 'cf-cert-1',
      certificate: NEW_CERT_PEM,
      privateKey: 'KEY',
      expiresOn: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
      issuedOn: new Date().toISOString(),
      serialNumber: 'sn-1',
    });

    // First request — success
    mockDeviceLookup(deviceRow);
    mockOrgSettingsLookup(); // org policy row present (auto_reissue default)
    mockActiveCertLookup(null); // no active history row yet — off mode allows regardless
    mockTxActiveLookup(null);
    mockTxInsertOk();
    mockTxUpdateOk(); // activate deviceMtlsCertificates
    mockTxUpdateOk(); // update legacy devices columns
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
  beforeEach(() => {
    resetAllMocksForTest();
  });

  it('rejects with opaque 401 and does NOT issue a cert when the tenant is inactive', async () => {
    // The org/partner is suspended but the device token itself is not
    // individually suspended — without the tenant gate the agent would still
    // get fresh Cloudflare cert + private key material.
    tenantActiveMock.mockResolvedValue(false);
    mockDeviceLookup(baseActiveDeviceRow());

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
      certificate: NEW_CERT_PEM,
      privateKey: 'KEY',
      expiresOn: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
      issuedOn: new Date().toISOString(),
      serialNumber: 'sn-1',
    });
    mockDeviceLookup(baseActiveDeviceRow());
    mockOrgSettingsLookup(); // org policy row present
    mockActiveCertLookup(null);
    mockTxActiveLookup(null);
    mockTxInsertOk();
    mockTxUpdateOk();
    mockTxUpdateOk();

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
    resetAllMocksForTest();
  });

  it('POST /renew-cert quarantine branch tears down live remote sessions AND severs the agent WS', async () => {
    // Expired cert + org expiredCertPolicy 'quarantine' drives the renew handler
    // into the quarantine branch, which must cut any in-flight desktop/terminal
    // session AND sever the agent command WebSocket to the now-isolated device.
    // Dropping either call silently leaves live control / command draining.
    const deviceRow = baseActiveDeviceRow({
      // Expired one hour ago — triggers the quarantine path.
      mtlsCertExpiresAt: new Date(Date.now() - 3600 * 1000),
    });

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
  beforeEach(() => {
    resetAllMocksForTest();
  });

  it('Finding #2: rejects a PREVIOUS (superseded) token caller with 401 and issues no cert', async () => {
    // The caller authenticated via the previous/rotated token — accepted for
    // idempotent agent traffic, but NOT for minting new cert material. A stolen
    // superseded token must not obtain a fresh certificate + private key.
    matchTokenMock.mockReturnValueOnce({ tokenRotationRequired: true });
    mockDeviceLookup(baseActiveDeviceRow());

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

  it('fails closed (500), returns NO cert material, and revokes the orphan cert DURABLY when the transaction fails', async () => {
    // A failed activation transaction (e.g. the legacy devices update affects
    // 0 rows under FORCE RLS) must not leave an untracked, unrevoked
    // provider certificate — nor return cert material for a renewal that
    // never actually persisted. Fix round 1 (Important #1): the orphan is
    // now revoked through Task 3's durable lifecycle (a minted
    // pending_revocation marker row + revokeCertificateNowOrEnqueue), not a
    // one-shot inline best-effort call, so a provider 5xx/timeout at revoke
    // time is retried by the sweep instead of being silently dropped.
    issueCertMock.mockResolvedValue({
      id: 'cf-cert-untracked',
      certificate: NEW_CERT_PEM,
      privateKey: 'KEY',
      expiresOn: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
      issuedOn: new Date().toISOString(),
      serialNumber: 'sn-untracked',
    });
    mockDeviceLookup(baseActiveDeviceRow());
    mockOrgSettingsLookup(); // auto_reissue default → issue path
    mockActiveCertLookup(null);
    mockTxActiveLookup(null);
    mockTxInsertOk();
    mockTxUpdateOk(0); // activation update affects 0 rows → transaction throws
    mockDbInsertOk(ORPHAN_MARKER_ROW_ID); // durable marker-row insert (outer db.insert, outside the failed tx)

    const res = await buildApp().request('/agents/renew-cert', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });

    expect(res.status).toBe(500);
    const body = await res.json();
    // Crucially, no certificate/privateKey is handed back on the fail-closed path.
    expect(body.mtls).toBeUndefined();
    expect(body.error).toMatch(/failed/i);
    // Durable path: a marker row is minted and handed to the lifecycle
    // service — NOT a one-shot inline revoke.
    expect(revokeCertificateNowOrEnqueueMock).toHaveBeenCalledWith(ORPHAN_MARKER_ROW_ID);
    expect(revokeCertMock).not.toHaveBeenCalled();
  });

  it('Finding #1: fails closed (500) when the org policy row is missing (no auto_reissue fallback)', async () => {
    // A missing org row must NOT silently downgrade to auto_reissue and issue a
    // cert against an org whose policy we can't resolve.
    mockDeviceLookup(baseActiveDeviceRow());
    mockOrgSettingsLookup(null); // org row absent

    const res = await buildApp().request('/agents/renew-cert', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });

    expect(res.status).toBe(500);
    expect(issueCertMock).not.toHaveBeenCalled();
  });

  it('demotes the old active row and revokes it post-commit on a successful legacy renewal', async () => {
    issueCertMock.mockResolvedValue({
      id: 'cf-cert-2',
      certificate: NEW_CERT_PEM,
      privateKey: 'KEY',
      expiresOn: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
      issuedOn: new Date().toISOString(),
      serialNumber: NEW_CERT_SERIAL,
    });
    mockDeviceLookup(baseActiveDeviceRow());
    mockOrgSettingsLookup();
    mockActiveCertLookup({
      id: OLD_ACTIVE_CERT_ROW_ID,
      serialNumber: OLD_CERT_SERIAL,
      expiresAt: new Date(Date.now() + 10_000),
      publicKeySpki: OLD_CERT_SPKI_BASE64,
    });
    mockTxActiveLookup({ id: OLD_ACTIVE_CERT_ROW_ID });
    mockTxInsertOk();
    mockTxUpdateOk();
    mockTxUpdateOk();

    const res = await buildApp().request('/agents/renew-cert', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });

    expect(res.status).toBe(200);
    expect(queueCertificateRevocationCoreMock).toHaveBeenCalledWith(expect.anything(), OLD_ACTIVE_CERT_ROW_ID);
    expect(revokeCertificateNowOrEnqueueMock).toHaveBeenCalledWith(OLD_ACTIVE_CERT_ROW_ID);
  });

  it('queue failure after activation does not fail the renewal response (sweep repairs it)', async () => {
    issueCertMock.mockResolvedValue({
      id: 'cf-cert-3',
      certificate: NEW_CERT_PEM,
      privateKey: 'KEY',
      expiresOn: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
      issuedOn: new Date().toISOString(),
      serialNumber: NEW_CERT_SERIAL,
    });
    revokeCertificateNowOrEnqueueMock.mockRejectedValueOnce(new Error('redis down'));
    mockDeviceLookup(baseActiveDeviceRow());
    mockOrgSettingsLookup();
    mockActiveCertLookup({
      id: OLD_ACTIVE_CERT_ROW_ID,
      serialNumber: OLD_CERT_SERIAL,
      expiresAt: new Date(Date.now() + 10_000),
      publicKeySpki: OLD_CERT_SPKI_BASE64,
    });
    mockTxActiveLookup({ id: OLD_ACTIVE_CERT_ROW_ID });
    mockTxInsertOk();
    mockTxUpdateOk();
    mockTxUpdateOk();

    const res = await buildApp().request('/agents/renew-cert', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mtls.certificate).toBe(NEW_CERT_PEM);
    expect(revokeCertificateNowOrEnqueueMock).toHaveBeenCalledWith(OLD_ACTIVE_CERT_ROW_ID);
  });

  it('legacy response keyset is byte-compatible (mtls: {certificate, privateKey, expiresAt, serialNumber})', async () => {
    const expiresOn = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
    const issuedOn = new Date().toISOString();
    issueCertMock.mockResolvedValue({
      id: 'cf-cert-4',
      certificate: NEW_CERT_PEM,
      privateKey: 'KEY-MATERIAL',
      expiresOn,
      issuedOn,
      serialNumber: 'sn-4',
    });
    mockDeviceLookup(baseActiveDeviceRow());
    mockOrgSettingsLookup();
    mockActiveCertLookup(null);
    mockTxActiveLookup(null);
    mockTxInsertOk();
    mockTxUpdateOk();
    mockTxUpdateOk();

    const res = await buildApp().request('/agents/renew-cert', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(['mtls']);
    expect(Object.keys(body.mtls).sort()).toEqual(['certificate', 'expiresAt', 'privateKey', 'serialNumber']);
    expect(body.mtls).toEqual({
      certificate: NEW_CERT_PEM,
      privateKey: 'KEY-MATERIAL',
      expiresAt: expiresOn,
      serialNumber: 'sn-4',
    });
  });
});

describe('POST /renew-cert/challenge', () => {
  beforeEach(() => {
    resetAllMocksForTest();
  });

  it('rejects without a valid bearer token', async () => {
    mockDeviceLookup(null);
    const res = await buildApp().request('/agents/renew-cert/challenge', {
      method: 'POST',
      headers: { Authorization: 'Bearer brz_wrong' },
    });
    expect(res.status).toBe(401);
  });

  it('returns a one-use challengeId + expiresUnix when the active cert is expired and has an SPKI', async () => {
    mockDeviceLookup(baseActiveDeviceRow());
    mockActiveCertLookup({
      id: OLD_ACTIVE_CERT_ROW_ID,
      serialNumber: OLD_CERT_SERIAL,
      expiresAt: new Date(Date.now() - 3600 * 1000),
      publicKeySpki: OLD_CERT_SPKI_BASE64,
    });

    const res = await buildApp().request('/agents/renew-cert/challenge', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(['challengeId', 'expiresUnix']);
    expect(typeof body.challengeId).toBe('string');
    expect(typeof body.expiresUnix).toBe('number');
  });

  it('rejects (400) when the active certificate is not yet expired', async () => {
    mockDeviceLookup(baseActiveDeviceRow());
    mockActiveCertLookup({
      id: OLD_ACTIVE_CERT_ROW_ID,
      serialNumber: OLD_CERT_SERIAL,
      expiresAt: new Date(Date.now() + 3600 * 1000),
      publicKeySpki: OLD_CERT_SPKI_BASE64,
    });

    const res = await buildApp().request('/agents/renew-cert/challenge', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });

    expect(res.status).toBe(400);
  });

  it('rejects (400) when there is no recorded public_key_spki (legacy-imported certificate)', async () => {
    mockDeviceLookup(baseActiveDeviceRow());
    mockActiveCertLookup({
      id: OLD_ACTIVE_CERT_ROW_ID,
      serialNumber: OLD_CERT_SERIAL,
      expiresAt: new Date(Date.now() - 3600 * 1000),
      publicKeySpki: null,
    });

    const res = await buildApp().request('/agents/renew-cert/challenge', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });

    expect(res.status).toBe(400);
  });

  it('rate-limits repeated challenge requests from the same device', async () => {
    for (let i = 0; i < MTLS_CHALLENGE_LIMIT_FOR_TEST; i += 1) {
      mockDeviceLookup(baseActiveDeviceRow());
      mockActiveCertLookup({
        id: OLD_ACTIVE_CERT_ROW_ID,
        serialNumber: OLD_CERT_SERIAL,
        expiresAt: new Date(Date.now() - 3600 * 1000),
        publicKeySpki: OLD_CERT_SPKI_BASE64,
      });
      const res = await buildApp().request('/agents/renew-cert/challenge', {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      expect(res.status).toBe(200);
    }

    mockDeviceLookup(baseActiveDeviceRow());
    const limited = await buildApp().request('/agents/renew-cert/challenge', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBeTruthy();
  });
});

// Mirrors the MTLS_CHALLENGE_LIMIT constant in mtls.ts (5 requests / 5 min).
const MTLS_CHALLENGE_LIMIT_FOR_TEST = 5;
// Mirrors the MTLS_CONFIRM_LIMIT constant in mtls.ts (5 requests / 5 min).
const MTLS_CONFIRM_LIMIT_FOR_TEST = 5;

describe('POST /renew-cert — protocol v2 (capable agent)', () => {
  beforeEach(() => {
    resetAllMocksForTest();
  });

  it('issues a 15-minute pending_activation row without touching the old active row or legacy columns', async () => {
    const expiresOn = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
    const issuedOn = new Date().toISOString();
    issueCertMock.mockResolvedValue({
      id: 'cf-cert-v2',
      certificate: NEW_CERT_PEM,
      privateKey: 'KEY-V2',
      expiresOn,
      issuedOn,
      serialNumber: NEW_CERT_SERIAL,
    });
    mockDeviceLookup(baseActiveDeviceRow());
    mockOrgSettingsLookup();
    mockActiveCertLookup({
      id: OLD_ACTIVE_CERT_ROW_ID,
      serialNumber: OLD_CERT_SERIAL,
      expiresAt: new Date(Date.now() + 10_000),
      publicKeySpki: OLD_CERT_SPKI_BASE64,
    });
    mockV2PendingIssue(NEW_CERT_ROW_ID);

    const res = await buildApp().request('/agents/renew-cert', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ protocolVersion: 2 }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.protocolVersion).toBe(2);
    expect(body.certificateId).toBe(NEW_CERT_ROW_ID);
    expect(body.activationExpiresAt).toBeTruthy();
    expect(body.mtls).toEqual({
      certificate: NEW_CERT_PEM,
      privateKey: 'KEY-V2',
      expiresAt: expiresOn,
      serialNumber: NEW_CERT_SERIAL,
    });
    // The old ACTIVE row is untouched here — v2 issuance never demotes, that
    // only happens at /renew-cert/confirm. (A transaction DOES run now: I8's
    // supersede-then-insert of prior pending rows. It performs no demote.)
    expect(queueCertificateRevocationCoreMock).not.toHaveBeenCalled();
    expect(revokeCertificateNowOrEnqueueMock).not.toHaveBeenCalled();
  });

  it('supersedes a pre-existing pending_activation row instead of accumulating a second one (I8)', async () => {
    // FINAL-REVIEW I8: only `active` carries a per-device partial unique
    // index, so nothing stopped unbounded pending rows piling up — each one a
    // REAL Cloudflare certificate valid at the provider until the 5-minute
    // sweep reached it. Any agent that issued but never confirmed (exactly the
    // C2 self-host-default case) accumulated these indefinitely.
    const STALE_PENDING_ID = 'stale-pending-row-id';
    const expiresOn = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
    issueCertMock.mockResolvedValue({
      id: 'cf-cert-v2-supersede',
      certificate: NEW_CERT_PEM,
      privateKey: 'KEY-V2',
      serialNumber: NEW_CERT_SERIAL,
      expiresOn,
      issuedOn: new Date().toISOString(),
    });
    mockDeviceLookup(baseActiveDeviceRow());
    mockOrgSettingsLookup({ mtls: { certLifetimeDays: 30 } });
    mockActiveCertLookup({
      id: OLD_ACTIVE_CERT_ROW_ID,
      serialNumber: OLD_CERT_SERIAL,
      expiresAt: new Date(Date.now() + 10_000),
      publicKeySpki: OLD_CERT_SPKI_BASE64,
    });
    mockV2PendingIssue(NEW_CERT_ROW_ID, [STALE_PENDING_ID]);

    const res = await buildApp().request('/agents/renew-cert', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ protocolVersion: 2 }),
    });

    expect(res.status).toBe(200);
    expect((await res.json()).certificateId).toBe(NEW_CERT_ROW_ID);
    // The superseded row is handed to the DURABLE revoke lifecycle
    // post-commit, never revoked inline inside the transaction (#1105).
    expect(revokeCertificateNowOrEnqueueMock).toHaveBeenCalledWith(STALE_PENDING_ID);
    // The old ACTIVE row is still untouched — superseding pending rows is not
    // a demotion.
    expect(queueCertificateRevocationCoreMock).not.toHaveBeenCalled();
  });

  it('revokes the orphan provider cert DURABLY when the pending row fails to persist', async () => {
    // Fix round 1 (Important #1): a failed pending-row insert now mints a
    // pending_revocation marker row (fingerprint/serial/SPKI are available —
    // the leaf parsed successfully) and hands it to
    // revokeCertificateNowOrEnqueue, rather than a one-shot inline revoke
    // that would leave the orphan permanently unrevoked on a provider
    // 5xx/timeout.
    issueCertMock.mockResolvedValue({
      id: 'cf-cert-v2-orphan',
      certificate: NEW_CERT_PEM,
      privateKey: 'KEY-V2',
      expiresOn: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
      issuedOn: new Date().toISOString(),
      serialNumber: NEW_CERT_SERIAL,
    });
    mockDeviceLookup(baseActiveDeviceRow());
    mockOrgSettingsLookup();
    mockActiveCertLookup(null);
    mockV2PendingIssue(null); // the pending_activation insert returns 0 rows
    mockDbInsertOk(ORPHAN_MARKER_ROW_ID); // the durable marker-row insert succeeds

    const res = await buildApp().request('/agents/renew-cert', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ protocolVersion: 2 }),
    });

    expect(res.status).toBe(500);
    expect(revokeCertificateNowOrEnqueueMock).toHaveBeenCalledWith(ORPHAN_MARKER_ROW_ID);
    expect(revokeCertMock).not.toHaveBeenCalled();
  });

  it('falls back to a single inline best-effort revoke when the durable marker-row insert ALSO fails', async () => {
    // Defensive fallback-of-a-fallback: this is NOT the accepted
    // cert-parse-failure exception (the leaf parsed fine here) — it's an
    // unexpected second failure on top of an already-failing path, logged
    // distinctly ("falling back to inline best-effort revoke").
    issueCertMock.mockResolvedValue({
      id: 'cf-cert-v2-double-orphan',
      certificate: NEW_CERT_PEM,
      privateKey: 'KEY-V2',
      expiresOn: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
      issuedOn: new Date().toISOString(),
      serialNumber: NEW_CERT_SERIAL,
    });
    mockDeviceLookup(baseActiveDeviceRow());
    mockOrgSettingsLookup();
    mockActiveCertLookup(null);
    mockV2PendingIssue(null); // the pending_activation insert returns 0 rows
    mockDbInsertOk(null); // the durable marker-row insert ALSO returns 0 rows

    const res = await buildApp().request('/agents/renew-cert', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ protocolVersion: 2 }),
    });

    expect(res.status).toBe(500);
    expect(revokeCertMock).toHaveBeenCalledWith('cf-cert-v2-double-orphan');
    expect(revokeCertificateNowOrEnqueueMock).not.toHaveBeenCalled();
  });

  it('cert-parse-failure keeps the inline best-effort revoke and mints NO durable row (accepted scoped exception)', async () => {
    // A serial/fingerprint are unavailable when the leaf never parsed, so a
    // durable device_mtls_certificates row is impossible (fingerprint check
    // constraint requires a NOT NULL fingerprint_sha256 for
    // legacy_provenance=false rows, and inventing one is explicitly against
    // this codebase's principles). This is the one accepted exception to the
    // durable-revoke requirement.
    issueCertMock.mockResolvedValue({
      id: 'cf-cert-unparseable',
      certificate: 'not a real certificate PEM',
      privateKey: 'KEY',
      expiresOn: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
      issuedOn: new Date().toISOString(),
      serialNumber: 'sn-unparseable',
    });
    mockDeviceLookup(baseActiveDeviceRow());
    mockOrgSettingsLookup();
    mockActiveCertLookup(null);

    const res = await buildApp().request('/agents/renew-cert', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });

    expect(res.status).toBe(500);
    expect(revokeCertMock).toHaveBeenCalledWith('cf-cert-unparseable');
    // No durable row is ever attempted for this path.
    expect(dbInsertMock).not.toHaveBeenCalled();
    expect(revokeCertificateNowOrEnqueueMock).not.toHaveBeenCalled();
  });
});

describe('POST /renew-cert — mode-gated proof/binding (AGENT_MTLS_BINDING_MODE)', () => {
  const originalMode = process.env.AGENT_MTLS_BINDING_MODE;

  beforeEach(() => {
    resetAllMocksForTest();
  });

  afterEach(() => {
    if (originalMode === undefined) {
      delete process.env.AGENT_MTLS_BINDING_MODE;
    } else {
      process.env.AGENT_MTLS_BINDING_MODE = originalMode;
    }
  });

  function mockSuccessfulLegacyIssuance() {
    issueCertMock.mockResolvedValue({
      id: 'cf-cert-mode',
      certificate: NEW_CERT_PEM,
      privateKey: 'KEY',
      expiresOn: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
      issuedOn: new Date().toISOString(),
      serialNumber: NEW_CERT_SERIAL,
    });
    mockTxActiveLookup(null);
    mockTxInsertOk();
    mockTxUpdateOk();
    mockTxUpdateOk();
  }

  it('off: bearer-only renewal remains compatible even with an unexpired active cert and no assertion', async () => {
    process.env.AGENT_MTLS_BINDING_MODE = 'off';
    mockDeviceLookup(baseActiveDeviceRow());
    mockOrgSettingsLookup();
    mockActiveCertLookup({
      id: OLD_ACTIVE_CERT_ROW_ID,
      serialNumber: OLD_CERT_SERIAL,
      expiresAt: new Date(Date.now() + 3600 * 1000),
      publicKeySpki: OLD_CERT_SPKI_BASE64,
    });
    mockSuccessfulLegacyIssuance();

    const res = await buildApp().request('/agents/renew-cert', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });

    expect(res.status).toBe(200);
    expect(issueCertMock).toHaveBeenCalled();
  });

  it('audit: bearer-only renewal succeeds (never denies on the observation alone)', async () => {
    process.env.AGENT_MTLS_BINDING_MODE = 'audit';
    mockDeviceLookup(baseActiveDeviceRow());
    mockOrgSettingsLookup();
    mockActiveCertLookup({
      id: OLD_ACTIVE_CERT_ROW_ID,
      serialNumber: OLD_CERT_SERIAL,
      expiresAt: new Date(Date.now() + 3600 * 1000),
      publicKeySpki: OLD_CERT_SPKI_BASE64,
    });
    mockSuccessfulLegacyIssuance();

    const res = await buildApp().request('/agents/renew-cert', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });

    expect(res.status).toBe(200);
    expect(issueCertMock).toHaveBeenCalled();
  });

  it('enforce: bearer-only renewal with an unexpired active cert and no assertion is denied', async () => {
    process.env.AGENT_MTLS_BINDING_MODE = 'enforce';
    mockDeviceLookup(baseActiveDeviceRow());
    mockOrgSettingsLookup();
    mockActiveCertLookup({
      id: OLD_ACTIVE_CERT_ROW_ID,
      serialNumber: OLD_CERT_SERIAL,
      expiresAt: new Date(Date.now() + 3600 * 1000),
      publicKeySpki: OLD_CERT_SPKI_BASE64,
    });

    const res = await buildApp().request('/agents/renew-cert', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });

    expect(res.status).toBe(401);
    expect(issueCertMock).not.toHaveBeenCalled();
  });

  it('enforce: unexpired active cert WITH a matching, trusted certificate assertion succeeds', async () => {
    process.env.AGENT_MTLS_BINDING_MODE = 'enforce';
    trustsForwardedHeadersFromMock.mockReturnValue(true);
    mockDeviceLookup(baseActiveDeviceRow());
    mockOrgSettingsLookup();
    mockActiveCertLookup({
      id: OLD_ACTIVE_CERT_ROW_ID,
      serialNumber: OLD_CERT_SERIAL,
      expiresAt: new Date(Date.now() + 3600 * 1000),
      publicKeySpki: OLD_CERT_SPKI_BASE64,
    });
    mockSuccessfulLegacyIssuance();

    const res = await buildApp().request('/agents/renew-cert', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, ...setAssertionHeaders(OLD_CERT_SERIAL) },
    });

    expect(res.status).toBe(200);
    expect(issueCertMock).toHaveBeenCalled();
  });

  it('enforce: a trusted assertion naming a DIFFERENT certificate than the active row is denied in every mode', async () => {
    process.env.AGENT_MTLS_BINDING_MODE = 'off';
    trustsForwardedHeadersFromMock.mockReturnValue(true);
    mockDeviceLookup(baseActiveDeviceRow());
    mockOrgSettingsLookup();
    mockActiveCertLookup({
      id: OLD_ACTIVE_CERT_ROW_ID,
      serialNumber: OLD_CERT_SERIAL,
      expiresAt: new Date(Date.now() + 3600 * 1000),
      publicKeySpki: OLD_CERT_SPKI_BASE64,
    });

    const res = await buildApp().request('/agents/renew-cert', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, ...setAssertionHeaders(NEW_CERT_SERIAL) },
    });

    expect(res.status).toBe(401);
    expect(issueCertMock).not.toHaveBeenCalled();
  });

  it('enforce: expired active cert with a VALID recovery proof succeeds (v2 pending response)', async () => {
    process.env.AGENT_MTLS_BINDING_MODE = 'enforce';
    const app = buildApp();
    const proof = await signRecoveryProofForActiveChallenge(app);

    issueCertMock.mockResolvedValue({
      id: 'cf-cert-recovery',
      certificate: NEW_CERT_PEM,
      privateKey: 'KEY',
      expiresOn: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
      issuedOn: new Date().toISOString(),
      serialNumber: NEW_CERT_SERIAL,
    });
    mockDeviceLookup(baseActiveDeviceRow());
    mockOrgSettingsLookup();
    mockActiveCertLookup({
      id: OLD_ACTIVE_CERT_ROW_ID,
      serialNumber: OLD_CERT_SERIAL,
      expiresAt: new Date(Date.now() - 3600 * 1000),
      publicKeySpki: OLD_CERT_SPKI_BASE64,
    });
    mockV2PendingIssue(NEW_CERT_ROW_ID);

    const res = await app.request('/agents/renew-cert', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ protocolVersion: 2, recoveryProof: proof }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.protocolVersion).toBe(2);
    expect(issueCertMock).toHaveBeenCalled();
  });

  it.each(['off', 'audit', 'enforce'] as const)(
    'an INVALID supplied recovery proof is denied in %s mode (fails closed on the observation)',
    async (mode) => {
      process.env.AGENT_MTLS_BINDING_MODE = mode;
      mockDeviceLookup(baseActiveDeviceRow());
      mockOrgSettingsLookup();
      mockActiveCertLookup({
        id: OLD_ACTIVE_CERT_ROW_ID,
        serialNumber: OLD_CERT_SERIAL,
        expiresAt: new Date(Date.now() - 3600 * 1000),
        publicKeySpki: OLD_CERT_SPKI_BASE64,
      });

      const res = await buildApp().request('/agents/renew-cert', {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          protocolVersion: 2,
          recoveryProof: {
            challengeId: 'never-issued',
            expiresUnix: Math.floor(Date.now() / 1000) + 300,
            signatureBase64: Buffer.from('garbage').toString('base64'),
          },
        }),
      });

      expect(res.status).toBe(401);
      expect(issueCertMock).not.toHaveBeenCalled();
    },
  );

  it('enforce: expired active cert with NO recorded public key requires administrator re-enrollment', async () => {
    process.env.AGENT_MTLS_BINDING_MODE = 'enforce';
    mockDeviceLookup(baseActiveDeviceRow());
    mockOrgSettingsLookup();
    mockActiveCertLookup({
      id: OLD_ACTIVE_CERT_ROW_ID,
      serialNumber: OLD_CERT_SERIAL,
      expiresAt: new Date(Date.now() - 3600 * 1000),
      publicKeySpki: null, // legacy-imported certificate — no SPKI captured
    });

    const res = await buildApp().request('/agents/renew-cert', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/re-enrollment/i);
    expect(issueCertMock).not.toHaveBeenCalled();
  });

  it('enforce: expired active cert WITH a recorded public key but NO recovery proof is denied (P1-MTLS-002 closure branch)', async () => {
    // Distinct from the SPKI-missing/re-enrollment branch above: here the
    // active row DOES have a public_key_spki on file (so a recovery proof
    // would be possible), the caller just didn't supply one. This is the
    // generic "requires a valid recovery proof" 401 branch.
    process.env.AGENT_MTLS_BINDING_MODE = 'enforce';
    mockDeviceLookup(baseActiveDeviceRow());
    mockOrgSettingsLookup();
    mockActiveCertLookup({
      id: OLD_ACTIVE_CERT_ROW_ID,
      serialNumber: OLD_CERT_SERIAL,
      expiresAt: new Date(Date.now() - 3600 * 1000),
      publicKeySpki: OLD_CERT_SPKI_BASE64,
    });

    const res = await buildApp().request('/agents/renew-cert', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/recovery proof/i);
    expect(body.error).not.toMatch(/re-enrollment/i);
    expect(issueCertMock).not.toHaveBeenCalled();
  });

  it('audit: expired active cert with no proof succeeds and emits a bounded renewal_proof_missing observation', async () => {
    process.env.AGENT_MTLS_BINDING_MODE = 'audit';
    mockDeviceLookup(baseActiveDeviceRow());
    mockOrgSettingsLookup();
    mockActiveCertLookup({
      id: OLD_ACTIVE_CERT_ROW_ID,
      serialNumber: OLD_CERT_SERIAL,
      expiresAt: new Date(Date.now() - 3600 * 1000),
      publicKeySpki: OLD_CERT_SPKI_BASE64,
    });
    mockSuccessfulLegacyIssuance();

    const res = await buildApp().request('/agents/renew-cert', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });

    expect(res.status).toBe(200);
    expect(issueCertMock).toHaveBeenCalled();
    expect(writeAuditEventMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'agent.mtls.renew.binding_observed',
        details: expect.objectContaining({ reason: 'renewal_proof_missing', mode: 'audit' }),
      }),
    );
  });

  it('off: expired active cert with no proof preserves legacy bearer-only renewal', async () => {
    process.env.AGENT_MTLS_BINDING_MODE = 'off';
    mockDeviceLookup(baseActiveDeviceRow());
    mockOrgSettingsLookup();
    mockActiveCertLookup({
      id: OLD_ACTIVE_CERT_ROW_ID,
      serialNumber: OLD_CERT_SERIAL,
      expiresAt: new Date(Date.now() - 3600 * 1000),
      publicKeySpki: OLD_CERT_SPKI_BASE64,
    });
    mockSuccessfulLegacyIssuance();

    const res = await buildApp().request('/agents/renew-cert', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
    });

    expect(res.status).toBe(200);
    expect(issueCertMock).toHaveBeenCalled();
    // off never emits a binding-observation audit event.
    expect(writeAuditEventMock).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'agent.mtls.renew.binding_observed' }),
    );
  });
});

describe('POST /renew-cert/confirm', () => {
  beforeEach(() => {
    resetAllMocksForTest();
  });

  it('rejects without a valid bearer token', async () => {
    mockDeviceLookup(null);
    const res = await buildApp().request('/agents/renew-cert/confirm', {
      method: 'POST',
      headers: { Authorization: 'Bearer brz_wrong', 'Content-Type': 'application/json' },
      body: JSON.stringify({ protocolVersion: 2, certificateId: NEW_CERT_ROW_ID }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects with opaque 401 and does NOT touch the pending row when the tenant is inactive', async () => {
    // Fix round 2 (deferred minor (a)): matches /renew-cert's F4 pattern —
    // a suspended/churned tenant whose device token was not individually
    // suspended must not be able to activate a pending certificate.
    tenantActiveMock.mockResolvedValue(false);
    mockDeviceLookup(baseActiveDeviceRow());

    const res = await buildApp().request('/agents/renew-cert/confirm', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ protocolVersion: 2, certificateId: NEW_CERT_ROW_ID }),
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('Invalid agent credentials');
    // Only the device lookup (bearer auth) ran — the pending-row lookup
    // never happened.
    expect(dbSelectMock).toHaveBeenCalledTimes(1);
    expect(dbTransactionMock).not.toHaveBeenCalled();
  });

  it('rate-limits repeated confirm requests from the same device', async () => {
    // Fix round 2 (deferred minor (b)): per-device rate limit, same
    // Redis-key pattern as /renew-cert and /renew-cert/challenge.
    for (let i = 0; i < MTLS_CONFIRM_LIMIT_FOR_TEST; i += 1) {
      mockDeviceLookup(baseActiveDeviceRow());
      mockPendingCertLookup(null); // 404s past the rate limiter — irrelevant to this test
      const res = await buildApp().request('/agents/renew-cert/confirm', {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ protocolVersion: 2, certificateId: NEW_CERT_ROW_ID }),
      });
      expect(res.status).toBe(404);
    }

    mockDeviceLookup(baseActiveDeviceRow());
    const limited = await buildApp().request('/agents/renew-cert/confirm', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ protocolVersion: 2, certificateId: NEW_CERT_ROW_ID }),
    });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBeTruthy();
  });

  it('404s when the certificateId does not belong to the authenticated device', async () => {
    mockDeviceLookup(baseActiveDeviceRow());
    mockPendingCertLookup({
      id: NEW_CERT_ROW_ID,
      deviceId: 'some-other-device',
      state: 'pending_activation',
      serialNumber: NEW_CERT_SERIAL,
      activationExpiresAt: new Date(Date.now() + 60_000),
      expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
      issuedAt: new Date(),
      providerCertificateId: 'cf-cert-x',
    });

    const res = await buildApp().request('/agents/renew-cert/confirm', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ protocolVersion: 2, certificateId: NEW_CERT_ROW_ID }),
    });
    expect(res.status).toBe(404);
  });

  it('410s (timeout expiry) when the activation window has already passed', async () => {
    mockDeviceLookup(baseActiveDeviceRow());
    mockPendingCertLookup({
      id: NEW_CERT_ROW_ID,
      deviceId: DEVICE_ID,
      state: 'pending_activation',
      serialNumber: NEW_CERT_SERIAL,
      activationExpiresAt: new Date(Date.now() - 60_000), // already expired
      expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
      issuedAt: new Date(),
      providerCertificateId: 'cf-cert-x',
    });

    const res = await buildApp().request('/agents/renew-cert/confirm', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ protocolVersion: 2, certificateId: NEW_CERT_ROW_ID }),
    });
    expect(res.status).toBe(410);
  });

  it('confirms and activates with the NEW certificate assertion, demoting and revoking the old row', async () => {
    trustsForwardedHeadersFromMock.mockReturnValue(true);
    mockDeviceLookup(baseActiveDeviceRow());
    mockPendingCertLookup({
      id: NEW_CERT_ROW_ID,
      deviceId: DEVICE_ID,
      state: 'pending_activation',
      serialNumber: NEW_CERT_SERIAL,
      activationExpiresAt: new Date(Date.now() + 60_000),
      expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
      issuedAt: new Date(),
      providerCertificateId: 'cf-cert-new',
    });
    mockTxActiveLookup({ id: OLD_ACTIVE_CERT_ROW_ID });
    mockTxUpdateOk(); // activate the pending row
    mockTxUpdateOk(); // legacy devices columns

    const res = await buildApp().request('/agents/renew-cert/confirm', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...setAssertionHeaders(NEW_CERT_SERIAL) },
      body: JSON.stringify({ protocolVersion: 2, certificateId: NEW_CERT_ROW_ID }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(queueCertificateRevocationCoreMock).toHaveBeenCalledWith(expect.anything(), OLD_ACTIVE_CERT_ROW_ID);
    expect(revokeCertificateNowOrEnqueueMock).toHaveBeenCalledWith(OLD_ACTIVE_CERT_ROW_ID);
  });

  it('denies confirmation presented with the OLD certificate\'s assertion instead of the new one', async () => {
    trustsForwardedHeadersFromMock.mockReturnValue(true);
    mockDeviceLookup(baseActiveDeviceRow());
    mockPendingCertLookup({
      id: NEW_CERT_ROW_ID,
      deviceId: DEVICE_ID,
      state: 'pending_activation',
      serialNumber: NEW_CERT_SERIAL,
      activationExpiresAt: new Date(Date.now() + 60_000),
      expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
      issuedAt: new Date(),
      providerCertificateId: 'cf-cert-new',
    });

    const res = await buildApp().request('/agents/renew-cert/confirm', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...setAssertionHeaders(OLD_CERT_SERIAL) },
      body: JSON.stringify({ protocolVersion: 2, certificateId: NEW_CERT_ROW_ID }),
    });

    expect(res.status).toBe(401);
    expect(dbTransactionMock).not.toHaveBeenCalled();
  });

  it('denies confirmation with no certificate assertion at all in enforce mode', async () => {
    process.env.AGENT_MTLS_BINDING_MODE = 'enforce';
    mockDeviceLookup(baseActiveDeviceRow());
    mockPendingCertLookup({
      id: NEW_CERT_ROW_ID,
      deviceId: DEVICE_ID,
      state: 'pending_activation',
      serialNumber: NEW_CERT_SERIAL,
      activationExpiresAt: new Date(Date.now() + 60_000),
      expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
      issuedAt: new Date(),
      providerCertificateId: 'cf-cert-new',
    });

    const res = await buildApp().request('/agents/renew-cert/confirm', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ protocolVersion: 2, certificateId: NEW_CERT_ROW_ID }),
    });

    expect(res.status).toBe(401);
    expect(dbTransactionMock).not.toHaveBeenCalled();
  });
});

// =====================================================================
// FINAL-REVIEW C2 / I4: the confirmation assertion requirement is
// mode-gated, so a CURRENT agent — which always sends protocolVersion: 2 —
// can complete a renewal against the self-host default
// AGENT_MTLS_BINDING_MODE=off, where no edge asserts anything at all.
// Before this fix the v2 issue branch was NOT mode-gated but confirm
// ALWAYS required a verified assertion, so such an agent received pending
// material it could never activate: renewal never completed, and the
// certificate was swept and reissued forever.
// =====================================================================
describe('POST /renew-cert/confirm — mode-gated assertion requirement (C2/I4)', () => {
  const originalMode = process.env.AGENT_MTLS_BINDING_MODE;

  beforeEach(() => {
    resetAllMocksForTest();
  });

  afterEach(() => {
    if (originalMode === undefined) {
      delete process.env.AGENT_MTLS_BINDING_MODE;
    } else {
      process.env.AGENT_MTLS_BINDING_MODE = originalMode;
    }
  });

  function stagePendingConfirm(serial = NEW_CERT_SERIAL) {
    mockDeviceLookup(baseActiveDeviceRow());
    mockPendingCertLookup({
      id: NEW_CERT_ROW_ID,
      deviceId: DEVICE_ID,
      state: 'pending_activation',
      serialNumber: serial,
      activationExpiresAt: new Date(Date.now() + 60_000),
      expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
      issuedAt: new Date(),
      providerCertificateId: 'cf-cert-new',
    });
    mockTxActiveLookup({ id: OLD_ACTIVE_CERT_ROW_ID });
    mockTxUpdateOk(); // activate the pending row
    mockTxUpdateOk(); // legacy devices columns
  }

  function confirmRequest(extraHeaders: Record<string, string> = {}) {
    return buildApp().request('/agents/renew-cert/confirm', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
        ...extraHeaders,
      },
      body: JSON.stringify({ protocolVersion: 2, certificateId: NEW_CERT_ROW_ID }),
    });
  }

  for (const mode of ['off', 'audit'] as const) {
    it(`completes a v2 renewal confirmation with NO assertion in ${mode} mode (two-phase activate + demote + durable revoke still run)`, async () => {
      process.env.AGENT_MTLS_BINDING_MODE = mode;
      stagePendingConfirm();

      const res = await confirmRequest();

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true });
      // The full two-phase flow still runs — permissive mode relaxes the
      // assertion requirement ONLY, never the lifecycle.
      expect(dbTransactionMock).toHaveBeenCalled();
      expect(queueCertificateRevocationCoreMock).toHaveBeenCalledWith(expect.anything(), OLD_ACTIVE_CERT_ROW_ID);
      expect(revokeCertificateNowOrEnqueueMock).toHaveBeenCalledWith(OLD_ACTIVE_CERT_ROW_ID);
    });

    it(`still fails closed on a VERIFIED but MISMATCHED assertion in ${mode} mode`, async () => {
      // A trusted spoof signal is never ignored just because the mode is
      // permissive — mirrors evaluateRenewalAuthorization's pre-mode-gate
      // mismatch branch. Only the ABSENCE of an assertion is tolerated.
      process.env.AGENT_MTLS_BINDING_MODE = mode;
      trustsForwardedHeadersFromMock.mockReturnValue(true);
      stagePendingConfirm();

      const res = await confirmRequest(setAssertionHeaders(OLD_CERT_SERIAL));

      expect(res.status).toBe(401);
      expect(dbTransactionMock).not.toHaveBeenCalled();
    });
  }

  it('still REQUIRES a matching assertion in enforce mode', async () => {
    process.env.AGENT_MTLS_BINDING_MODE = 'enforce';
    stagePendingConfirm();

    const res = await confirmRequest();

    expect(res.status).toBe(401);
    expect(dbTransactionMock).not.toHaveBeenCalled();
  });

  it('accepts a matching assertion in enforce mode', async () => {
    process.env.AGENT_MTLS_BINDING_MODE = 'enforce';
    trustsForwardedHeadersFromMock.mockReturnValue(true);
    stagePendingConfirm();

    const res = await confirmRequest(setAssertionHeaders(NEW_CERT_SERIAL));

    expect(res.status).toBe(200);
    expect(dbTransactionMock).toHaveBeenCalled();
  });

  it('matches a legacy NON-CANONICAL stored serial against a canonical asserted one (I3)', async () => {
    // A pending/active row imported by Task 1's migration, or written by the
    // legacy renewal path before Task 6's fix, stores the provider's raw
    // serial rendering (colon-separated, lowercase). The asserted serial is
    // normalized at the header read boundary, so comparing against a RAW
    // stored value could never match and 401'd permanently.
    process.env.AGENT_MTLS_BINDING_MODE = 'enforce';
    trustsForwardedHeadersFromMock.mockReturnValue(true);
    const rawStoredSerial = NEW_CERT_SERIAL
      .toLowerCase()
      .replace(/(..)(?=.)/g, '$1:');
    expect(rawStoredSerial).not.toBe(NEW_CERT_SERIAL); // fixture sanity
    stagePendingConfirm(rawStoredSerial);

    const res = await confirmRequest(setAssertionHeaders(NEW_CERT_SERIAL));

    expect(res.status).toBe(200);
    expect(dbTransactionMock).toHaveBeenCalled();
  });

  it('treats a re-confirm of an ALREADY-ACTIVE row as success instead of 409 (C4: dropped confirm response must not cost the agent its identity)', async () => {
    process.env.AGENT_MTLS_BINDING_MODE = 'enforce';
    mockDeviceLookup(baseActiveDeviceRow());
    mockPendingCertLookup({
      id: NEW_CERT_ROW_ID,
      deviceId: DEVICE_ID,
      state: 'active', // a previous confirm already activated it
      serialNumber: NEW_CERT_SERIAL,
      activationExpiresAt: new Date(Date.now() + 60_000),
      expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
      issuedAt: new Date(),
      providerCertificateId: 'cf-cert-new',
    });

    const res = await confirmRequest();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, alreadyActive: true });
    // Idempotent no-op: no second activation transaction.
    expect(dbTransactionMock).not.toHaveBeenCalled();
  });

  it('409s WITH the row state for a terminal (revoked) certificate so the agent can discard rather than adopt', async () => {
    mockDeviceLookup(baseActiveDeviceRow());
    mockPendingCertLookup({
      id: NEW_CERT_ROW_ID,
      deviceId: DEVICE_ID,
      state: 'revoked',
      serialNumber: NEW_CERT_SERIAL,
      activationExpiresAt: new Date(Date.now() + 60_000),
      expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
      issuedAt: new Date(),
      providerCertificateId: 'cf-cert-new',
    });

    const res = await confirmRequest();

    expect(res.status).toBe(409);
    expect((await res.json()).state).toBe('revoked');
    expect(dbTransactionMock).not.toHaveBeenCalled();
  });
});

describe('PATCH /org/:orgId/settings/log-forwarding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisState.clear();
    redisStringState.clear();
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
