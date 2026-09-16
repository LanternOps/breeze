/**
 * In-process fake `m365-graph-read-executor` for the tenant-sync integration
 * suite.
 *
 * It is a real node http server and it verifies the API's internal-auth JWT
 * with the same checks the real executor applies
 * (apps/m365-graph-read-executor/src/internalAuth.ts:78-106): EdDSA only, kid
 * match, iss/aud/sub pinned, iat+exp present with a lifetime of at most 60 s,
 * jti and correlationId UUIDs, operation bound to the route, and bodySha256
 * equal to the base64url SHA-256 of the exact received bytes. A harness that
 * accepted anything would prove nothing about the wire contract, which is the
 * only reason this exists instead of a client stub.
 *
 * The executor package is NOT a dependency of @breeze/api, so the checks are
 * mirrored here rather than imported. Keep them in step with that file.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, importJWK, jwtVerify, type JWK } from 'jose';
import type { M365SyncActionResult, M365SyncSourceState } from '@breeze/shared/m365';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BODY_DIGEST = /^[A-Za-z0-9_-]{43}$/;
const MAX_TOKEN_LIFETIME_SECONDS = 60;

/** The https origin the API is configured with; the bridge maps it to loopback. */
export const FAKE_EXECUTOR_ORIGIN = 'https://executor.internal.example.test';
export const FAKE_EXECUTOR_KID = 'sync-test-key-1';

export interface FakeSyncCall {
  actionType: string;
  tenantId: string;
  correlationId: string;
  continuation?: string;
  backfill?: boolean;
}

export interface FakeSyncErrorResponse {
  status: number;
  body: unknown;
  retryAfterSeconds?: number;
}

export interface FakeSyncExecutor {
  origin: string;
  signingPrivateJwk: JWK;
  signingPublicJwk: JWK;
  signingKid: string;
  calls: FakeSyncCall[];
  unauthorizedCount: number;
  latencyMs: number;
  /**
   * `tenantId` is optional and additive: omit it (every Tasks 1-8 caller
   * does) and dequeuing is plain FIFO by actionType, unaffected. Pass it
   * when multiple in-flight calls for the SAME actionType but DIFFERENT
   * tenants can race — e.g. the benchmark driver runs several orgs
   * concurrently, and `enqueue` happens synchronously right before an
   * `await runSyncDomain(job)` whose HTTP POST lands several awaits later,
   * so two workers' enqueue-then-post pairs can interleave and a plain FIFO
   * queue would hand tenant A's fixture to tenant B's request whenever B's
   * POST reaches the server first despite being enqueued second.
   */
  enqueue(actionType: string, response: M365SyncActionResult | FakeSyncErrorResponse, tenantId?: string): void;
  reset(): void;
  close(): Promise<void>;
}

function digestMatches(actual: string, claimed: unknown): boolean {
  if (typeof claimed !== 'string' || !BODY_DIGEST.test(claimed)) return false;
  const a = Buffer.from(actual, 'base64url');
  const b = Buffer.from(claimed, 'base64url');
  return a.length === b.length && timingSafeEqual(a, b);
}

function isErrorResponse(value: unknown): value is FakeSyncErrorResponse {
  return typeof value === 'object' && value !== null && 'status' in value;
}

