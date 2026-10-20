/**
 * Integration test — M365 customer-graph-actions Retest after a manifest bump
 * (real PG, #8661 / #8745).
 *
 * Seeds the state a manifest bump actually leaves behind: a bound, `active`
 * actions row whose stored `permission_manifest_version` is one behind the
 * code manifest. The operator then presses Retest and the tenant has not yet
 * granted the roles the new manifest adds, so reconciliation comes back with
 * missing grants. That Retest must NOT advance the stored manifest version —
 * advancing it collapsed `manifest-stale` into `grant_missing` and made
 * `initiateUpgradeConsent` throw `manifest_current`, leaving only a full
 * re-consent (which stops every write) as the way out.
 *
 * Everything runs through the real actions routes (retest, upgrade-consent)
 * and the real actions consent callback; only the executor client is stubbed.
 *
 * Run:
 *   cd apps/api && npx vitest run --config vitest.integration.config.ts m365ActionsRetestManifestVersion
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import {
  canonicalGrantKey,
  M365_PERMISSION_PROFILES,
  type CanonicalAppRoleAssignment,
  type RetestResult,
  type VerifyConsentIdentityResult,
} from '@breeze/shared/m365';
import { db, withSystemDbAccessContext } from '../../db';
import { m365Connections, m365ConsentSessions } from '../../db/schema';
import { createAccessToken } from '../../services/jwt';
import {
  deriveGrantHealth,
  initiateCustomerGraphReadConsent,
  retestCustomerGraphReadConnection,
  type M365ConnectionSnapshot,
} from '../../services/m365ControlPlane/connectionService';
import {
  actionsConnectionService,
  initiateCustomerGraphActionsConsent,
} from '../../services/m365ControlPlane/writeActionConnectionService';
import { m365CustomerGraphActionsRoutes } from '../../routes/m365CustomerGraphActions';
import { createM365ConsentCallbackRoutes } from '../../routes/m365ConsentCallback';
import { createOrganization, createPartner, createUser, setupTestEnvironment } from './db-utils';

const executorStub = vi.hoisted(() => ({
  retest: null as null | (() => Promise<RetestResult>),
}));

vi.mock('../../services/m365ControlPlane/writeActionRuntimeConfig', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../services/m365ControlPlane/writeActionRuntimeConfig')
  >();
  return {
    ...actual,
    loadM365CustomerGraphActionsRuntimeConfig: () => FAKE_ACTIONS_CONFIG,
    isM365CustomerGraphActionsOnboardingEnabledForOrg: () => true,
    m365CustomerGraphActionsOnboardingAvailability: () => 'enabled' as const,
  };
});

// The Retest ROUTE builds its executor client from the runtime config; swap
// only the client factory so the route, service and CAS all run for real.
vi.mock('../../services/m365ControlPlane/graphActionsExecutorClient', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../services/m365ControlPlane/graphActionsExecutorClient')
  >();
  return {
    ...actual,
    createGraphActionsExecutorClient: () => ({
      retestCustomerGraphActions: () => {
        if (!executorStub.retest) throw new Error('retest stub not armed');
        return executorStub.retest();
      },
    }),
  };
});

// The read-profile control below drives the read service directly.
vi.mock('../../services/m365ControlPlane/runtimeConfig', () => ({
  loadM365CustomerGraphReadRuntimeConfig: () => ({
    clientId: READ_CLIENT_ID,
    vaultRef: 'akv://vault.example/m365-customer-graph-read/0123456789abcdef0123456789abcdef',
    credentialVersion: '0123456789abcdef0123456789abcdef',
    callbackUrl: 'https://console.example.test/api/v1/m365/consent/callback',
    executorUrl: 'https://executor.internal.example.test',
    executorAudience: 'm365-graph-read-executor',
    executorSigningPrivateJwk: {},
    executorSigningKid: 'key-1',
    onboardingOrgIds: '*',
  }),
  isM365CustomerGraphReadOnboardingEnabledForOrg: () => true,
  m365CustomerGraphReadOnboardingAvailability: () => 'enabled',
}));

const READ_CLIENT_ID = '55555555-5555-4555-8555-555555555555';
const FAKE_ACTIONS_CONFIG = {
  clientId: '66666666-6666-4666-8666-666666666666',
  vaultRef: 'akv://vault.example/m365-customer-graph-actions/0123456789abcdef0123456789abcdef',
  credentialVersion: '0123456789abcdef0123456789abcdef',
  callbackUrl: 'https://console.example.test/api/v1/m365/actions-consent/callback',
  executorUrl: 'https://executor.internal.example.test',
  executorAudience: 'm365-graph-actions-executor' as const,
  executorSigningPrivateJwk: {},
  executorSigningKid: 'key-1',
  onboardingOrgIds: '*' as const,
};

const MANIFEST = M365_PERMISSION_PROFILES['customer-graph-actions'];
const CURRENT = MANIFEST.version;
const STALE = CURRENT - 1;

function canonical(grants: readonly CanonicalAppRoleAssignment[]): CanonicalAppRoleAssignment[] {
  return [...grants].sort((left, right) => canonicalGrantKey(left).localeCompare(canonicalGrantKey(right)));
}

const REQUIRED = canonical(MANIFEST.applicationPermissionAssignments ?? []);
// The tenant still holds only part of what the bumped manifest requires.
const PARTIAL = REQUIRED.slice(0, 1);

const runDb = it.runIf(!!process.env.DATABASE_URL);

beforeEach(() => {
  executorStub.retest = null;
});

// --- fixtures ---------------------------------------------------------

type Env = Awaited<ReturnType<typeof setupTestEnvironment>>;

async function mintMfaToken(env: Env) {
  return createAccessToken({
    sub: env.user.id,
    email: env.user.email,
    roleId: env.role.id,
    orgId: env.organization.id,
    partnerId: env.partner.id,
    scope: 'organization' as const,
    mfa: true,
    aep: 1,
    mep: 1,
    sid: `it-actions-retest-${randomUUID()}`,
  });
}

/** A bound, executing actions row one manifest version behind the code. */
async function seedStaleActiveRow(env: Env, tenantId: string, manifestVersion = STALE) {
  const initiated = await initiateCustomerGraphActionsConsent({
    orgId: env.organization.id,
    actorId: env.user.id,
  });
  const verifiedAt = new Date('2026-10-01T12:00:00.000Z');
  await withSystemDbAccessContext(() => db.update(m365Connections).set({
    tenantId,
    clientId: FAKE_ACTIONS_CONFIG.clientId,
    displayName: 'Contoso Actions',
    permissionManifestVersion: manifestVersion,
    observedGrants: PARTIAL,
    grantsVerifiedAt: verifiedAt,
    lastVerifiedAt: verifiedAt,
    consentedAt: verifiedAt,
    status: 'active',
    lastErrorCode: null,
  }).where(eq(m365Connections.id, initiated.connection.id)));
  // initiateConsent minted an identity session for the first-connect flow;
  // a bound active row never carries one.
  await withSystemDbAccessContext(() => db.delete(m365ConsentSessions)
    .where(eq(m365ConsentSessions.connectionId, initiated.connection.id)));
  return initiated.connection.id;
}

