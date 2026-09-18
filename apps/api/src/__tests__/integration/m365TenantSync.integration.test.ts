/**
 * Integration test — M365 tenant sync end to end (real PG + in-process fake executor)
 *
 * Drives `runSyncDomain` directly (never through BullMQ) against a node http
 * server that verifies the API's EdDSA internal-auth JWT exactly as
 * apps/m365-graph-read-executor/src/internalAuth.ts does, and returns canned
 * M365SyncActionResult payloads keyed by action.type.
 *
 * Run:
 *   cd apps/api && npx vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/m365TenantSync.integration.test.ts
 */
import './setup';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignJWT, importJWK } from 'jose';
import { eq, sql } from 'drizzle-orm';
import { Registry } from 'prom-client';
import { db, withSystemDbAccessContext } from '../../db';
import { m365Connections } from '../../db/schema';
import { runSyncDomain, DOMAIN_PERSISTERS, assertStillFenced } from '../../services/m365Sync/run';
import { claimDueDomains } from '../../services/m365Sync/claim';
import { registerM365SyncMetrics } from '../../services/m365Sync/metrics';
import { disconnectCustomerGraphReadConnection } from '../../services/m365ControlPlane/connectionService';
import type { M365SyncDomain } from '@breeze/shared/m365';
import { createOrganization, createPartner, createUser } from './db-utils';
import { getTestDb } from './setup';
import {
  createFakeSyncExecutor, type FakeSyncExecutor,
  syncCaPoliciesResult, syncIntuneDevicesResult, syncSecureScoreResult,
  syncSigninActivityResult, syncSigninEventsResult, syncSkusResult, syncUsersResult,
} from './m365SyncFakeExecutor';

const runDb = it.runIf(!!process.env.DATABASE_URL);

// `vi.mock` is hoisted above `beforeAll`, so the config it closes over must be
// a hoisted, mutable holder rather than the executor object itself.
const syncExecutorConfig = vi.hoisted(() => ({
  origin: 'https://executor.internal.example.test',
  signingPrivateJwk: {} as Record<string, unknown>,
  signingKid: 'sync-test-key-1',
}));

// `reclaimSameDomain` (run.ts) claims the continuation's next page ITSELF —
// via its own `claimDueDomains` call — and hands the claimed job off to
// BullMQ via `enqueueSyncDomain`, all before `runSyncDomain` returns
// 'partial-continue'. writeCompletion's continuation mode deliberately never
// touches next_sync_at (see run.ts:363-366), so a second manual `claimFor`
// call in this suite would race the production reclaim and find nothing —
// the row is already claimed by the time control returns to the test. The
// plan's "never drive through BullMQ" constraint means we don't let that
// enqueue actually reach the queue/ticker either. Mocking the enqueue to
// capture the already-claimed job lets the test complete the SAME walk
// `reclaimSameDomain` set up, without going through BullMQ or re-claiming.
const capturedContinuationJobs = vi.hoisted(() => ({ jobs: [] as unknown[] }));
vi.mock('../../jobs/m365SyncQueue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../jobs/m365SyncQueue')>();
  return {
    ...actual,
    enqueueSyncDomain: vi.fn(async (data: unknown) => {
      capturedContinuationJobs.jobs.push(data);
      return 'captured-not-enqueued';
    }),
  };
});

vi.mock('../../services/m365ControlPlane/runtimeConfig', () => ({
  loadM365CustomerGraphReadRuntimeConfig: vi.fn(() => ({
    clientId: '55555555-5555-4555-8555-555555555555',
    vaultRef: 'akv://vault.example/m365-customer-graph-read/0123456789abcdef0123456789abcdef',
    credentialVersion: '0123456789abcdef0123456789abcdef',
    callbackUrl: 'https://console.example.test/api/v1/m365/consent/callback',
    executorUrl: syncExecutorConfig.origin,
    executorAudience: 'm365-graph-read-executor',
    executorSigningPrivateJwk: syncExecutorConfig.signingPrivateJwk,
    executorSigningKid: syncExecutorConfig.signingKid,
    onboardingOrgIds: '*',
  })),
}));

const TENANT_ID = '44444444-4444-4444-8444-444444444444';
const DOMAINS: M365SyncDomain[] = [
  'users', 'signin_activity', 'intune_devices', 'ca_policies', 'skus', 'secure_score',
  // #5784 W05: /auditLogs/signIns delta sync.
  'signin_events',
];

interface SyncFixture { orgId: string; connectionId: string; actorId: string }

async function seedConnectedOrg(): Promise<SyncFixture> {
  return withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const user = await createUser({
      partnerId: partner.id,
      orgId: org.id,
      email: `m365-sync-${Date.now()}-${crypto.randomUUID()}@example.com`,
    });
    const [connection] = await db.insert(m365Connections).values({
      orgId: org.id,
      userId: null,
      tenantId: TENANT_ID,
      clientId: '55555555-5555-4555-8555-555555555555',
      clientSecret: null,
      profile: 'customer-graph-read',
      authMode: 'application-certificate',
      credentialDomain: 'customer-graph-read',
      vaultRef: 'akv://vault.example/m365-customer-graph-read/0123456789abcdef0123456789abcdef',
      credentialVersion: '0123456789abcdef0123456789abcdef',
      permissionManifestVersion: 3,
      observedGrants: [],
      consentAttemptId: crypto.randomUUID(),
      grantsVerifiedAt: new Date('2026-09-08T08:00:00.000Z'),
      displayName: 'Contoso',
      status: 'active',
      consentedAt: new Date('2026-09-08T08:00:00.000Z'),
      lastVerifiedAt: new Date('2026-09-08T08:00:00.000Z'),
      createdBy: user.id,
    }).returning();
    return { orgId: org.id, connectionId: connection!.id, actorId: user.id };
  });
}

