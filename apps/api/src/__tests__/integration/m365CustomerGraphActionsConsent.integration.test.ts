/**
 * Integration test — M365 customer-graph-actions consent lifecycle (real PG)
 *
 * Drives the full HTTP consent round trip (initiate → identity-verification
 * callback → tenant-pinned admin-consent callback) through the real actions route + real
 * actions callback route, against a real database, with a stubbed executor
 * client injected via `createExecutorClient`. Also exercises the fail-closed
 * cross-org / cross-profile scoping directly at the service layer, matching
 * the pattern in `m365ConnectionLifecycle.integration.test.ts`.
 *
 * Run:
 *   pnpm --filter @breeze/api test:integration -- m365CustomerGraphActionsConsent
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi, beforeEach } from 'vitest';
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
  type M365ConnectionSnapshot,
} from '../../services/m365ControlPlane/connectionService';
import { consumeConsentSession } from '../../services/m365ControlPlane/consentSessionService';
import {
  actionsConnectionService,
  initiateCustomerGraphActionsConsent,
} from '../../services/m365ControlPlane/writeActionConnectionService';
import { m365CustomerGraphActionsRoutes } from '../../routes/m365CustomerGraphActions';
import { createM365ConsentCallbackRoutes } from '../../routes/m365ConsentCallback';
import { createOrganization, createPartner, createUser, setupTestEnvironment } from './db-utils';

// --- runtime-config gate: mocked so the route/service layer never needs the
// real M365_CUSTOMER_GRAPH_ACTIONS_* env vars or file-backed signing key. ---
const onboardingState = vi.hoisted(() => ({ enabled: true }));

vi.mock('../../services/m365ControlPlane/writeActionRuntimeConfig', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../services/m365ControlPlane/writeActionRuntimeConfig')
  >();
  return {
    ...actual,
    loadM365CustomerGraphActionsRuntimeConfig: () => FAKE_ACTIONS_CONFIG,
    isM365CustomerGraphActionsOnboardingEnabledForOrg: () => onboardingState.enabled,
  };
});

// The cross-profile fail-closed test exercises the READ service directly
// (initiateCustomerGraphReadConsent), which needs its own runtime config —
// mirrors the mock in m365ConnectionLifecycle.integration.test.ts.
vi.mock('../../services/m365ControlPlane/runtimeConfig', () => ({
  loadM365CustomerGraphReadRuntimeConfig: () => ({
    clientId: '55555555-5555-4555-8555-555555555555',
    vaultRef: 'akv://vault.example/m365-customer-graph-read/0123456789abcdef0123456789abcdef',
    credentialVersion: '0123456789abcdef0123456789abcdef',
    callbackUrl: 'https://console.example.test/api/v1/m365/consent/callback',
    executorUrl: 'https://executor.internal.example.test',
    executorAudience: 'm365-graph-read-executor',
    executorSigningPrivateJwk: {},
    executorSigningKid: 'key-1',
    onboardingOrgIds: '*',
  }),
}));

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

const PROFILE_MANIFEST = M365_PERMISSION_PROFILES['customer-graph-actions'];
const REQUIRED_GRANTS: CanonicalAppRoleAssignment[] = [...PROFILE_MANIFEST.applicationPermissionAssignments];
const GRANT_USER_RW = REQUIRED_GRANTS[0]!;
const GRANT_PASSWORD_RW = REQUIRED_GRANTS[1]!;
const EXTRA_GRANT: CanonicalAppRoleAssignment = {
  resourceApplicationId: '00000003-0000-0000-c000-000000000000',
  appRoleId: '99999999-1111-4222-8333-444444444444',
  value: 'Group.ReadWrite.All',
};

const runDb = it.runIf(!!process.env.DATABASE_URL);

beforeEach(() => {
  onboardingState.enabled = true;
});

// --- fixtures ---------------------------------------------------------

async function ownerFixture() {
  return withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const user = await createUser({
      partnerId: partner.id,
      orgId: org.id,
      email: `m365-actions-lifecycle-${Date.now()}-${randomUUID()}@example.com`,
    });
    return { orgId: org.id, actorId: user.id };
  });
}

async function currentActionsConnection(orgId: string) {
  return withSystemDbAccessContext(async () => {
    const rows = await db.select().from(m365Connections).where(and(
      eq(m365Connections.orgId, orgId),
      eq(m365Connections.profile, 'customer-graph-actions'),
    ));
    return rows[0];
  });
}

async function mintMfaToken(env: Awaited<ReturnType<typeof setupTestEnvironment>>) {
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
    sid: `it-actions-${randomUUID()}`,
  });
}

/** Builds the real actions route + real actions callback route on one app,
 * with a stubbed executor client injected via `createExecutorClient`: phase 1
 * verifies the administrator as `tenantId`, phase 2's retest returns `retest`. */
