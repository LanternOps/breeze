/**
 * Integration test — the M365 write ladder across the customer-graph-actions
 * v3 bump (real PG, Operator Recipe Library M1 #6170, spec §7.2).
 *
 * The promise under test: a connection consented to the pre-M1 manifest keeps
 * executing disable / reset_password after the bump, and an M1-only action
 * refuses with its OWN code (`consent_upgrade_required`), never
 * `connection_not_ready`, until the customer approves the upgrade.
 *
 * The pre-M1 row is NOT hand-seeded into its post-bump state: it is seeded as
 * it was before the bump and then put through a real Retest (route → service
 * → CAS), because that is the state an operator's Retest actually produces
 * after the bump (#8745). The upgrade then runs through the real actions
 * upgrade-consent route and consent callback. Only the executor client, the
 * feature flag and the Redis budget are stubbed.
 *
 * Run:
 *   cd apps/api && npx vitest run --config vitest.integration.config.ts m365ConsentUpgradeLadder
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import {
  canonicalGrantKey,
  connectionNeedsConsentReconciliation,
  M365_PERMISSION_PROFILES,
  M365_WRITE_ACTION_REQUIRED_ROLES,
  type CanonicalAppRoleAssignment,
  type M365WriteAction,
  type RetestResult,
  type VerifyConsentIdentityResult,
  type WriteActionResult,
} from '@breeze/shared/m365';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { m365Connections, m365ConsentSessions } from '../../db/schema';
import { createAccessToken } from '../../services/jwt';
import { m365RoleReadiness } from '../../services/m365ControlPlane/connectionService';
import {
  actionsConnectionService,
  initiateCustomerGraphActionsConsent,
} from '../../services/m365ControlPlane/writeActionConnectionService';
import { executeM365WriteActionByOrg } from '../../services/m365ControlPlane/writeActionService';
import { m365CustomerGraphActionsRoutes } from '../../routes/m365CustomerGraphActions';
import { createM365ConsentCallbackRoutes } from '../../routes/m365ConsentCallback';
import { setupTestEnvironment } from './db-utils';

const executorStub = vi.hoisted(() => ({
  retest: null as null | (() => Promise<RetestResult>),
  executeWriteAction: vi.fn(),
}));

vi.mock('../../services/m365ControlPlane/writeActionRuntimeConfig', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../services/m365ControlPlane/writeActionRuntimeConfig')
  >();
  return {
    ...actual,
    loadM365CustomerGraphActionsRuntimeConfig: () => FAKE_ACTIONS_CONFIG,
    isM365CustomerGraphActionsOnboardingEnabledForOrg: () => true,
    isM365GraphActionsEnabledForOrg: () => true,
  };
});

// The ladder under test is the database half; the per-connection Redis
// budget is unit-tested on its own (writeActionBudget.test.ts).
vi.mock('../../services/m365ControlPlane/writeActionBudget', () => ({
  consumeM365WriteActionBudget: async () => ({ allowed: true }),
}));

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
      executeWriteAction: (...args: unknown[]) => executorStub.executeWriteAction(...args),
    }),
  };
});

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
/** The manifest every connection consented before this wave holds. */
const PRE_M1 = 2;
const PRE_M1_ROLES = new Set(['User.ReadWrite.All', 'User-PasswordProfile.ReadWrite.All']);

function canonical(grants: readonly CanonicalAppRoleAssignment[]): CanonicalAppRoleAssignment[] {
  return [...grants].sort((left, right) => canonicalGrantKey(left).localeCompare(canonicalGrantKey(right)));
}

const REQUIRED = canonical(MANIFEST.applicationPermissionAssignments ?? []);
const PRE_M1_GRANTS = REQUIRED.filter((grant) => PRE_M1_ROLES.has(grant.value ?? ''));

const GROUP = '55555555-5555-4555-8555-555555555555';
const DEVICE = '44444444-4444-4444-8444-444444444444';
const SKU = '33333333-3333-4333-8333-333333333333';

const ALL_ACTIONS: M365WriteAction[] = [
  { type: 'm365.user.disable', userIdentifier: 'a@contoso.test', reason: 'offboard' },
  { type: 'm365.user.reset_password', userIdentifier: 'a@contoso.test', reason: 'offboard' },
  { type: 'm365.user.revoke_sessions', userIdentifier: 'a@contoso.test', reason: 'offboard' },
  { type: 'm365.user.license.remove', userIdentifier: 'a@contoso.test', skuIds: [SKU], reason: 'offboard' },
  { type: 'm365.user.license.assign', userIdentifier: 'a@contoso.test', skuIds: [SKU], reason: 'onboard' },
  { type: 'm365.group.membership.remove', groupId: GROUP, userIdentifier: 'a@contoso.test', reason: 'offboard' },
  { type: 'm365.group.membership.add', groupId: GROUP, userIdentifier: 'a@contoso.test', reason: 'onboard' },
  { type: 'm365.intune.device.retire', managedDeviceId: DEVICE, reason: 'offboard' },
  {
    type: 'm365.user.create', userPrincipalName: 'new@contoso.test', displayName: 'New Starter',
    mailNickname: 'new', usageLocation: 'US', reason: 'onboard',
  },
  { type: 'm365.user.mailbox.auto_reply', userIdentifier: 'a@contoso.test', status: 'alwaysEnabled', reason: 'offboard' },
  { type: 'm365.user.mailbox.auto_reply.state', userIdentifier: 'a@contoso.test' },
];
/**
 * Readiness is per role, not per manifest: an M1 action whose roles the
 * pre-M1 grant set already covers (licence removal and user creation need
 * only User.ReadWrite.All) executes; every other one needs the upgrade.
 */