async function seedDueStateRows(fixture: SyncFixture, domains = DOMAINS): Promise<void> {
  const admin = getTestDb();
  for (const domain of domains) {
    await admin.execute(sql`
      INSERT INTO m365_sync_state (org_id, connection_id, domain, next_sync_at, interval_seconds)
      VALUES (${fixture.orgId}::uuid, ${fixture.connectionId}::uuid, ${domain}::m365_sync_domain,
              now() - interval '1 second', 21600)
      ON CONFLICT (org_id, domain) DO UPDATE SET next_sync_at = now() - interval '1 second', lease_until = NULL
    `);
  }
}

async function claimFor(fixture: SyncFixture) {
  const claimed = await claimDueDomains({ limit: 20 });
  return claimed.filter((job) => job.orgId === fixture.orgId);
}

async function rows<T = Record<string, unknown>>(query: ReturnType<typeof sql>): Promise<T[]> {
  const result = await getTestDb().execute(query);
  return result as unknown as T[];
}

// `getTestDb().execute(sql\`...\`)` bypasses Drizzle's column-type-aware
// result mapping (unlike the query builder, e.g. `db.select()...`) — and
// empirically, on this code path a timestamptz column comes back as a plain
// string rather than a parsed Date (confirmed by a `.getTime is not a
// function` failure before this helper existed). Compare instants via this
// helper instead of relying on `.getTime()`/`.toISOString()` existing on
// the field.
function toMs(value: Date | string | null | undefined): number | null {
  if (value == null) return null;
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

async function counterValue(registry: Registry, name: string): Promise<number> {
  const metric = registry.getSingleMetric(name);
  if (!metric) return Number.NaN;
  const collected = (await metric.get()) as { values: { value: number }[] };
  return collected.values.reduce((total, sample) => total + sample.value, 0);
}

let executor: FakeSyncExecutor;

beforeAll(async () => {
  executor = await createFakeSyncExecutor();
  syncExecutorConfig.origin = executor.origin;
  syncExecutorConfig.signingPrivateJwk = executor.signingPrivateJwk as Record<string, unknown>;
  syncExecutorConfig.signingKid = executor.signingKid;
});

// `executor` is created once for the whole file and its per-actionType
// fixture queues are never drained by `close()`. A test whose flow fences
// (or otherwise short-circuits) BEFORE the executor call it enqueued for —
// the Phase A/Phase C fencing tests below are exactly this shape — leaves
// that fixture sitting in the queue, where a LATER test using the same
// domain would silently dequeue someone else's stale fixture instead of its
// own. Reset before each test so every test's queue starts empty; this
// mirrors what a fresh executor per test would give without paying for a
// real key-pair generation + HTTP listener per test.
beforeEach(() => { executor.reset(); });

afterAll(async () => {
  await executor.close();
});

async function post(body: unknown, mutate: (claims: Record<string, unknown>) => Record<string, unknown> = (c) => c) {
  const raw = JSON.stringify(body);
  const issuedAt = Math.floor(Date.now() / 1_000);
  const claims = mutate({
    operation: 'sync-action',
    correlationId: randomUUID(),
    bodySha256: createHash('sha256').update(raw).digest('base64url'),
  });
  const token = await new SignJWT(claims)
    .setProtectedHeader({ alg: 'EdDSA', kid: executor.signingKid })
    .setIssuer('breeze-api')
    .setAudience('m365-graph-read-executor')
    .setSubject('breeze-control-plane')
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + 60)
    .setJti(randomUUID())
    .sign(await importJWK(executor.signingPrivateJwk, 'EdDSA'));
  return fetch(`${executor.origin}/v1/sync-action`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: raw,
  });
}