function buildApp(tenantId: string, retest: () => Promise<RetestResult>) {
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
    createExecutorClient: () => ({ verifyConsentIdentity, retest }),
    connectionService: actionsConnectionService,
  }));
  return app;
}

function completeConsentResult(input: {
  tenantId: string;
  observedGrants: CanonicalAppRoleAssignment[];
}): RetestResult {
  const requiredKeys = new Set(REQUIRED_GRANTS.map(canonicalGrantKey));
  const observedKeys = new Set(input.observedGrants.map(canonicalGrantKey));
  return {
    success: true,
    tenantId: input.tenantId,
    applicationId: FAKE_ACTIONS_CONFIG.clientId,
    organizationDisplayName: 'Contoso Actions',
    manifestVersion: PROFILE_MANIFEST.version,
    verifiedAt: new Date().toISOString(),
    grantReconciliation: 'complete',
    observedGrants: input.observedGrants,
    missingGrants: REQUIRED_GRANTS.filter((grant) => !observedKeys.has(canonicalGrantKey(grant))),
    unexpectedGrants: input.observedGrants.filter((grant) => !requiredKeys.has(canonicalGrantKey(grant))),
    grantsVerifiedAt: new Date().toISOString(),
  };
}

function cookiePair(setCookieHeader: string | null): string {
  if (!setCookieHeader) throw new Error('expected a Set-Cookie response header');
  return setCookieHeader.split(';')[0]!;
}

/** The callback route redirects to a relative `/integrations#...` Location. */
function redirectHash(location: string | null): string {
  if (!location) throw new Error('expected a Location response header');
  return new URL(location, 'http://localhost.invalid').hash;
}

/** Drives initiate → identity callback, returning the consent-phase state +
 * cookie needed to complete the flow. */