const coveredByPreM1 = (a: M365WriteAction) => M365_WRITE_ACTION_REQUIRED_ROLES[a.type].every((role) => PRE_M1_ROLES.has(role));
const NEEDS_UPGRADE = ALL_ACTIONS.filter((a) => !coveredByPreM1(a));
const RUNS_ON_PRE_M1 = ALL_ACTIONS.filter(coveredByPreM1);

const runDb = it.runIf(!!process.env.DATABASE_URL);

beforeEach(() => {
  executorStub.retest = null;
  executorStub.executeWriteAction.mockReset();
  // Executor reached: answer a deterministic failure the ladder passes
  // through verbatim, so "reached the executor" is visible in the result too.
  executorStub.executeWriteAction.mockImplementation(async (): Promise<WriteActionResult> => (
    { success: false, errorCode: 'graph_throttled', retryAfterSeconds: 7 }
  ));
});

// --- fixtures ---------------------------------------------------------

type Env = Awaited<ReturnType<typeof setupTestEnvironment>>;

function orgContext(env: Env): DbAccessContext {
  return {
    scope: 'organization',
    orgId: env.organization.id,
    accessibleOrgIds: [env.organization.id],
    accessiblePartnerIds: [],
    userId: env.user.id,
    currentPartnerId: env.partner.id,
  } as DbAccessContext;
}

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
    sid: `it-actions-ladder-${randomUUID()}`,
  });
}

/** A bound, active actions row as a consent finalization leaves it. */
async function seedActiveRow(
  env: Env,
  tenantId: string,
  manifestVersion: number,
  grants: CanonicalAppRoleAssignment[],
  grantsVerifiedAt: Date | null,
) {
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
    observedGrants: grants,
    grantsVerifiedAt,
    lastVerifiedAt: verifiedAt,
    consentedAt: verifiedAt,
    status: 'active',
    lastErrorCode: null,
  }).where(eq(m365Connections.id, initiated.connection.id)));
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