describe('fake sync executor harness', () => {
  it('accepts a correctly signed sync-action and returns the queued result', async () => {
    executor.enqueue('m365.sync.skus', {
      success: true, kind: 'sync', items: [], truncated: false,
      fetchedAt: '2026-09-08T10:00:00.000Z', sources: { subscribedSkus: 'ok' },
    });
    const response = await post({
      correlationId: randomUUID(),
      tenantId: '44444444-4444-4444-8444-444444444444',
      action: { type: 'm365.sync.skus' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    await expect(response.json()).resolves.toMatchObject({ kind: 'sync', truncated: false });
    expect(executor.calls.at(-1)).toMatchObject({ actionType: 'm365.sync.skus' });
  });

  it('rejects a token whose bodySha256 does not bind the received bytes', async () => {
    const before = executor.unauthorizedCount;
    const response = await post(
      { correlationId: randomUUID(), tenantId: '44444444-4444-4444-8444-444444444444', action: { type: 'm365.sync.skus' } },
      (claims) => ({ ...claims, bodySha256: createHash('sha256').update('{}').digest('base64url') }),
    );
    expect(response.status).toBe(401);
    expect(executor.unauthorizedCount).toBe(before + 1);
  });

  it('rejects a token bound to another operation', async () => {
    const response = await post(
      { correlationId: randomUUID(), tenantId: '44444444-4444-4444-8444-444444444444', action: { type: 'm365.sync.skus' } },
      (claims) => ({ ...claims, operation: 'read-action' }),
    );
    expect(response.status).toBe(401);
  });

  it('rejects a token whose lifetime exceeds 60 seconds', async () => {
    const raw = JSON.stringify({ correlationId: randomUUID(), tenantId: '44444444-4444-4444-8444-444444444444', action: { type: 'm365.sync.skus' } });
    const issuedAt = Math.floor(Date.now() / 1_000);
    const token = await new SignJWT({
      operation: 'sync-action', correlationId: randomUUID(),
      bodySha256: createHash('sha256').update(raw).digest('base64url'),
    })
      .setProtectedHeader({ alg: 'EdDSA', kid: executor.signingKid })
      .setIssuer('breeze-api').setAudience('m365-graph-read-executor').setSubject('breeze-control-plane')
      .setIssuedAt(issuedAt).setExpirationTime(issuedAt + 3_600).setJti(randomUUID())
      .sign(await importJWK(executor.signingPrivateJwk, 'EdDSA'));
    const response = await fetch(`${executor.origin}/v1/sync-action`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: raw,
    });
    expect(response.status).toBe(401);
  });

  it('returns 500 with no fixture queued rather than inventing a payload', async () => {
    const response = await post({
      correlationId: randomUUID(), tenantId: '44444444-4444-4444-8444-444444444444',
      action: { type: 'm365.sync.ca_policies' },
    });
    expect(response.status).toBe(500);
  });
});

describe('m365 tenant sync — first run across all seven domains', () => {
  runDb('populates every table, sync state, rollup, and the Graph-dated score backfill', async () => {
    process.env.M365_TENANT_SYNC_ENABLED = 'true';
    const fixture = await seedConnectedOrg();
    await seedDueStateRows(fixture);

    executor.enqueue('m365.sync.users', syncUsersResult([
      { id: 'aaaaaaaa-0000-4000-8000-000000000001', userPrincipalName: 'ada@contoso.example', assignedLicenses: ['11111111-0000-4000-8000-00000000000a'] },
      { id: 'aaaaaaaa-0000-4000-8000-000000000002', userPrincipalName: 'grace@contoso.example', mfaRegistered: null,
        adminRoles: [{ roleTemplateId: '62e90394-69f5-4237-9190-012177145e10', displayName: 'Global Administrator' }] },
      { id: 'aaaaaaaa-0000-4000-8000-000000000003', userPrincipalName: 'alan@contoso.example', accountEnabled: false },
    ]));
    // Sign-in activity returns a continuation once, then completes.
    executor.enqueue('m365.sync.signin_activity', syncSigninActivityResult(
      [{ id: 'aaaaaaaa-0000-4000-8000-000000000001', lastSuccessfulSignInAt: '2026-09-07T12:00:00.000Z' }],
      { continuation: 'page-2-token' },
    ));
    executor.enqueue('m365.sync.signin_activity', syncSigninActivityResult([
      { id: 'aaaaaaaa-0000-4000-8000-000000000002', lastSuccessfulSignInAt: '2026-09-06T09:30:00.000Z' },
      { id: 'aaaaaaaa-0000-4000-8000-000000000003', lastSuccessfulSignInAt: null },
    ]));
    executor.enqueue('m365.sync.intune_devices', syncIntuneDevicesResult([
      { id: 'bbbbbbbb-0000-4000-8000-000000000001', deviceName: 'CONTOSO-LT-01', serialNumber: 'SN-ALPHA-1' },
      { id: 'bbbbbbbb-0000-4000-8000-000000000002', deviceName: 'CONTOSO-LT-02', serialNumber: 'SN-ALPHA-2', complianceState: 'noncompliant' },
    ]));
    executor.enqueue('m365.sync.ca_policies', syncCaPoliciesResult([
      { id: 'cccccccc-0000-4000-8000-000000000001', displayName: 'Require MFA for admins', state: 'enabled' },
      { id: 'cccccccc-0000-4000-8000-000000000002', displayName: 'Legacy auth block (report only)', state: 'enabledForReportingButNotEnforced' },
    ]));
    executor.enqueue('m365.sync.skus', syncSkusResult([
      { skuId: '11111111-0000-4000-8000-00000000000a', skuPartNumber: 'SPB', consumedUnits: 3, enabled: 10 },
    ]));
    executor.enqueue('m365.sync.secure_score', syncSecureScoreResult('2026-09-08', 90));
    executor.enqueue('m365.sync.signin_events', syncSigninEventsResult([
      { id: 'dddddddd-0000-4000-8000-000000000001', createdDateTime: '2026-09-07T12:00:00.000Z' },
      { id: 'dddddddd-0000-4000-8000-000000000002', createdDateTime: '2026-09-08T08:15:00.000Z',
        userId: 'aaaaaaaa-0000-4000-8000-000000000002', userPrincipalName: 'grace@contoso.example' },
    ]));

    // Drive every claimed domain. The sign-in fixture hands back
    // `continuation: 'page-2-token'` on its first call, so THAT run resolves
    // 'partial-continue' — a control-flow-only M365SyncRunResult that never
    // reaches last_status. Every other domain completes in one pass.
    for (const job of await claimFor(fixture)) {
      await expect(runSyncDomain(job), job.domain).resolves.toBe(
        job.domain === 'signin_activity' ? 'partial-continue' : 'success',
      );
    }
    // `reclaimSameDomain` (run.ts) already re-claimed signin_activity itself
    // — inside the `runSyncDomain` call above — and handed it to the mocked
    // `enqueueSyncDomain`. A second `claimFor` would race that internal claim
    // and find nothing (writeCompletion's continuation mode releases the
    // lease but deliberately never touches next_sync_at, so the row's due-ness
    // is unchanged; `reclaimSameDomain` is what actually claims it). Drive the
    // SAME captured job instead of re-claiming or going through BullMQ.
    const signinAgain = capturedContinuationJobs.jobs.at(-1) as
      { orgId: string; domain: M365SyncDomain } | undefined;
    expect(signinAgain, 'the continuation must be re-claimed and handed off immediately').toBeDefined();
    expect(signinAgain!.domain).toBe('signin_activity');
    expect(signinAgain!.orgId).toBe(fixture.orgId);
    // Second page: the fixture carries no continuation, so the walk completes.
    await expect(runSyncDomain(signinAgain as never)).resolves.toBe('success');

    // Entity rows
    expect(await rows(sql`SELECT graph_id, is_stale FROM m365_users WHERE org_id = ${fixture.orgId}::uuid`)).toHaveLength(3);
    expect(await rows(sql`SELECT graph_id FROM m365_intune_devices WHERE org_id = ${fixture.orgId}::uuid`)).toHaveLength(2);
    expect(await rows(sql`SELECT graph_id FROM m365_ca_policies WHERE org_id = ${fixture.orgId}::uuid`)).toHaveLength(2);
    expect(await rows(sql`SELECT graph_id FROM m365_license_skus WHERE org_id = ${fixture.orgId}::uuid`)).toHaveLength(1);

    // Enrichment semantics: unknown MFA stays NULL, never false.
    const [grace] = await rows<{ mfa_registered: boolean | null; is_admin: boolean }>(sql`
      SELECT mfa_registered, is_admin FROM m365_users
      WHERE org_id = ${fixture.orgId}::uuid AND graph_id = 'aaaaaaaa-0000-4000-8000-000000000002'`);
    expect(grace!.mfa_registered).toBeNull();
    expect(grace!.is_admin).toBe(true);

    // Sign-in activity landed field-wise on the user rows.
    const [ada] = await rows<{ last_successful_sign_in_at: Date | null }>(sql`
      SELECT last_successful_sign_in_at FROM m365_users
      WHERE org_id = ${fixture.orgId}::uuid AND graph_id = 'aaaaaaaa-0000-4000-8000-000000000001'`);
    expect(ada!.last_successful_sign_in_at && new Date(ada!.last_successful_sign_in_at!).toISOString())
      .toBe('2026-09-07T12:00:00.000Z');

    // Secure score: 90 rows keyed by Graph's own date, not the fetch day.
    const scores = await rows<{ score_date: string; current_score: string }>(sql`
      SELECT score_date::text AS score_date, current_score::text AS current_score
      FROM m365_secure_score_snapshots WHERE org_id = ${fixture.orgId}::uuid ORDER BY score_date DESC`);
    expect(scores).toHaveLength(90);
    expect(scores[0]!.score_date).toBe('2026-09-08');
    expect(scores.at(-1)!.score_date).toBe('2026-06-11');
    expect(await rows(sql`
      SELECT 1 FROM m365_secure_score_snapshots
      WHERE org_id = ${fixture.orgId}::uuid AND tenant_id = ${TENANT_ID}::uuid`)).toHaveLength(90);

    // Sync state completion fields, per domain.
    const states = await rows<{
      domain: string; last_status: string; truncated: boolean; continuation: string | null;
      last_complete_snapshot_at: Date | null; sources: Record<string, string>;
      last_counts: Record<string, number>; lease_until: Date | null; next_sync_at: Date | null;
    }>(sql`
      SELECT domain, last_status, truncated, continuation, last_complete_snapshot_at,
             sources, last_counts, lease_until, next_sync_at
      FROM m365_sync_state WHERE org_id = ${fixture.orgId}::uuid ORDER BY domain`);
    expect(states.map((state) => state.domain).sort()).toEqual([...DOMAINS].sort());
    for (const state of states) {
      expect(state.last_status, state.domain).toBe('success');
      expect(state.truncated, state.domain).toBe(false);
      expect(state.continuation, state.domain).toBeNull();
      expect(state.lease_until, state.domain).toBeNull();
      expect(state.last_complete_snapshot_at, state.domain).not.toBeNull();
      expect(state.next_sync_at, state.domain).not.toBeNull();
      expect(Object.values(state.sources), state.domain).not.toContain('error');
    }
    // last_counts holds the snake_case ROLLUP column names (contract: "counts
    // keys are snake_case rollup column names"), not the persister's
    // inserted/updated/unchanged tally — that lives on DomainPersistResult and
    // is asserted in Task 3.
    const users = states.find((state) => state.domain === 'users')!;
    expect(users.last_counts).toMatchObject({
      users_total: 3, users_enabled: 2, users_mfa_unknown: 1, users_admin: 1,
    });

    // Rollup row for today, with per-domain freshness.
    const [rollup] = await rows<{
      users_total: number; users_mfa_unknown: number; devices_total: number;
      devices_noncompliant: number; ca_policies_enabled: number; ca_policies_report_only: number;
      seats_purchased: number; seats_consumed: number; secure_score: string;
      domains_fresh: Record<string, { asOf: string; complete: boolean }>;
    }>(sql`
      SELECT users_total, users_mfa_unknown, devices_total, devices_noncompliant,
             ca_policies_enabled, ca_policies_report_only, seats_purchased, seats_consumed,
             secure_score::text AS secure_score, domains_fresh
      FROM m365_posture_rollups
      WHERE org_id = ${fixture.orgId}::uuid AND rollup_date = current_date`);
    expect(rollup).toBeDefined();
    expect(rollup!).toMatchObject({
      users_total: 3, users_mfa_unknown: 1, devices_total: 2, devices_noncompliant: 1,
      ca_policies_enabled: 1, ca_policies_report_only: 1, seats_purchased: 10, seats_consumed: 3,
    });
    expect(Object.keys(rollup!.domains_fresh).sort()).toEqual([...DOMAINS].sort());
    for (const domain of DOMAINS) {
      expect(rollup!.domains_fresh[domain]!.complete, domain).toBe(true);
    }

    // The executor saw the backfill flag exactly once and the continuation round trip.
    expect(executor.calls.filter((call) => call.actionType === 'm365.sync.secure_score')[0]!.backfill).toBe(true);
    const signinCalls = executor.calls.filter((call) => call.actionType === 'm365.sync.signin_activity');
    expect(signinCalls).toHaveLength(2);
    expect(signinCalls[0]!.continuation).toBeUndefined();
    expect(signinCalls[1]!.continuation).toBe('page-2-token');
  });
});

describe('m365 tenant sync — change-only writes', () => {
  runDb('writes exactly one user row when exactly one user changed', async () => {
    process.env.M365_TENANT_SYNC_ENABLED = 'true';
    const fixture = await seedConnectedOrg();
    await seedDueStateRows(fixture, ['users']);

    const baseline = [
      { id: 'aaaaaaaa-0000-4000-8000-000000000001', userPrincipalName: 'ada@contoso.example', displayName: 'Ada Lovelace' },
      { id: 'aaaaaaaa-0000-4000-8000-000000000002', userPrincipalName: 'grace@contoso.example', displayName: 'Grace Hopper' },
      { id: 'aaaaaaaa-0000-4000-8000-000000000003', userPrincipalName: 'alan@contoso.example', displayName: 'Alan Turing' },
    ];
    executor.enqueue('m365.sync.users', syncUsersResult(baseline));
    const [firstJob] = await claimFor(fixture);
    await expect(runSyncDomain(firstJob!)).resolves.toBe('success');

    const tupleVersions = async () => rows<{ graph_id: string; xmin: string; last_changed_at: Date }>(sql`
      SELECT graph_id, xmin::text AS xmin, last_changed_at
      FROM m365_users WHERE org_id = ${fixture.orgId}::uuid ORDER BY graph_id`);
    const before = await tupleVersions();
    expect(before).toHaveLength(3);

    // Second run: identical payload except one user's job title.
    executor.enqueue('m365.sync.users', syncUsersResult(baseline.map((user) =>
      user.id.endsWith('002') ? { ...user, displayName: 'Grace M. Hopper' } : user)));
    await getTestDb().execute(sql`
      UPDATE m365_sync_state SET next_sync_at = now() - interval '1 second', lease_until = NULL
      WHERE org_id = ${fixture.orgId}::uuid AND domain = 'users'`);
    // The inserted/updated/unchanged tally is the persister's
    // DomainPersistResult, NOT last_counts — last_counts carries the
    // snake_case rollup columns (users_total, users_enabled, …). Observe the
    // real returned value by wrapping the registered persister for this run.
    type PersistResult = Awaited<ReturnType<NonNullable<(typeof DOMAIN_PERSISTERS)['users']>>>;
    const persisted: PersistResult[] = [];
    const realPersistUsers = DOMAIN_PERSISTERS.users!;
    DOMAIN_PERSISTERS.users = async (context, actionResult) => {
      const outcome = await realPersistUsers(context, actionResult);
      persisted.push(outcome);
      return outcome;
    };
    try {
      const [secondJob] = await claimFor(fixture);
      await expect(runSyncDomain(secondJob!)).resolves.toBe('success');
    } finally {
      DOMAIN_PERSISTERS.users = realPersistUsers;
    }

    const after = await tupleVersions();
    const rewritten = after.filter((row, index) => row.xmin !== before[index]!.xmin);
    expect(rewritten.map((row) => row.graph_id)).toEqual(['aaaaaaaa-0000-4000-8000-000000000002']);
    expect(toMs(after[1]!.last_changed_at)).toBeGreaterThan(toMs(before[1]!.last_changed_at)!);
    expect(toMs(after[0]!.last_changed_at)).toBe(toMs(before[0]!.last_changed_at));
    expect(toMs(after[2]!.last_changed_at)).toBe(toMs(before[2]!.last_changed_at));

    expect(persisted, 'the users persister ran exactly once on the second pass').toHaveLength(1);
    expect(persisted[0]).toMatchObject({ inserted: 0, updated: 1, unchanged: 2 });

    // And the state row's last_counts still carries only rollup columns.
    const [state] = await rows<{ last_counts: Record<string, number> }>(sql`
      SELECT last_counts FROM m365_sync_state
      WHERE org_id = ${fixture.orgId}::uuid AND domain = 'users'`);
    expect(state!.last_counts).toMatchObject({ users_total: 3, users_enabled: 3 });
    expect(Object.keys(state!.last_counts)).not.toContain('updated');
  });

  runDb('writes nothing at all when the tenant is unchanged', async () => {
    process.env.M365_TENANT_SYNC_ENABLED = 'true';
    const fixture = await seedConnectedOrg();
    await seedDueStateRows(fixture, ['ca_policies']);
    const policies = [{ id: 'cccccccc-0000-4000-8000-000000000001', displayName: 'Require MFA for admins', state: 'enabled' }];

    executor.enqueue('m365.sync.ca_policies', syncCaPoliciesResult(policies));
    await runSyncDomain((await claimFor(fixture))[0]!);
    const before = await rows<{ xmin: string }>(sql`
      SELECT xmin::text AS xmin FROM m365_ca_policies WHERE org_id = ${fixture.orgId}::uuid ORDER BY graph_id`);

    executor.enqueue('m365.sync.ca_policies', syncCaPoliciesResult(policies));
    await getTestDb().execute(sql`
      UPDATE m365_sync_state SET next_sync_at = now() - interval '1 second', lease_until = NULL
      WHERE org_id = ${fixture.orgId}::uuid AND domain = 'ca_policies'`);
    await runSyncDomain((await claimFor(fixture))[0]!);

    const after = await rows<{ xmin: string }>(sql`
      SELECT xmin::text AS xmin FROM m365_ca_policies WHERE org_id = ${fixture.orgId}::uuid ORDER BY graph_id`);
    expect(after).toEqual(before);
  });
});

describe('m365 tenant sync — incomplete and fenced runs', () => {
  runDb('a truncated run persists what it got and marks nothing stale', async () => {
    process.env.M365_TENANT_SYNC_ENABLED = 'true';
    const fixture = await seedConnectedOrg();
    await seedDueStateRows(fixture, ['users']);

    executor.enqueue('m365.sync.users', syncUsersResult([
      { id: 'aaaaaaaa-0000-4000-8000-000000000001', userPrincipalName: 'ada@contoso.example' },
      { id: 'aaaaaaaa-0000-4000-8000-000000000002', userPrincipalName: 'grace@contoso.example' },
    ]));
    await runSyncDomain((await claimFor(fixture))[0]!);
    const [completeState] = await rows<{ last_complete_snapshot_at: Date | null }>(sql`
      SELECT last_complete_snapshot_at FROM m365_sync_state
      WHERE org_id = ${fixture.orgId}::uuid AND domain = 'users'`);
    expect(completeState!.last_complete_snapshot_at).not.toBeNull();

    // Second run truncates and omits the second user. Nothing may go stale.
    executor.enqueue('m365.sync.users', syncUsersResult(
      [{ id: 'aaaaaaaa-0000-4000-8000-000000000001', userPrincipalName: 'ada@contoso.example' }],
      { users: 'ok', mfaRegistration: 'ok', roleAssignments: 'ok' },
      { truncated: true },
    ));
    await getTestDb().execute(sql`
      UPDATE m365_sync_state SET next_sync_at = now() - interval '1 second', lease_until = NULL
      WHERE org_id = ${fixture.orgId}::uuid AND domain = 'users'`);
    await expect(runSyncDomain((await claimFor(fixture))[0]!)).resolves.toBe('partial');

    expect(await rows(sql`
      SELECT graph_id FROM m365_users
      WHERE org_id = ${fixture.orgId}::uuid AND is_stale`)).toEqual([]);
    const [state] = await rows<{
      last_status: string; truncated: boolean; last_complete_snapshot_at: Date | null; interval_seconds: number;
    }>(sql`
      SELECT last_status, truncated, last_complete_snapshot_at, interval_seconds
      FROM m365_sync_state WHERE org_id = ${fixture.orgId}::uuid AND domain = 'users'`);
    expect(state!.last_status).toBe('partial');
    expect(state!.truncated).toBe(true);
    expect(toMs(state!.last_complete_snapshot_at))
      .toBe(toMs(completeState!.last_complete_snapshot_at));
    expect(state!.interval_seconds, 'truncation doubles the interval (§5.7)').toBe(43_200);
  });

  runDb('a complete run after a truncated one does mark the vanished row stale', async () => {
    process.env.M365_TENANT_SYNC_ENABLED = 'true';
    const fixture = await seedConnectedOrg();
    await seedDueStateRows(fixture, ['users']);
    executor.enqueue('m365.sync.users', syncUsersResult([
      { id: 'aaaaaaaa-0000-4000-8000-000000000001', userPrincipalName: 'ada@contoso.example' },
      { id: 'aaaaaaaa-0000-4000-8000-000000000002', userPrincipalName: 'grace@contoso.example' },
    ]));
    await runSyncDomain((await claimFor(fixture))[0]!);

    executor.enqueue('m365.sync.users', syncUsersResult([
      { id: 'aaaaaaaa-0000-4000-8000-000000000001', userPrincipalName: 'ada@contoso.example' },
    ]));
    await getTestDb().execute(sql`
      UPDATE m365_sync_state SET next_sync_at = now() - interval '1 second', lease_until = NULL
      WHERE org_id = ${fixture.orgId}::uuid AND domain = 'users'`);
    await runSyncDomain((await claimFor(fixture))[0]!);

    const stale = await rows<{ graph_id: string; stale_since: Date | null }>(sql`
      SELECT graph_id, stale_since FROM m365_users
      WHERE org_id = ${fixture.orgId}::uuid AND is_stale`);
    expect(stale.map((row) => row.graph_id)).toEqual(['aaaaaaaa-0000-4000-8000-000000000002']);
    expect(stale[0]!.stale_since).not.toBeNull();
  });

  runDb('a claim already superseded before the run starts is fenced at Phase A', async () => {
    // The generation bump lands BEFORE runSyncDomain is even called, so this
    // proves Phase A's own re-read (loadSyncRunContext) catches a stale
    // claim — not the independent Phase C check the run makes after the
    // executor call returns (that is the next test below).
    process.env.M365_TENANT_SYNC_ENABLED = 'true';
    const registry = new Registry();
    registerM365SyncMetrics(registry);
    const fixture = await seedConnectedOrg();
    await seedDueStateRows(fixture, ['skus']);

    executor.enqueue('m365.sync.skus', syncSkusResult([
      { skuId: '11111111-0000-4000-8000-00000000000a', skuPartNumber: 'SPB', consumedUnits: 3, enabled: 10 },
    ]));
    const [job] = await claimFor(fixture);
    // The ticker reclaimed the row before this job was ever handed to
    // runSyncDomain.
    await getTestDb().execute(sql`
      UPDATE m365_sync_state SET run_generation = run_generation + 1
      WHERE org_id = ${fixture.orgId}::uuid AND domain = 'skus'`);

    const fencedBefore = await counterValue(registry, 'm365_sync_fenced_total');
    await expect(runSyncDomain(job!)).resolves.toBe('fenced');
    expect(await counterValue(registry, 'm365_sync_fenced_total')).toBe(fencedBefore + 1);
    // The fixture was never consumed — Phase A fenced before Phase B's
    // executor call ever ran.
    expect(executor.calls.some((call) => call.actionType === 'm365.sync.skus')).toBe(false);

    expect(await rows(sql`SELECT graph_id FROM m365_license_skus WHERE org_id = ${fixture.orgId}::uuid`)).toEqual([]);
    const [state] = await rows<{ last_status: string | null; last_run_at: Date | null }>(sql`
      SELECT last_status, last_run_at FROM m365_sync_state
      WHERE org_id = ${fixture.orgId}::uuid AND domain = 'skus'`);
    expect(state!.last_status).toBeNull();
    expect(state!.last_run_at).toBeNull();
  });

  runDb('a generation superseded WHILE the executor call is in flight is fenced at Phase C', async () => {
    // Phase A's own re-read passes here (the generation is still current when
    // runSyncDomain starts) — the bump is injected into the Phase C hook
    // itself, landing after Phase B's executor call has already returned and
    // exactly where the real race this fence exists for occurs: a reclaim
    // that happens between the outbound Graph call and the completion write.
    process.env.M365_TENANT_SYNC_ENABLED = 'true';
    const registry = new Registry();
    registerM365SyncMetrics(registry);
    const fixture = await seedConnectedOrg();
    await seedDueStateRows(fixture, ['skus']);

    executor.enqueue('m365.sync.skus', syncSkusResult([
      { skuId: '11111111-0000-4000-8000-00000000000a', skuPartNumber: 'SPB', consumedUnits: 3, enabled: 10 },
    ]));
    const [job] = await claimFor(fixture);

    const fencedBefore = await counterValue(registry, 'm365_sync_fenced_total');
    await expect(runSyncDomain(job!, {
      deps: {
        assertStillFenced: async (data) => {
          await getTestDb().execute(sql`
            UPDATE m365_sync_state SET run_generation = run_generation + 1
            WHERE org_id = ${data.orgId}::uuid AND domain = ${data.domain}::m365_sync_domain`);
          return assertStillFenced(data);
        },
      },
    })).resolves.toBe('fenced');
    expect(await counterValue(registry, 'm365_sync_fenced_total')).toBe(fencedBefore + 1);
    // Unlike the Phase A case, the executor WAS called — Phase C's job is to
    // discard a result that already arrived, not to prevent the call.
    expect(executor.calls.some((call) => call.actionType === 'm365.sync.skus')).toBe(true);

    expect(await rows(sql`SELECT graph_id FROM m365_license_skus WHERE org_id = ${fixture.orgId}::uuid`)).toEqual([]);
    const [state] = await rows<{ last_status: string | null; last_run_at: Date | null }>(sql`
      SELECT last_status, last_run_at FROM m365_sync_state
      WHERE org_id = ${fixture.orgId}::uuid AND domain = 'skus'`);
    expect(state!.last_status).toBeNull();
    expect(state!.last_run_at).toBeNull();
  });
});

describe('m365 tenant sync — executor failure path', () => {
  // Every other case in this suite enqueues a success (M365SyncActionResult)
  // response. `runSyncDomain`'s !call.ok branch (outcomeForFailure et al.) —
  // roughly a third of the function, covering the credential-dead
  // unschedule, the Sentry-quota-safe error path, and throttle handling — was
  // otherwise never exercised end to end. `credential_unavailable` covers the
  // unschedule + non-Sentry-worthy arm (run.ts's outcomeForFailure).
  runDb('a dead credential is recorded, unscheduled, and never thrown as an exception', async () => {
    process.env.M365_TENANT_SYNC_ENABLED = 'true';
    const fixture = await seedConnectedOrg();
    await seedDueStateRows(fixture, ['skus']);

    // Wire shape per packages/shared/src/m365/readActions.ts's
    // m365SyncActionFailureSchema (.strict(): success/code/retryAfterSeconds
    // only). The executor returns this with HTTP 200 — graphReadExecutorClient
    // .syncAction only special-cases 503 (sync_capacity); every other failure
    // code rides a 200 body with `success: false`.
    executor.enqueue('m365.sync.skus', { status: 200, body: { success: false, code: 'credential_unavailable' } });

    const [job] = await claimFor(fixture);
    // outcomeForFailure's sentryWorthy=false for this code is exactly the
    // BREEZE-1 fix: a config problem already recorded on the row must not
    // also throw and burn a Sentry event on every scheduled run.
    await expect(runSyncDomain(job!)).resolves.toBe('error');

    const [state] = await rows<{
      last_status: string | null; next_sync_at: Date | null; last_error: string | null; lease_until: Date | null;
    }>(sql`
      SELECT last_status, next_sync_at, last_error, lease_until FROM m365_sync_state
      WHERE org_id = ${fixture.orgId}::uuid AND domain = 'skus'`);
    expect(state!.last_status).toBe('error');
    // unschedule: true — the domain waits for re-consent/retest, not the ticker.
    expect(state!.next_sync_at).toBeNull();
    expect(state!.last_error).toContain('credential_unavailable');
    expect(state!.lease_until).toBeNull();
    // No rows written on a failed pull.
    expect(await rows(sql`SELECT graph_id FROM m365_license_skus WHERE org_id = ${fixture.orgId}::uuid`)).toEqual([]);
  });
});

describe('m365 tenant sync — disconnect', () => {
  runDb('deletes entity and state rows, keeps tenant-stamped history', async () => {
    process.env.M365_TENANT_SYNC_ENABLED = 'true';
    const fixture = await seedConnectedOrg();
    await seedDueStateRows(fixture, ['users', 'skus', 'secure_score']);

    executor.enqueue('m365.sync.users', syncUsersResult([
      { id: 'aaaaaaaa-0000-4000-8000-000000000001', userPrincipalName: 'ada@contoso.example' },
    ]));
    executor.enqueue('m365.sync.skus', syncSkusResult([
      { skuId: '11111111-0000-4000-8000-00000000000a', skuPartNumber: 'SPB', consumedUnits: 1, enabled: 5 },
    ]));
    executor.enqueue('m365.sync.secure_score', syncSecureScoreResult('2026-09-08', 3));
    for (const job of await claimFor(fixture)) await runSyncDomain(job);

    expect(await rows(sql`SELECT graph_id FROM m365_users WHERE org_id = ${fixture.orgId}::uuid`)).toHaveLength(1);
    expect(await rows(sql`SELECT score_date FROM m365_secure_score_snapshots WHERE org_id = ${fixture.orgId}::uuid`)).toHaveLength(3);
    const rollupsBefore = await rows(sql`SELECT rollup_date FROM m365_posture_rollups WHERE org_id = ${fixture.orgId}::uuid`);
    expect(rollupsBefore.length).toBeGreaterThan(0);

    await disconnectCustomerGraphReadConnection({
      id: fixture.connectionId, orgId: fixture.orgId, actorId: fixture.actorId,
    });

    // Entities and schedule: gone.
    expect(await rows(sql`SELECT graph_id FROM m365_users WHERE org_id = ${fixture.orgId}::uuid`)).toEqual([]);
    expect(await rows(sql`SELECT graph_id FROM m365_license_skus WHERE org_id = ${fixture.orgId}::uuid`)).toEqual([]);
    expect(await rows(sql`SELECT domain FROM m365_sync_state WHERE org_id = ${fixture.orgId}::uuid`)).toEqual([]);

    // History: kept, still stamped with the tenant it came from.
    const scores = await rows<{ tenant_id: string }>(sql`
      SELECT tenant_id::text AS tenant_id FROM m365_secure_score_snapshots
      WHERE org_id = ${fixture.orgId}::uuid`);
    expect(scores).toHaveLength(3);
    expect(new Set(scores.map((score) => score.tenant_id))).toEqual(new Set([TENANT_ID]));
    expect(await rows(sql`SELECT rollup_date FROM m365_posture_rollups WHERE org_id = ${fixture.orgId}::uuid`))
      .toHaveLength(rollupsBefore.length);

    // The connection row itself survives as revoked with the tenant released.
    const [connection] = await withSystemDbAccessContext(() => db.select().from(m365Connections)
      .where(eq(m365Connections.id, fixture.connectionId)));
    expect(connection).toMatchObject({ status: 'revoked', tenantId: null });
  });
});