async function driveToConsentPhase(
  app: Hono,
  token: string,
  orgId: string,
  tenantId: string,
) {
  const initiateRes = await app.request(
    `/api/v1/m365/customer-graph-actions/connections/consent?orgId=${orgId}`,
    { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
  );
  expect(initiateRes.status).toBe(200);
  const { adminConsentUrl } = await initiateRes.json() as { adminConsentUrl: string };
  const identityUrl = new URL(adminConsentUrl);
  // Identity first: a first connect signs in at /organizations.
  expect(identityUrl.origin + identityUrl.pathname).toBe(
    'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize',
  );
  const identityState = identityUrl.searchParams.get('state')!;
  const identityCookie = cookiePair(initiateRes.headers.get('set-cookie'));

  const identityCallbackRes = await app.request(
    `/api/v1/m365/actions-consent/callback?state=${encodeURIComponent(identityState)}&code=fake-identity-code`,
    { headers: { cookie: identityCookie } },
  );
  expect(identityCallbackRes.status).toBe(302);
  // W03: an /organizations sign-in parks at the confirm-tenant interstitial.
  expect(redirectHash(identityCallbackRes.headers.get('location'))).toBe(
    '#m365/customer-graph-actions/confirm-tenant',
  );

  // The card reads the parked tenant, then the operator confirms it — both
  // through the real routes with the operator's own MFA token.
  const pendingRes = await app.request(
    `/api/v1/m365/customer-graph-actions/connections/consent/pending?orgId=${orgId}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  expect(pendingRes.status).toBe(200);
  expect(await pendingRes.json()).toMatchObject({ tenantId, administratorUsername: null });
  const continueRes = await app.request(
    `/api/v1/m365/customer-graph-actions/connections/consent/continue?orgId=${orgId}`,
    { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
  );
  expect(continueRes.status).toBe(200);
  const consentUrl = new URL((await continueRes.json() as { adminConsentUrl: string }).adminConsentUrl);
  expect(consentUrl.origin + consentUrl.pathname).toBe(
    `https://login.microsoftonline.com/${tenantId}/oauth2/authorize`,
  );
  const consentState = consentUrl.searchParams.get('state')!;
  const consentCookie = cookiePair(continueRes.headers.get('set-cookie'));
  expect(continueRes.headers.get('set-cookie')).toContain('Path=/api/v1/m365/actions-consent/callback');

  return { consentState, consentCookie };
}

async function completeConsentPhase(
  app: Hono,
  consentState: string,
  consentCookie: string,
) {
  return app.request(
    `/api/v1/m365/actions-consent/callback?state=${encodeURIComponent(consentState)}&code=discarded-consent-code`,
    { headers: { cookie: consentCookie } },
  );
}

// --- tests --------------------------------------------------------------

describe('customer Graph-actions consent lifecycle integration', () => {
  runDb('happy path: exact 2 grants observed → connection active, missing/unexpected empty', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const token = await mintMfaToken(env);
    const tenantId = randomUUID();
    const app = buildApp(tenantId, async () => completeConsentResult({
      tenantId,
      observedGrants: [GRANT_USER_RW, GRANT_PASSWORD_RW],
    }));

    const { consentState, consentCookie } = await driveToConsentPhase(
      app, token, env.organization.id, tenantId,
    );
    const finalRes = await completeConsentPhase(app, consentState, consentCookie);
    expect(finalRes.status).toBe(302);
    expect(redirectHash(finalRes.headers.get('location'))).toBe('#m365/customer-graph-actions/active');

    const row = await currentActionsConnection(env.organization.id);
    expect(row).toBeDefined();
    expect(row!.status).toBe('active');
    expect(row!.tenantId).toBe(tenantId);
    const snapshot = row as unknown as M365ConnectionSnapshot<'customer-graph-actions'>;
    const health = deriveGrantHealth(snapshot, PROFILE_MANIFEST);
    expect(health.state).toBe('active');
    expect(new Set(health.observedGrants.map(canonicalGrantKey))).toEqual(
      new Set(REQUIRED_GRANTS.map(canonicalGrantKey)),
    );
    expect(health.missingGrants).toEqual([]);
    expect(health.unexpectedGrants).toEqual([]);
  });

  runDb('missing grant: only 1 of 2 observed → not active, missing = the other', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const token = await mintMfaToken(env);
    const tenantId = randomUUID();
    const app = buildApp(tenantId, async () => completeConsentResult({
      tenantId,
      observedGrants: [GRANT_USER_RW],
    }));

    const { consentState, consentCookie } = await driveToConsentPhase(
      app, token, env.organization.id, tenantId,
    );
    const finalRes = await completeConsentPhase(app, consentState, consentCookie);
    expect(finalRes.status).toBe(302);
    // The callback route redirects on connection status (active/degraded),
    // not the finer-grained lastErrorCode — the drift detail is asserted via
    // deriveGrantHealth below (and separately audited as grant_drift_detected).
    expect(redirectHash(finalRes.headers.get('location'))).toBe('#m365/customer-graph-actions/degraded');

    const row = await currentActionsConnection(env.organization.id);
    expect(row!.status).not.toBe('active');
    expect(row!.status).toBe('degraded');
    expect(row!.lastErrorCode).toBe('grant_missing');
    const health = deriveGrantHealth(
      row as unknown as M365ConnectionSnapshot<'customer-graph-actions'>,
      PROFILE_MANIFEST,
    );
    expect(health.state).toBe('missing');
    expect(health.missingGrants.map(canonicalGrantKey)).toEqual([canonicalGrantKey(GRANT_PASSWORD_RW)]);
    expect(health.unexpectedGrants).toEqual([]);
  });

  runDb('extra grant (drift): a third role observed → unexpected non-empty, not active', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const token = await mintMfaToken(env);
    const tenantId = randomUUID();
    const app = buildApp(tenantId, async () => completeConsentResult({
      tenantId,
      observedGrants: [GRANT_USER_RW, GRANT_PASSWORD_RW, EXTRA_GRANT],
    }));

    const { consentState, consentCookie } = await driveToConsentPhase(
      app, token, env.organization.id, tenantId,
    );
    const finalRes = await completeConsentPhase(app, consentState, consentCookie);
    expect(finalRes.status).toBe(302);
    expect(redirectHash(finalRes.headers.get('location'))).toBe('#m365/customer-graph-actions/degraded');

    const row = await currentActionsConnection(env.organization.id);
    expect(row!.status).not.toBe('active');
    expect(row!.status).toBe('degraded');
    expect(row!.lastErrorCode).toBe('grant_unexpected');
    const health = deriveGrantHealth(
      row as unknown as M365ConnectionSnapshot<'customer-graph-actions'>,
      PROFILE_MANIFEST,
    );
    expect(health.state).toBe('unexpected');
    expect(health.unexpectedGrants.map(canonicalGrantKey)).toEqual([canonicalGrantKey(EXTRA_GRANT)]);
    expect(health.missingGrants).toEqual([]);
  });

  runDb('cross-org fail-closed: an actions consent session for org A cannot be consumed under org B', async () => {
    const ownerA = await ownerFixture();
    const ownerB = await ownerFixture();
    const initiatedA = await initiateCustomerGraphActionsConsent({
      orgId: ownerA.orgId,
      actorId: ownerA.actorId,
    });

    await expect(consumeConsentSession({
      rawState: initiatedA.binding.rawState,
      phase: 'identity_verification',
      connectionId: initiatedA.connection.id,
      orgId: ownerB.orgId,
      consentAttemptId: initiatedA.connection.consentAttemptId,
      profile: 'customer-graph-actions',
    })).resolves.toBeNull();

    // Positive control: the same session is still consumable under its own org.
    await expect(consumeConsentSession({
      rawState: initiatedA.binding.rawState,
      phase: 'identity_verification',
      connectionId: initiatedA.connection.id,
      orgId: ownerA.orgId,
      consentAttemptId: initiatedA.connection.consentAttemptId,
      profile: 'customer-graph-actions',
    })).resolves.toMatchObject({
      connectionId: initiatedA.connection.id,
      consentAttemptId: initiatedA.connection.consentAttemptId,
    });
  });

  runDb('cross-profile fail-closed: a customer-graph-read row cannot satisfy an actions reconciliation', async () => {
    const owner = await ownerFixture();
    const readInitiated = await initiateCustomerGraphReadConsent({
      orgId: owner.orgId,
      actorId: owner.actorId,
    });
    // Simulate the read connection mid-identity-verification so the status
    // predicate matches and only the profile mismatch can fail the CAS.
    await withSystemDbAccessContext(() => db.update(m365Connections).set({
      status: 'verifying',
    }).where(eq(m365Connections.id, readInitiated.connection.id)));

    const tenantId = randomUUID();
    await expect(actionsConnectionService.applyConsentFinalizationResult({
      id: readInitiated.connection.id,
      orgId: owner.orgId,
      profile: 'customer-graph-actions',
      consentAttemptId: readInitiated.connection.consentAttemptId,
      status: 'verifying',
    }, {
      verifiedTenantId: tenantId,
      result: completeConsentResult({ tenantId, observedGrants: [GRANT_USER_RW, GRANT_PASSWORD_RW] }),
    })).rejects.toMatchObject({ code: 'stale_attempt' });

    const readRow = await withSystemDbAccessContext(() => db.select().from(m365Connections)
      .where(eq(m365Connections.id, readInitiated.connection.id)));
    expect(readRow[0]?.profile).toBe('customer-graph-read');
    expect(readRow[0]?.status).toBe('verifying');
    expect(readRow[0]?.tenantId).toBeNull();
  });

  runDb('cross-profile fail-closed: an actions consent session cannot be consumed with profile customer-graph-read', async () => {
    const owner = await ownerFixture();
    const actionsInitiated = await initiateCustomerGraphActionsConsent({
      orgId: owner.orgId,
      actorId: owner.actorId,
    });

    await expect(consumeConsentSession({
      rawState: actionsInitiated.binding.rawState,
      phase: 'identity_verification',
      connectionId: actionsInitiated.connection.id,
      orgId: owner.orgId,
      consentAttemptId: actionsInitiated.connection.consentAttemptId,
      profile: 'customer-graph-read',
    })).resolves.toBeNull();

    // Positive control: consuming with the correct profile still works.
    await expect(consumeConsentSession({
      rawState: actionsInitiated.binding.rawState,
      phase: 'identity_verification',
      connectionId: actionsInitiated.connection.id,
      orgId: owner.orgId,
      consentAttemptId: actionsInitiated.connection.consentAttemptId,
      profile: 'customer-graph-actions',
    })).resolves.toMatchObject({
      connectionId: actionsInitiated.connection.id,
      consentAttemptId: actionsInitiated.connection.consentAttemptId,
    });
  });

  runDb('dark-flag off: consent route returns unavailable and creates no session/connection row', async () => {
    onboardingState.enabled = false;
    const env = await setupTestEnvironment({ scope: 'organization' });
    const token = await mintMfaToken(env);
    const app = buildApp(randomUUID(), async () => {
      throw new Error('executor must not be called when onboarding is disabled');
    });

    const res = await app.request(
      `/api/v1/m365/customer-graph-actions/connections/consent?orgId=${env.organization.id}`,
      { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Customer Graph Actions onboarding is not enabled' });

    const connectionRows = await withSystemDbAccessContext(() => db.select().from(m365Connections)
      .where(eq(m365Connections.orgId, env.organization.id)));
    expect(connectionRows).toEqual([]);
    const sessionRows = await withSystemDbAccessContext(() => db.select().from(m365ConsentSessions)
      .where(eq(m365ConsentSessions.orgId, env.organization.id)));
    expect(sessionRows).toEqual([]);
  });
});