async function actionsRow(orgId: string) {
  return withSystemDbAccessContext(async () => {
    const rows = await db.select().from(m365Connections).where(and(
      eq(m365Connections.orgId, orgId),
      eq(m365Connections.profile, 'customer-graph-actions'),
    ));
    return rows[0]!;
  });
}

function health(row: unknown) {
  return deriveGrantHealth(row as M365ConnectionSnapshot<'customer-graph-actions'>, MANIFEST);
}

function retestResult(
  tenantId: string,
  observed: CanonicalAppRoleAssignment[],
  applicationId = FAKE_ACTIONS_CONFIG.clientId,
  manifestVersion = CURRENT,
): RetestResult {
  const requiredKeys = new Set(REQUIRED.map(canonicalGrantKey));
  const observedKeys = new Set(observed.map(canonicalGrantKey));
  return {
    success: true,
    tenantId,
    applicationId,
    organizationDisplayName: 'Contoso Actions',
    manifestVersion,
    verifiedAt: new Date().toISOString(),
    grantReconciliation: 'complete',
    observedGrants: observed,
    missingGrants: REQUIRED.filter((grant) => !observedKeys.has(canonicalGrantKey(grant))),
    unexpectedGrants: observed.filter((grant) => !requiredKeys.has(canonicalGrantKey(grant))),
    grantsVerifiedAt: new Date().toISOString(),
  };
}