export async function createFakeSyncExecutor(
  options: { latencyMs?: number } = {},
): Promise<FakeSyncExecutor> {
  const { publicKey, privateKey } = await generateKeyPair('Ed25519', { extractable: true });
  const signingPrivateJwk = { ...(await exportJWK(privateKey)), kid: FAKE_EXECUTOR_KID, alg: 'EdDSA' };
  const signingPublicJwk = { ...(await exportJWK(publicKey)), kid: FAKE_EXECUTOR_KID, alg: 'EdDSA' };
  const verificationKey = await importJWK(signingPublicJwk, 'EdDSA');

  const queues = new Map<string, Array<M365SyncActionResult | FakeSyncErrorResponse>>();
  const calls: FakeSyncCall[] = [];
  const state = { unauthorized: 0 };
  const latencyMs = options.latencyMs ?? 0;

  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      void (async () => {
        const raw = Buffer.concat(chunks);
        const send = (status: number, body: unknown) => {
          const payload = JSON.stringify(body);
          response.writeHead(status, {
            'content-type': 'application/json',
            'content-length': String(Buffer.byteLength(payload)),
          });
          response.end(payload);
        };

        if (request.method !== 'POST' || request.url !== '/v1/sync-action') {
          send(404, { code: 'not_found' });
          return;
        }

        try {
          const authorization = request.headers.authorization;
          if (!authorization?.startsWith('Bearer ')) throw new Error('unauthorized');
          const token = authorization.slice('Bearer '.length);
          if (!token || /\s/.test(token)) throw new Error('unauthorized');
          const nowSeconds = Math.floor(Date.now() / 1_000);
          const { payload, protectedHeader } = await jwtVerify(token, verificationKey, {
            algorithms: ['EdDSA'],
            issuer: 'breeze-api',
            audience: 'm365-graph-read-executor',
            subject: 'breeze-control-plane',
            requiredClaims: ['iss', 'aud', 'sub', 'iat', 'exp', 'jti'],
          });
          if (
            protectedHeader.kid !== FAKE_EXECUTOR_KID
            || !Number.isSafeInteger(payload.iat)
            || !Number.isSafeInteger(payload.exp)
            || (payload.exp as number) <= (payload.iat as number)
            || (payload.exp as number) - (payload.iat as number) > MAX_TOKEN_LIFETIME_SECONDS
            || (payload.iat as number) > nowSeconds
            || nowSeconds - (payload.iat as number) > MAX_TOKEN_LIFETIME_SECONDS
            || typeof payload.jti !== 'string' || !UUID.test(payload.jti)
            || payload.operation !== 'sync-action'
            || typeof payload.correlationId !== 'string' || !UUID.test(payload.correlationId)
            || !digestMatches(createHash('sha256').update(raw).digest('base64url'), payload.bodySha256)
          ) throw new Error('unauthorized');
        } catch {
          state.unauthorized += 1;
          send(401, { code: 'internal_request_unauthorized' });
          return;
        }

        let body: { correlationId?: string; tenantId?: string; action?: Record<string, unknown> };
        try {
          body = JSON.parse(raw.toString('utf8')) as typeof body;
        } catch {
          send(400, { code: 'invalid_request' });
          return;
        }
        const action = body.action ?? {};
        const actionType = typeof action.type === 'string' ? action.type : '';
        calls.push({
          actionType,
          tenantId: body.tenantId ?? '',
          correlationId: body.correlationId ?? '',
          continuation: typeof action.continuation === 'string' ? action.continuation : undefined,
          backfill: typeof action.backfill === 'boolean' ? action.backfill : undefined,
        });

        if (latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, latencyMs));

        // Tenant-keyed fixtures (queued via `enqueue(type, fixture, tenantId)`)
        // take priority over the plain actionType queue, so a caller that
        // needs per-tenant correctness under concurrency (the benchmark
        // driver) gets it, while every existing plain-FIFO caller is unaffected.
        const tenantKey = body.tenantId ? `${actionType}::${body.tenantId}` : undefined;
        const queued = (tenantKey && queues.get(tenantKey)?.shift()) || queues.get(actionType)?.shift();
        if (!queued) {
          send(500, { code: 'no_fixture', action: actionType });
          return;
        }
        if (isErrorResponse(queued)) {
          if (queued.retryAfterSeconds !== undefined) {
            response.setHeader('retry-after', String(queued.retryAfterSeconds));
          }
          send(queued.status, queued.body);
          return;
        }
        send(200, queued);
      })();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const loopback = `http://127.0.0.1:${port}`;

  // The API client captures `config.fetch ?? globalThis.fetch` at factory time
  // and refuses any non-https executor origin, so the only way to keep signing
  // + bounding + schema parsing real is to bridge the configured origin here.
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith(FAKE_EXECUTOR_ORIGIN)) {
      return realFetch(`${loopback}${url.slice(FAKE_EXECUTOR_ORIGIN.length)}`, init);
    }
    return realFetch(input as RequestInfo, init);
  }) as typeof globalThis.fetch;

  return {
    origin: FAKE_EXECUTOR_ORIGIN,
    signingPrivateJwk,
    signingPublicJwk,
    signingKid: FAKE_EXECUTOR_KID,
    calls,
    latencyMs,
    get unauthorizedCount() { return state.unauthorized; },
    enqueue(actionType, queued, tenantId) {
      const key = tenantId ? `${actionType}::${tenantId}` : actionType;
      const list = queues.get(key) ?? [];
      list.push(queued);
      queues.set(key, list);
    },
    reset() {
      queues.clear();
      calls.length = 0;
      state.unauthorized = 0;
    },
    async close() {
      globalThis.fetch = realFetch;
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

// ---------------------------------------------------------------------------
// Fixture builders — projected item shapes per the shared interface contract.
// ---------------------------------------------------------------------------

function result(
  items: Record<string, unknown>[],
  sources: Record<string, M365SyncSourceState>,
  extra: Partial<M365SyncActionResult> = {},
): M365SyncActionResult {
  return {
    success: true,
    kind: 'sync',
    items,
    truncated: false,
    fetchedAt: '2026-09-08T10:00:00.000Z',
    sources,
    ...extra,
  };
}

export interface FakeUser {
  id: string;
  userPrincipalName: string;
  displayName?: string;
  accountEnabled?: boolean;
  assignedLicenses?: string[];
  mfaRegistered?: boolean | null;
  adminRoles?: { roleTemplateId: string; displayName: string; viaGroupId?: string }[] | null;
}

export function syncUsersResult(
  users: FakeUser[],
  sources: Record<string, M365SyncSourceState> = { users: 'ok', mfaRegistration: 'ok', roleAssignments: 'ok' },
  extra: Partial<M365SyncActionResult> = {},
): M365SyncActionResult {
  return result(users.map((user) => ({
    id: user.id,
    userPrincipalName: user.userPrincipalName,
    displayName: user.displayName ?? user.userPrincipalName,
    mail: user.userPrincipalName,
    accountEnabled: user.accountEnabled ?? true,
    jobTitle: null,
    department: null,
    usageLocation: 'US',
    onPremisesSyncEnabled: false,
    createdDateTime: '2026-01-05T00:00:00.000Z',
    assignedLicenses: user.assignedLicenses ?? [],
    // `??` treats an explicit `null` (meaning "unknown/unregistered") the same
    // as "not provided" and would silently coerce it to `true` — distinguish
    // the two with `in` so callers can assert the mfa-unknown path.
    mfaRegistered: 'mfaRegistered' in user ? user.mfaRegistered : true,
    mfaCapable: 'mfaRegistered' in user ? user.mfaRegistered : true,
    defaultMfaMethod: user.mfaRegistered === null ? null : 'microsoftAuthenticatorPush',
    adminRoles: user.adminRoles ?? [],
  })), sources, extra);
}

export function syncSigninActivityResult(
  entries: { id: string; lastSuccessfulSignInAt: string | null }[],
  extra: Partial<M365SyncActionResult> = {},
): M365SyncActionResult {
  return result(entries, { signInActivity: 'ok' }, extra);
}

/**
 * #5784 W05. `/auditLogs/signIns` rows as the executor hands them back. Only
 * `id` and `createdDateTime` are required by the persister; the rest mirrors a
 * typical interactive sign-in so the parsed row has every column populated.
 */
export function syncSigninEventsResult(
  events: { id: string; createdDateTime: string; userId?: string; userPrincipalName?: string }[],
  extra: Partial<M365SyncActionResult> = {},
): M365SyncActionResult {
  return result(events.map((event) => ({
    id: event.id,
    createdDateTime: event.createdDateTime,
    userId: event.userId ?? 'aaaaaaaa-0000-4000-8000-000000000001',
    userPrincipalName: event.userPrincipalName ?? 'ada@contoso.example',
    appId: 'app-1',
    appDisplayName: 'Outlook',
    clientAppUsed: 'Browser',
    ipAddress: '203.0.113.7',
    location: { city: 'Austin', countryOrRegion: 'US' },
    conditionalAccessStatus: 'success',
    status: { errorCode: 0 },
    riskLevelAggregated: 'none',
    riskState: 'none',
    isInteractive: true,
  })), { signinEvents: 'ok' }, extra);
}

export function syncIntuneDevicesResult(
  devices: { id: string; deviceName: string; serialNumber?: string | null; complianceState?: string }[],
  extra: Partial<M365SyncActionResult> = {},
): M365SyncActionResult {
  return result(devices.map((device) => ({
    id: device.id,
    deviceName: device.deviceName,
    operatingSystem: 'Windows',
    osVersion: '10.0.26100.1',
    complianceState: device.complianceState ?? 'compliant',
    lastSyncDateTime: '2026-09-08T09:00:00.000Z',
    userPrincipalName: 'ada@contoso.example',
    managedDeviceOwnerType: 'company',
    enrolledDateTime: '2026-02-01T00:00:00.000Z',
    model: 'OptiPlex 7010',
    manufacturer: 'Dell Inc.',
    serialNumber: device.serialNumber ?? null,
    azureADDeviceId: '99999999-9999-4999-8999-999999999999',
    managementAgent: 'mdm',
    jailBroken: 'Unknown',
  })), { managedDevices: 'ok' }, extra);
}

export function syncCaPoliciesResult(
  policies: { id: string; displayName: string; state: string; modifiedDateTime?: string }[],
  extra: Partial<M365SyncActionResult> = {},
): M365SyncActionResult {
  return result(policies.map((policy) => ({
    id: policy.id,
    displayName: policy.displayName,
    state: policy.state,
    createdDateTime: '2026-03-01T00:00:00.000Z',
    modifiedDateTime: policy.modifiedDateTime ?? '2026-08-01T00:00:00.000Z',
    conditions: { users: { includeUsers: ['All'] }, applications: { includeApplications: ['All'] } },
    grantControls: { operator: 'OR', builtInControls: ['mfa'] },
    sessionControls: null,
  })), { policies: 'ok' }, extra);
}

export function syncSkusResult(
  skus: { skuId: string; skuPartNumber: string; consumedUnits: number; enabled: number }[],
  extra: Partial<M365SyncActionResult> = {},
): M365SyncActionResult {
  return result(skus.map((sku) => ({
    skuId: sku.skuId,
    skuPartNumber: sku.skuPartNumber,
    consumedUnits: sku.consumedUnits,
    prepaidUnits: { enabled: sku.enabled, suspended: 0, warning: 0 },
    capabilityStatus: 'Enabled',
    appliesTo: 'User',
  })), { subscribedSkus: 'ok' }, extra);
}

/** `days` scores ending at `endDate`, one per calendar day, Graph-dated. */
export function syncSecureScoreResult(
  endDate: string,
  days: number,
  extra: Partial<M365SyncActionResult> = {},
): M365SyncActionResult {
  const end = new Date(`${endDate}T02:00:00.000Z`);
  const items = Array.from({ length: days }, (_unused, index) => {
    const created = new Date(end.getTime() - index * 24 * 3_600 * 1_000);
    return {
      id: `score-${created.toISOString().slice(0, 10)}`,
      createdDateTime: created.toISOString(),
      currentScore: 410 - index,
      maxScore: 600,
      activeUserCount: 42,
      licensedUserCount: 50,
      controlScores: [
        // `title` is part of the projected controlScores shape in the contract
        // (string | null) — the executor joins it from controlProfiles, and a
        // profile it could not resolve arrives as null.
        { controlName: 'MfaRegistrationV2', title: 'Ensure all users can complete multi-factor authentication', score: 30, maxScore: 30, implementationStatus: 'Implemented' },
        { controlName: 'BlockLegacyAuthentication', title: null, score: 0, maxScore: 20, implementationStatus: 'Not implemented' },
      ],
    };
  });
  return result(items, { secureScores: 'ok', controlProfiles: 'ok' }, extra);
}