function retestResult(tenantId: string, observed: CanonicalAppRoleAssignment[]): RetestResult {
  const requiredKeys = new Set(REQUIRED.map(canonicalGrantKey));
  const observedKeys = new Set(observed.map(canonicalGrantKey));
  return {
    success: true,
    tenantId,
    applicationId: FAKE_ACTIONS_CONFIG.clientId,
    organizationDisplayName: 'Contoso Actions',
    manifestVersion: CURRENT,
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

function cookiePair(setCookieHeader: string | null): string {
  if (!setCookieHeader) throw new Error('expected a Set-Cookie response header');
  return setCookieHeader.split(';')[0]!;
}

async function runAs(env: Env, action: M365WriteAction) {
  return withDbAccessContext(orgContext(env), () => executeM365WriteActionByOrg(env.organization.id, action));
}

// --- tests ------------------------------------------------------------

describe('M365 write ladder across the actions v3 bump (real DB)', () => {
  runDb('a pre-M1 connection keeps disable/reset after a real Retest, refuses M1 actions with consent_upgrade_required, and executes them after the upgrade', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const token = await mintMfaToken(env);
    const tenantId = randomUUID();
    const connectionId = await seedActiveRow(env, tenantId, PRE_M1, PRE_M1_GRANTS, new Date('2026-10-01T12:00:00.000Z'));
    const app = buildApp(tenantId);
    expect(connectionNeedsConsentReconciliation('customer-graph-actions', PRE_M1)).toBe(true);

    // The operator presses Retest after the deploy; the tenant still holds only the pre-M1 grants.
    executorStub.retest = async () => retestResult(tenantId, PRE_M1_GRANTS);
    const retestRes = await app.request(
      `/api/v1/m365/customer-graph-actions/connections/${connectionId}/retest?orgId=${env.organization.id}`,
      { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
    );
    expect(retestRes.status).toBe(200);
    const afterRetest = await actionsRow(env.organization.id);
    expect(afterRetest).toMatchObject({ status: 'active', permissionManifestVersion: PRE_M1, lastErrorCode: 'manifest_stale' });
    expect(afterRetest.grantsVerifiedAt).not.toBeNull();

    // Pre-M1 actions keep working — the executor is reached.
    for (const type of ['m365.user.disable', 'm365.user.reset_password'] as const) {
      executorStub.executeWriteAction.mockClear();
      const result = await runAs(env, { type, userIdentifier: 'a@contoso.test', reason: 'offboard' });
      expect(executorStub.executeWriteAction).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ ok: false, code: 'graph_throttled' }); // the stub's verbatim answer
    }

    // The pin: disable, reset, licence removal and user creation are exactly what a pre-M1 grant set covers.
    expect(RUNS_ON_PRE_M1.map((a) => a.type)).toEqual([
      'm365.user.disable', 'm365.user.reset_password', 'm365.user.license.remove', 'm365.user.create',
    ]);
    executorStub.executeWriteAction.mockClear();
    await runAs(env, RUNS_ON_PRE_M1[2]!);
    expect(executorStub.executeWriteAction).toHaveBeenCalledTimes(1);

    // Every action needing a new role refuses with its own code, and never reaches Graph.
    expect(NEEDS_UPGRADE).toHaveLength(7);
    for (const action of NEEDS_UPGRADE) {
      executorStub.executeWriteAction.mockClear();
      const result = await runAs(env, action);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.code, action.type).toBe('consent_upgrade_required');
      expect(executorStub.executeWriteAction).not.toHaveBeenCalled();
    }

    // Per-role readiness on the real row.
    const readiness = m365RoleReadiness(afterRetest, MANIFEST);
    expect(readiness).toMatchObject({
      'User.ReadWrite.All': true,
      'User-PasswordProfile.ReadWrite.All': true,
      'User.RevokeSessions.All': false,
      'GroupMember.ReadWrite.All': false,
      'DeviceManagementManagedDevices.PrivilegedOperations.All': false,
      'MailboxSettings.ReadWrite': false,
      'Organization.Read.All': false,
    });

    // The customer approves the upgrade through the existing identity-first flow.
    const upgradeRes = await app.request(
      `/api/v1/m365/customer-graph-actions/connections/${connectionId}/upgrade-consent?orgId=${env.organization.id}`,
      { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
    );
    expect(upgradeRes.status).toBe(200);
    const { adminConsentUrl } = await upgradeRes.json() as { adminConsentUrl: string };
    const identityUrl = new URL(adminConsentUrl);
    const step1 = await app.request(
      `/api/v1/m365/actions-consent/callback?state=${encodeURIComponent(identityUrl.searchParams.get('state')!)}&code=fake-identity-code`,
      { headers: { cookie: cookiePair(upgradeRes.headers.get('set-cookie')) } },
    );
    expect(step1.status).toBe(302);
    const consentUrl = new URL(step1.headers.get('location')!);
    executorStub.retest = async () => retestResult(tenantId, REQUIRED);
    const step2 = await app.request(
      `/api/v1/m365/actions-consent/callback?state=${encodeURIComponent(consentUrl.searchParams.get('state')!)}&code=discarded-consent-code`,
      { headers: { cookie: cookiePair(step1.headers.get('set-cookie')) } },
    );
    expect(step2.status).toBe(302);
    expect(await actionsRow(env.organization.id)).toMatchObject({
      status: 'active', permissionManifestVersion: CURRENT, lastErrorCode: null,
    });

    // …and now every action reaches the executor.
    for (const action of ALL_ACTIONS) {
      executorStub.executeWriteAction.mockClear();
      await runAs(env, action);
      expect(executorStub.executeWriteAction).toHaveBeenCalledTimes(1);
    }
  });

  runDb('a v3 connection holding every grant reaches the executor for all ten actions and the probe arm', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    await seedActiveRow(env, randomUUID(), CURRENT, REQUIRED, new Date());
    for (const action of ALL_ACTIONS) {
      executorStub.executeWriteAction.mockClear();
      const result = await runAs(env, action);
      expect(executorStub.executeWriteAction).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ ok: false, code: 'graph_throttled' });
    }
  });

  runDb('no authoritative grant observation is not a refusal (plan Decision 5)', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    await seedActiveRow(env, randomUUID(), PRE_M1, [], null);
    for (const action of ALL_ACTIONS) {
      executorStub.executeWriteAction.mockClear();
      await runAs(env, action);
      expect(executorStub.executeWriteAction).toHaveBeenCalledTimes(1);
    }
  });

  runDb('RLS still holds through the new path: another org cannot see or act on the connection', async () => {
    const owner = await setupTestEnvironment({ scope: 'organization' });
    const other = await setupTestEnvironment({ scope: 'organization' });
    await seedActiveRow(owner, randomUUID(), CURRENT, REQUIRED, new Date());

    const visible = await withDbAccessContext(orgContext(other), () => db.select().from(m365Connections)
      .where(eq(m365Connections.orgId, owner.organization.id)));
    expect(visible).toHaveLength(0);

    // The owner's org id under the OTHER org's context: the connection load
    // returns nothing, so the ladder refuses before the executor.
    const result = await withDbAccessContext(orgContext(other), () => executeM365WriteActionByOrg(
      owner.organization.id,
      { type: 'm365.group.membership.remove', groupId: GROUP, userIdentifier: 'a@contoso.test', reason: 'x' },
    ));
    expect(result).toMatchObject({ ok: false, code: 'connection_not_ready' });
    expect(executorStub.executeWriteAction).not.toHaveBeenCalled();
  });
});