function buildApp(tenantId: string) {
  const verifyConsentIdentity = vi.fn(async (): Promise<VerifyConsentIdentityResult> => ({
    success: true,
    tenantId,
    administratorObjectId: '77777777-7777-4777-8777-777777777777',
    administratorUsername: null,
    verifiedAt: new Date().toISOString(),
  }));
  const app = new Hono();
  app.route('/api/v1/m365/customer-graph-actions', m365CustomerGraphActionsRoutes);
  app.route('/api/v1/m365', createM365ConsentCallbackRoutes({
    profile: 'customer-graph-actions',
    loadRuntimeConfig: () => FAKE_ACTIONS_CONFIG,
    createExecutorClient: () => ({
      verifyConsentIdentity,
      retest: () => {
        if (!executorStub.retest) throw new Error('retest stub not armed');
        return executorStub.retest();
      },
    }),
    connectionService: actionsConnectionService,
  }));
  return app;
}

async function retestViaRoute(app: Hono, token: string, orgId: string, connectionId: string) {
  const res = await app.request(
    `/api/v1/m365/customer-graph-actions/connections/${connectionId}/retest?orgId=${orgId}`,
    { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
  );
  expect(res.status).toBe(200);
  return res.json() as Promise<{ connection: { grantHealth: string; manifestVersion: number; currentManifestVersion: number } }>;
}

function cookiePair(setCookieHeader: string | null): string {
  if (!setCookieHeader) throw new Error('expected a Set-Cookie response header');
  return setCookieHeader.split(';')[0]!;
}

// --- tests ------------------------------------------------------------

describe('customer-graph-actions Retest after a manifest bump (real DB)', () => {
  runDb('Retest with missing grants keeps the stored version, stays upgrade-eligible, and the upgrade completes', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const token = await mintMfaToken(env);
    const tenantId = randomUUID();
    const connectionId = await seedStaleActiveRow(env, tenantId);
    const app = buildApp(tenantId);

    // Retest: the tenant has not yet granted the roles the bump added.
    executorStub.retest = async () => retestResult(tenantId, PARTIAL);
    const retested = await retestViaRoute(app, token, env.organization.id, connectionId);
    expect(retested.connection).toMatchObject({
      grantHealth: 'manifest-stale',
      manifestVersion: STALE,
      currentManifestVersion: CURRENT,
    });

    const afterRetest = await actionsRow(env.organization.id);
    expect(afterRetest.permissionManifestVersion).toBe(STALE);
    // Keeps executing on the grants it already had: writes are not stopped
    // for roles the customer has not been asked to approve yet.
    expect(afterRetest.status).toBe('active');
    expect(afterRetest.lastErrorCode).toBe('manifest_stale');
    expect(afterRetest.lastErrorCode).not.toBe('grant_missing');
    expect(health(afterRetest).state).toBe('manifest-stale');
    // The fresh observation is still recorded.
    expect(afterRetest.observedGrants).toEqual(PARTIAL);
    expect(afterRetest.lastVerifiedAt!.getTime()).toBeGreaterThan(new Date('2026-10-01T12:00:00.000Z').getTime());

    // The actions upgrade-consent route accepts it (no `manifest_current`)
    // and pins the identity sign-in to the bound tenant.
    const upgradeRes = await app.request(
      `/api/v1/m365/customer-graph-actions/connections/${connectionId}/upgrade-consent?orgId=${env.organization.id}`,
      { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
    );
    expect(upgradeRes.status).toBe(200);
    const { adminConsentUrl } = await upgradeRes.json() as { adminConsentUrl: string };
    const identityUrl = new URL(adminConsentUrl);
    expect(identityUrl.pathname).toBe(`/${tenantId}/oauth2/v2.0/authorize`);
    expect(upgradeRes.headers.get('set-cookie')).toContain('Path=/api/v1/m365/actions-consent/callback');

    // Upgrade writes nothing to the row: still executable, same version.
    const duringUpgrade = await actionsRow(env.organization.id);
    expect(duringUpgrade.permissionManifestVersion).toBe(STALE);
    expect(duringUpgrade.consentAttemptId).toBe(afterRetest.consentAttemptId);
    const sessions = await withSystemDbAccessContext(() => db.select().from(m365ConsentSessions)
      .where(eq(m365ConsentSessions.connectionId, connectionId)));
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.purpose).toBe('upgrade');
    expect(sessions[0]!.profile).toBe('customer-graph-actions');

    // Drive the upgrade through the real actions callback: identity (pinned
    // tenant, no interstitial) → admin consent → promotion in place.
    const step1 = await app.request(
      `/api/v1/m365/actions-consent/callback?state=${encodeURIComponent(identityUrl.searchParams.get('state')!)}&code=fake-identity-code`,
      { headers: { cookie: cookiePair(upgradeRes.headers.get('set-cookie')) } },
    );
    expect(step1.status).toBe(302);
    const consentUrl = new URL(step1.headers.get('location')!);
    expect(consentUrl.pathname).toBe(`/${tenantId}/oauth2/authorize`);

    executorStub.retest = async () => retestResult(tenantId, REQUIRED);
    const step2 = await app.request(
      `/api/v1/m365/actions-consent/callback?state=${encodeURIComponent(consentUrl.searchParams.get('state')!)}&code=discarded-consent-code`,
      { headers: { cookie: cookiePair(step1.headers.get('set-cookie')) } },
    );
    expect(step2.status).toBe(302);
    expect(new URL(step2.headers.get('location')!, 'http://localhost.invalid').hash)
      .toBe('#m365/customer-graph-actions/active');

    const upgraded = await actionsRow(env.organization.id);
    expect(upgraded).toMatchObject({
      status: 'active',
      permissionManifestVersion: CURRENT,
      tenantId,
      lastErrorCode: null,
    });
    expect(upgraded.consentGeneration).toBe(afterRetest.consentGeneration + 1);
  });

  runDb('a later Retest that sees every required grant advances the version', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const token = await mintMfaToken(env);
    const tenantId = randomUUID();
    const connectionId = await seedStaleActiveRow(env, tenantId);
    const app = buildApp(tenantId);

    executorStub.retest = async () => retestResult(tenantId, PARTIAL);
    await retestViaRoute(app, token, env.organization.id, connectionId);
    expect((await actionsRow(env.organization.id)).permissionManifestVersion).toBe(STALE);

    // The administrator granted the new roles directly in Entra.
    executorStub.retest = async () => retestResult(tenantId, REQUIRED);
    const retested = await retestViaRoute(app, token, env.organization.id, connectionId);
    expect(retested.connection).toMatchObject({ grantHealth: 'active', manifestVersion: CURRENT });

    const row = await actionsRow(env.organization.id);
    expect(row).toMatchObject({ status: 'active', permissionManifestVersion: CURRENT, lastErrorCode: null });
    expect(health(row).state).toBe('active');
  });

  runDb('Retest whose grant reconciliation is unavailable keeps the stored version', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const token = await mintMfaToken(env);
    const tenantId = randomUUID();
    const connectionId = await seedStaleActiveRow(env, tenantId);
    const app = buildApp(tenantId);

    executorStub.retest = async () => ({
      success: true,
      tenantId,
      applicationId: FAKE_ACTIONS_CONFIG.clientId,
      organizationDisplayName: 'Contoso Actions',
      manifestVersion: CURRENT,
      verifiedAt: new Date().toISOString(),
      grantReconciliation: 'unavailable',
      errorCode: 'grant_reconciliation_unavailable',
      observedGrants: null,
      missingGrants: null,
      unexpectedGrants: null,
      grantsVerifiedAt: null,
    });
    await retestViaRoute(app, token, env.organization.id, connectionId);

    const row = await actionsRow(env.organization.id);
    expect(row).toMatchObject({
      status: 'degraded',
      permissionManifestVersion: STALE,
      lastErrorCode: 'grant_reconciliation_unavailable',
    });
    // Previously verified observation is not discarded.
    expect(row.observedGrants).toEqual(PARTIAL);
    expect(health(row).state).toBe('manifest-stale');
    await expect(actionsConnectionService.initiateUpgradeConsent({
      connectionId,
      orgId: env.organization.id,
      auth: { scope: 'organization', orgId: env.organization.id, accessibleOrgIds: [env.organization.id], partnerId: null, user: { id: env.user.id } } as never,
    })).resolves.toBeDefined();
  });

  runDb('a current-version row that loses a grant still degrades to grant_missing (unchanged)', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const token = await mintMfaToken(env);
    const tenantId = randomUUID();
    const connectionId = await seedStaleActiveRow(env, tenantId, CURRENT);
    const app = buildApp(tenantId);

    executorStub.retest = async () => retestResult(tenantId, PARTIAL);
    await retestViaRoute(app, token, env.organization.id, connectionId);

    const row = await actionsRow(env.organization.id);
    expect(row).toMatchObject({
      status: 'degraded',
      permissionManifestVersion: CURRENT,
      lastErrorCode: 'grant_missing',
    });
    expect(health(row).state).toBe('missing');
  });

  runDb('upgrade-consent is refused for a connection in another organization', async () => {
    const owner = await setupTestEnvironment({ scope: 'organization' });
    const tenantId = randomUUID();
    const connectionId = await seedStaleActiveRow(owner, tenantId);
    const intruder = await setupTestEnvironment({ scope: 'organization' });
    const intruderToken = await mintMfaToken(intruder);
    const app = buildApp(tenantId);

    // Own org in the query, foreign connection id: RLS + org predicate miss.
    const ownOrg = await app.request(
      `/api/v1/m365/customer-graph-actions/connections/${connectionId}/upgrade-consent?orgId=${intruder.organization.id}`,
      { method: 'POST', headers: { Authorization: `Bearer ${intruderToken}` } },
    );
    expect(ownOrg.status).toBe(404);
    // Foreign org in the query: refused before the service runs.
    const foreignOrg = await app.request(
      `/api/v1/m365/customer-graph-actions/connections/${connectionId}/upgrade-consent?orgId=${owner.organization.id}`,
      { method: 'POST', headers: { Authorization: `Bearer ${intruderToken}` } },
    );
    expect(foreignOrg.status).toBe(404);

    const sessions = await withSystemDbAccessContext(() => db.select().from(m365ConsentSessions)
      .where(eq(m365ConsentSessions.connectionId, connectionId)));
    expect(sessions).toEqual([]);
  });
});

describe('customer-graph-read Retest manifest behavior is unchanged (control)', () => {
  // Pinned on purpose: this wave changes only the actions profile. The read
  // profile still advances its stored version on any verified Retest.
  runDb('read Retest with missing grants still advances the stored version', async () => {
    const READ = M365_PERMISSION_PROFILES['customer-graph-read'];
    const partner = await withSystemDbAccessContext(() => createPartner());
    const org = await withSystemDbAccessContext(() => createOrganization({ partnerId: partner.id }));
    const user = await withSystemDbAccessContext(() => createUser({
      partnerId: partner.id,
      orgId: org.id,
      email: `m365-read-retest-${randomUUID()}@example.com`,
    }));
    const initiated = await initiateCustomerGraphReadConsent({ orgId: org.id, actorId: user.id });
    const tenantId = randomUUID();
    const readRequired = canonical(READ.applicationPermissionAssignments ?? []);
    const verifiedAt = new Date('2026-10-01T12:00:00.000Z');
    await withSystemDbAccessContext(async () => {
      await db.update(m365Connections).set({
        tenantId,
        clientId: READ_CLIENT_ID,
        displayName: 'Contoso',
        permissionManifestVersion: READ.version - 1,
        observedGrants: readRequired.slice(0, 1),
        grantsVerifiedAt: verifiedAt,
        lastVerifiedAt: verifiedAt,
        consentedAt: verifiedAt,
        status: 'active',
        lastErrorCode: null,
      }).where(eq(m365Connections.id, initiated.connection.id));
      await db.delete(m365ConsentSessions)
        .where(eq(m365ConsentSessions.connectionId, initiated.connection.id));
    });

    const observed = readRequired.slice(0, 1);
    const observedKeys = new Set(observed.map(canonicalGrantKey));
    const connection = await retestCustomerGraphReadConnection({
      id: initiated.connection.id,
      orgId: org.id,
      auth: { scope: 'organization', orgId: org.id, accessibleOrgIds: [org.id], partnerId: null, user: { id: user.id } } as never,
      executorClient: {
        retestCustomerGraphRead: async (): Promise<RetestResult> => ({
          success: true,
          tenantId,
          applicationId: READ_CLIENT_ID,
          organizationDisplayName: 'Contoso',
          manifestVersion: READ.version,
          verifiedAt: new Date().toISOString(),
          grantReconciliation: 'complete',
          observedGrants: observed,
          missingGrants: readRequired.filter((grant) => !observedKeys.has(canonicalGrantKey(grant))),
          unexpectedGrants: [],
          grantsVerifiedAt: new Date().toISOString(),
        }),
      } as never,
    });

    expect(connection).toMatchObject({
      permissionManifestVersion: READ.version,
      status: 'degraded',
      lastErrorCode: 'grant_missing',
    });
  });
});
