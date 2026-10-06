/**
 * Integration — identity-first admin consent (#7910 W02), both certificate
 * profiles × initial / reconnect / upgrade, against real Postgres.
 *
 * Drives the REAL connection service, consent-session service, browser
 * binding (real HMAC cookies) and callback router; only the profile executor
 * (verify-identity + retest) is a stub.
 */
import './setup';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import {
  canonicalGrantKey,
  M365_PERMISSION_PROFILES,
  type RetestResult,
  type VerifyConsentIdentityResult,
} from '@breeze/shared/m365';
import { db, withSystemDbAccessContext } from '../../db';
import { m365Connections, m365ConsentSessions, organizations } from '../../db/schema';
import {
  buildM365ActionsConsentBindingCookie,
  buildM365ConsentBindingCookie,
  type M365ConsentBrowserBinding,
} from '../../services/m365ControlPlane/browserBinding';
import {
  cancelCustomerGraphReadTenantConfirmation,
  continueCustomerGraphReadConsent,
  initiateCustomerGraphReadConsent,
  initiateCustomerGraphReadUpgradeConsent,
  readPendingCustomerGraphReadTenantConfirmation,
} from '../../services/m365ControlPlane/connectionService';
import {
  consumeConsentSession,
  readConsentSessionPurpose,
} from '../../services/m365ControlPlane/consentSessionService';
import {
  actionsConnectionService,
  cancelCustomerGraphActionsTenantConfirmation,
  continueCustomerGraphActionsConsent,
  initiateCustomerGraphActionsConsent,
  readPendingCustomerGraphActionsTenantConfirmation,
} from '../../services/m365ControlPlane/writeActionConnectionService';
import { createM365ConsentCallbackRoutes } from '../../routes/m365ConsentCallback';
import { createOrganization, createPartner, createUser } from './db-utils';

type Profile = 'customer-graph-read' | 'customer-graph-actions';

const CONFIG = vi.hoisted(() => {
  const common = {
    vaultRef: 'akv://vault.example/m365/0123456789abcdef0123456789abcdef',
    credentialVersion: '0123456789abcdef0123456789abcdef',
    executorUrl: 'https://executor.internal.example.test',
    executorSigningPrivateJwk: {},
    executorSigningKid: 'key-1',
    onboardingOrgIds: '*',
  };
  return {
    'customer-graph-read': {
      ...common,
      clientId: '55555555-5555-4555-8555-555555555555',
      callbackUrl: 'https://console.example.test/api/v1/m365/consent/callback',
      executorAudience: 'm365-graph-read-executor',
    },
    'customer-graph-actions': {
      ...common,
      clientId: '66666666-6666-4666-8666-666666666666',
      callbackUrl: 'https://console.example.test/api/v1/m365/actions-consent/callback',
      executorAudience: 'm365-graph-actions-executor',
    },
  } as const;
});

vi.mock('../../services/m365ControlPlane/runtimeConfig', () => ({
  loadM365CustomerGraphReadRuntimeConfig: () => CONFIG['customer-graph-read'],
  isM365CustomerGraphReadOnboardingEnabledForOrg: () => true,
}));
vi.mock('../../services/m365ControlPlane/writeActionRuntimeConfig', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/m365ControlPlane/writeActionRuntimeConfig')>()),
  loadM365CustomerGraphActionsRuntimeConfig: () => CONFIG['customer-graph-actions'],
  isM365CustomerGraphActionsOnboardingEnabledForOrg: () => true,
}));

const runDb = it.runIf(!!process.env.DATABASE_URL);
const ADMIN = '77777777-7777-4777-8777-777777777777';
const ORIGINAL_KEY = process.env.APP_ENCRYPTION_KEY;

const executor = {
  verifyConsentIdentity: vi.fn<(input: unknown) => Promise<VerifyConsentIdentityResult>>(),
  retest: vi.fn<(input: unknown) => Promise<RetestResult>>(),
};

beforeAll(() => { process.env.APP_ENCRYPTION_KEY = 'identity-first-integration-key'; });
afterAll(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.APP_ENCRYPTION_KEY;
  else process.env.APP_ENCRYPTION_KEY = ORIGINAL_KEY;
});
beforeEach(() => {
  executor.verifyConsentIdentity.mockReset();
  executor.retest.mockReset();
});

const CALLBACK_PATH: Record<Profile, string> = {
  'customer-graph-read': '/api/v1/m365/consent/callback',
  'customer-graph-actions': '/api/v1/m365/actions-consent/callback',
};

const apps: Record<Profile, Hono> = {
  'customer-graph-read': new Hono().route('/api/v1/m365', createM365ConsentCallbackRoutes({
    profile: 'customer-graph-read',
    loadRuntimeConfig: () => CONFIG['customer-graph-read'],
    createExecutorClient: () => executor,
  })),
  'customer-graph-actions': new Hono().route('/api/v1/m365', createM365ConsentCallbackRoutes({
    profile: 'customer-graph-actions',
    loadRuntimeConfig: () => CONFIG['customer-graph-actions'],
    createExecutorClient: () => executor,
    connectionService: actionsConnectionService,
  })),
};

function sortedGrants(profile: Profile) {
  return [...(M365_PERMISSION_PROFILES[profile].applicationPermissionAssignments ?? [])]
    .sort((left, right) => canonicalGrantKey(left).localeCompare(canonicalGrantKey(right)));
}

function identityOk(tenantId: string): VerifyConsentIdentityResult {
  return { success: true, tenantId, administratorObjectId: ADMIN, administratorUsername: 'admin@tenant.example', verifiedAt: new Date().toISOString() };
}

function retestOk(tenantId: string, profile: Profile): RetestResult {
  return {
    success: true,
    tenantId,
    applicationId: CONFIG[profile].clientId,
    organizationDisplayName: 'Contoso',
    manifestVersion: M365_PERMISSION_PROFILES[profile].version,
    verifiedAt: new Date().toISOString(),
    grantReconciliation: 'complete',
    observedGrants: sortedGrants(profile),
    missingGrants: [],
    unexpectedGrants: [],
    grantsVerifiedAt: new Date().toISOString(),
  };
}

async function ownerFixture() {
  return withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const user = await createUser({
      partnerId: partner.id,
      orgId: org.id,
      email: `m365-identity-first-${randomUUID()}@example.com`,
    });
    return { orgId: org.id, actorId: user.id };
  });
}

function authFor(owner: { orgId: string; actorId: string }) {
  return {
    scope: 'organization', orgId: owner.orgId, accessibleOrgIds: [owner.orgId], partnerId: null, user: { id: owner.actorId },
  } as never;
}

function cookieFor(profile: Profile, binding: M365ConsentBrowserBinding): string {
  const header = profile === 'customer-graph-actions'
    ? buildM365ActionsConsentBindingCookie(binding)
    : buildM365ConsentBindingCookie(binding);
  return header.slice(0, header.indexOf(';'));
}

async function initiate(profile: Profile, owner: { orgId: string; actorId: string }) {
  const initiated = profile === 'customer-graph-actions'
    ? await initiateCustomerGraphActionsConsent(owner)
    : await initiateCustomerGraphReadConsent(owner);
  return { cookie: cookieFor(profile, initiated.binding), url: initiated.authorizationUrl, connectionId: initiated.connection.id };
}

function stateOf(url: string): string {
  return new URL(url).searchParams.get('state')!;
}

async function callback(profile: Profile, cookie: string, params: Record<string, string>) {
  const res = await apps[profile].request(`${CALLBACK_PATH[profile]}?${new URLSearchParams(params)}`, { headers: { cookie } });
  const setCookie = res.headers.get('set-cookie');
  return {
    status: res.status,
    location: res.headers.get('location') ?? '',
    cookie: setCookie ? setCookie.slice(0, setCookie.indexOf(';')) : '',
  };
}

async function connectionRow(orgId: string, profile: Profile) {
  return withSystemDbAccessContext(async () => (await db.select().from(m365Connections).where(and(
    eq(m365Connections.orgId, orgId),
    eq(m365Connections.profile, profile),
  )))[0]);
}

async function sessionRows(orgId: string, profile: Profile) {
  return withSystemDbAccessContext(() => db.select().from(m365ConsentSessions).where(and(
    eq(m365ConsentSessions.orgId, orgId),
    eq(m365ConsentSessions.profile, profile),
  )));
}

async function seedBound(orgId: string, profile: Profile, tenantId: string, status: 'active' | 'degraded', manifestVersion?: number) {
  await withSystemDbAccessContext(() => db.update(m365Connections).set({
    tenantId,
    status,
    displayName: 'Contoso',
    permissionManifestVersion: manifestVersion ?? M365_PERMISSION_PROFILES[profile].version,
    observedGrants: sortedGrants(profile),
    grantsVerifiedAt: new Date(),
    lastVerifiedAt: new Date(),
    consentedAt: new Date(),
    lastErrorCode: null,
  }).where(and(eq(m365Connections.orgId, orgId), eq(m365Connections.profile, profile))));
}

const confirmation = {
  pending: (profile: Profile, input: { orgId: string; actorId: string }) => (profile === 'customer-graph-actions'
    ? readPendingCustomerGraphActionsTenantConfirmation(input)
    : readPendingCustomerGraphReadTenantConfirmation(input)),
  continue: (profile: Profile, input: { orgId: string; actorId: string }) => (profile === 'customer-graph-actions'
    ? continueCustomerGraphActionsConsent(input)
    : continueCustomerGraphReadConsent(input)),
  cancel: (profile: Profile, input: { orgId: string; actorId: string }) => (profile === 'customer-graph-actions'
    ? cancelCustomerGraphActionsTenantConfirmation(input)
    : cancelCustomerGraphReadTenantConfirmation(input)),
};

/**
 * W03: an /organizations sign-in parks at confirm-tenant; the operator's
 * confirm (the real service the route calls) mints the consent cookie + URL.
 * A pinned sign-in already redirected to Microsoft and is returned unchanged.
 */
async function throughConfirm(
  profile: Profile,
  owner: { orgId: string; actorId: string },
  step1: { location: string; cookie: string },
): Promise<{ location: string; cookie: string }> {
  if (!step1.location.endsWith('/confirm-tenant')) return step1;
  const continued = await confirmation.continue(profile, owner);
  return { location: continued.consentUrl, cookie: cookieFor(profile, continued.binding) };
}

/** initiate → identity → [confirm] → consent → finalize for `tenantId`; returns the final callback. */
async function runToFinalize(profile: Profile, owner: { orgId: string; actorId: string }, tenantId: string) {
  const { cookie, url } = await initiate(profile, owner);
  executor.verifyConsentIdentity.mockResolvedValue(identityOk(tenantId));
  const step1 = await throughConfirm(profile, owner, await callback(profile, cookie, { state: stateOf(url), code: 'id-code' }));
  executor.retest.mockResolvedValue(retestOk(tenantId, profile));
  return callback(profile, step1.cookie, { state: stateOf(step1.location), code: 'discarded' });
}

describe.each(['customer-graph-read', 'customer-graph-actions'] as const)('%s identity-first (real DB)', (profile) => {
  runDb('initial: identity → consent → finalize binds the verified tenant exactly once', async () => {
    const owner = await ownerFixture();
    const TENANT_A = randomUUID();
    const { cookie, url } = await initiate(profile, owner);
    expect(new URL(url).pathname).toBe('/organizations/oauth2/v2.0/authorize');
    expect(await connectionRow(owner.orgId, profile)).toMatchObject({ status: 'pending-consent', tenantId: null });
    expect(await sessionRows(owner.orgId, profile)).toEqual([expect.objectContaining({
      phase: 'identity_verification', flowVersion: 2, tenantHintHash: null,
    })]);

    executor.verifyConsentIdentity.mockResolvedValue(identityOk(TENANT_A));
    const parked = await callback(profile, cookie, { state: stateOf(url), code: 'id-code', session_state: 'ss' });
    // W03: an /organizations sign-in parks at confirm-tenant; no consent URL yet.
    expect(parked.location).toBe(`/integrations#m365/${profile}/confirm-tenant`);
    expect(await sessionRows(owner.orgId, profile)).toEqual([expect.objectContaining({
      phase: 'tenant_confirmation', flowVersion: 2, verifiedTenantId: TENANT_A, userId: owner.actorId,
    })]);
    expect(await confirmation.pending(profile, owner)).toMatchObject({
      tenantId: TENANT_A, administratorUsername: 'admin@tenant.example',
    });
    const step1 = await throughConfirm(profile, owner, parked);
    const consentUrl = new URL(step1.location);
    expect(consentUrl.origin + consentUrl.pathname).toBe(`https://login.microsoftonline.com/${TENANT_A}/oauth2/authorize`);
    expect(consentUrl.searchParams.get('prompt')).toBe('admin_consent');
    expect(consentUrl.searchParams.get('client_id')).toBe(CONFIG[profile].clientId);
    expect(executor.verifyConsentIdentity).toHaveBeenCalledWith(expect.objectContaining({
      expectedTenantId: null, authorizationCode: 'id-code', redirectUri: CONFIG[profile].callbackUrl,
    }));
    expect(await connectionRow(owner.orgId, profile)).toMatchObject({ status: 'pending-consent', tenantId: null });
    expect(await sessionRows(owner.orgId, profile)).toEqual([expect.objectContaining({
      phase: 'admin_consent', flowVersion: 2, verifiedTenantId: TENANT_A, verifiedAdminObjectId: ADMIN,
      codeVerifier: null, nonce: null, tenantHintHash: null,
    })]);

    executor.retest.mockResolvedValue(retestOk(TENANT_A, profile));
    const step2 = await callback(profile, step1.cookie, { state: consentUrl.searchParams.get('state')!, code: 'DISCARDED-CONSENT-CODE' });
    expect(step2.location).toMatch(/\/active$/);
    expect(await connectionRow(owner.orgId, profile)).toMatchObject({ status: 'active', tenantId: TENANT_A });
    expect(await sessionRows(owner.orgId, profile)).toEqual([]);
    expect(executor.retest).toHaveBeenCalledTimes(1);
    expect(executor.retest).toHaveBeenCalledWith({ correlationId: expect.any(String), tenantId: TENANT_A });
    expect(JSON.stringify(executor.retest.mock.calls)).not.toContain('DISCARDED-CONSENT-CODE');
  });

  runDb('replaying either phase after success changes nothing and calls no executor', async () => {
    const owner = await ownerFixture();
    const TENANT_A = randomUUID();
    const { cookie, url } = await initiate(profile, owner);
    executor.verifyConsentIdentity.mockResolvedValue(identityOk(TENANT_A));
    const step1 = await throughConfirm(profile, owner, await callback(profile, cookie, { state: stateOf(url), code: 'id-code' }));
    executor.retest.mockResolvedValue(retestOk(TENANT_A, profile));
    const step2 = await callback(profile, step1.cookie, { state: stateOf(step1.location), code: 'c' });
    expect(step2.location).toMatch(/\/active$/);
    const before = await connectionRow(owner.orgId, profile);

    const replay1 = await callback(profile, cookie, { state: stateOf(url), code: 'id-code' });
    const replay2 = await callback(profile, step1.cookie, { state: stateOf(step1.location), code: 'c' });

    expect(replay1.location).toMatch(/\/consent_state_mismatch$/);
    expect(replay2.location).toMatch(/\/consent_state_mismatch$/);
    // The confirm step is one-shot too, and the row has left pending-consent.
    await expect(confirmation.continue(profile, owner)).rejects.toMatchObject({ code: 'stale_attempt' });
    expect(await connectionRow(owner.orgId, profile)).toEqual(before);
    expect(executor.verifyConsentIdentity).toHaveBeenCalledTimes(1);
    expect(executor.retest).toHaveBeenCalledTimes(1);
  });

  runDb('reconnect on a bound degraded row: identity pinned to bound tenant; a different verified tenant never reaches consent', async () => {
    const owner = await ownerFixture();
    const TENANT_A = randomUUID();
    await initiate(profile, owner);
    await seedBound(owner.orgId, profile, TENANT_A, 'degraded');

    const { cookie, url } = await initiate(profile, owner);
    expect(new URL(url).pathname).toBe(`/${TENANT_A}/oauth2/v2.0/authorize`);
    expect(await sessionRows(owner.orgId, profile)).toEqual([expect.objectContaining({
      tenantHintHash: createHash('sha256').update(TENANT_A).digest('hex'),
    })]);
    executor.verifyConsentIdentity.mockResolvedValue({ success: false, errorCode: 'tenant_mismatch' });

    const step1 = await callback(profile, cookie, { state: stateOf(url), code: 'c' });

    expect(executor.verifyConsentIdentity).toHaveBeenCalledWith(expect.objectContaining({ expectedTenantId: TENANT_A }));
    expect(step1.location).toMatch(/\/tenant_mismatch$/);
    expect(await connectionRow(owner.orgId, profile)).toMatchObject({
      tenantId: TENANT_A, status: 'pending-consent', lastErrorCode: 'tenant_mismatch',
    });
    expect(executor.retest).not.toHaveBeenCalled();
  });

  runDb('reconnect on a bound row re-binds the same tenant after a full identity-first round', async () => {
    const owner = await ownerFixture();
    const TENANT_A = randomUUID();
    await initiate(profile, owner);
    await seedBound(owner.orgId, profile, TENANT_A, 'degraded');

    const final = await runToFinalize(profile, owner, TENANT_A);

    expect(final.location).toMatch(/\/active$/);
    expect(await connectionRow(owner.orgId, profile)).toMatchObject({ tenantId: TENANT_A, status: 'active' });
  });

  runDb('cross-org: a tenant bound to org A cannot be bound to org B', async () => {
    const ownerA = await ownerFixture();
    const ownerB = await ownerFixture();
    const TENANT_A = randomUUID();
    await initiate(profile, ownerA);
    await seedBound(ownerA.orgId, profile, TENANT_A, 'active');

    const flow = await runToFinalize(profile, ownerB, TENANT_A);

    expect(flow.location).toMatch(/\/tenant_already_bound$/);
    expect(await connectionRow(ownerB.orgId, profile)).toMatchObject({ tenantId: null });
    expect(await connectionRow(ownerA.orgId, profile)).toMatchObject({ tenantId: TENANT_A, status: 'active' });
  });

  runDb('cross-profile: a cookie minted for the other profile cannot drive this callback', async () => {
    const owner = await ownerFixture();
    const other: Profile = profile === 'customer-graph-read' ? 'customer-graph-actions' : 'customer-graph-read';
    const foreign = await initiate(other, owner);
    const ownName = profile === 'customer-graph-read' ? 'breeze_m365_graph_read_consent' : 'breeze_m365_graph_actions_consent';
    const renamed = `${ownName}=${foreign.cookie.slice(foreign.cookie.indexOf('=') + 1)}`;

    const res = await callback(profile, renamed, { state: stateOf(foreign.url), code: 'c' });

    expect(res.location).toMatch(/\/consent_state_mismatch$/);
    expect(executor.verifyConsentIdentity).not.toHaveBeenCalled();
    expect(await sessionRows(owner.orgId, other)).toHaveLength(1);
  });

  runDb('re-initiate during identity supersedes the old attempt (concurrent tabs)', async () => {
    const owner = await ownerFixture();
    const TENANT_A = randomUUID();
    const first = await initiate(profile, owner);
    const second = await initiate(profile, owner);
    executor.verifyConsentIdentity.mockResolvedValue(identityOk(TENANT_A));

    expect((await callback(profile, first.cookie, { state: stateOf(first.url), code: 'c' })).location)
      .toMatch(/consent_state_mismatch$/);
    expect(executor.verifyConsentIdentity).not.toHaveBeenCalled();
    expect((await callback(profile, second.cookie, { state: stateOf(second.url), code: 'c' })).location)
      .toBe(`/integrations#m365/${profile}/confirm-tenant`);
  });

  runDb('a pre-W1 executor (verify-identity unavailable) fails the attempt without binding', async () => {
    const owner = await ownerFixture();
    const { cookie, url } = await initiate(profile, owner);
    executor.verifyConsentIdentity.mockRejectedValue(new Error('m365_executor_unavailable'));

    const step1 = await callback(profile, cookie, { state: stateOf(url), code: 'c' });

    expect(step1.location).toMatch(/\/executor_unavailable$/);
    expect(await connectionRow(owner.orgId, profile)).toMatchObject({
      status: 'pending-consent', tenantId: null, lastErrorCode: 'executor_unavailable',
    });
    expect(await sessionRows(owner.orgId, profile)).toEqual([]);
  });

  runDb('a failed application proof never binds the verified tenant', async () => {
    const owner = await ownerFixture();
    const TENANT_A = randomUUID();
    const { cookie, url } = await initiate(profile, owner);
    executor.verifyConsentIdentity.mockResolvedValue(identityOk(TENANT_A));
    const step1 = await throughConfirm(profile, owner, await callback(profile, cookie, { state: stateOf(url), code: 'c' }));
    executor.retest.mockResolvedValue({ success: false, errorCode: 'application_token_invalid' });

    const step2 = await callback(profile, step1.cookie, { state: stateOf(step1.location), code: 'c' });

    expect(step2.location).toMatch(/\/application_token_invalid$/);
    expect(await connectionRow(owner.orgId, profile)).toMatchObject({
      status: 'pending-consent', tenantId: null, lastErrorCode: 'application_token_invalid',
    });
  });

  runDb('legacy in-flight row: a flow_version 1 session can be neither read for purpose nor consumed', async () => {
    const owner = await ownerFixture();
    const { connectionId } = await initiate(profile, owner);
    const row = await connectionRow(owner.orgId, profile);
    const rawState = `legacy-${randomUUID()}`;
    await withSystemDbAccessContext(() => db.insert(m365ConsentSessions).values({
      stateHash: createHash('sha256').update(rawState).digest('hex'),
      phase: 'admin_consent',
      flowVersion: 1,
      connectionId,
      orgId: owner.orgId,
      profile,
      consentAttemptId: row!.consentAttemptId!,
      userId: owner.actorId,
      expiresAt: new Date(Date.now() + 300_000),
    }));
    const lookup = { rawState, phase: 'admin_consent' as const, connectionId, consentAttemptId: row!.consentAttemptId!, profile };

    expect(await readConsentSessionPurpose(lookup)).toBeNull();
    expect(await consumeConsentSession({ ...lookup, orgId: owner.orgId })).toBeNull();
    expect((await sessionRows(owner.orgId, profile)).filter((s) => s.flowVersion === 1)).toHaveLength(1);
  });

  runDb('a legacy v1 browser cookie from before the deploy restarts with consent_expired', async () => {
    const owner = await ownerFixture();
    const { connectionId } = await initiate(profile, owner);
    const row = await connectionRow(owner.orgId, profile);
    const context = profile === 'customer-graph-read'
      ? 'breeze:m365-customer-graph-read:browser-binding:v1'
      : 'breeze:m365-customer-graph-actions:browser-binding:v1';
    const name = profile === 'customer-graph-read' ? 'breeze_m365_graph_read_consent' : 'breeze_m365_graph_actions_consent';
    const payload = Buffer.from(JSON.stringify({
      phase: 'admin_consent', rawState: 'old', connectionId, consentAttemptId: row!.consentAttemptId,
      tenantHint: null, expiresAt: Math.floor(Date.now() / 1000) + 300,
    })).toString('base64url');
    const mac = createHmac('sha256', process.env.APP_ENCRYPTION_KEY!).update(`${context}.${payload}`).digest('base64url');

    const res = await callback(profile, `${name}=${payload}.${mac}`, { state: 'old', tenant: randomUUID(), admin_consent: 'True' });

    expect(res.location).toMatch(/\/consent_expired$/);
    expect(await connectionRow(owner.orgId, profile)).toMatchObject({ status: 'pending-consent', tenantId: null });
  });

  // ---- W03 confirm-tenant interstitial -----------------------------------
  async function parkAt(owner: { orgId: string; actorId: string }, tenantId: string) {
    const { cookie, url } = await initiate(profile, owner);
    executor.verifyConsentIdentity.mockResolvedValue(identityOk(tenantId));
    const parked = await callback(profile, cookie, { state: stateOf(url), code: 'c' });
    expect(parked.location).toBe(`/integrations#m365/${profile}/confirm-tenant`);
    return { cookie, url, parked };
  }

  runDb('confirm-tenant: continue is one-shot, rotates state, and the parked identity callback cannot be replayed', async () => {
    const owner = await ownerFixture();
    const TENANT_A = randomUUID();
    const { cookie, url } = await parkAt(owner, TENANT_A);
    const parkedRow = (await sessionRows(owner.orgId, profile))[0]!;

    const continued = await confirmation.continue(profile, owner);

    expect(new URL(continued.consentUrl).pathname).toBe(`/${TENANT_A}/oauth2/authorize`);
    const rows = await sessionRows(owner.orgId, profile);
    expect(rows).toEqual([expect.objectContaining({ phase: 'admin_consent', verifiedTenantId: TENANT_A })]);
    expect(rows[0]!.stateHash).not.toBe(parkedRow.stateHash);
    expect(createHash('sha256').update(stateOf(continued.consentUrl)).digest('hex')).toBe(rows[0]!.stateHash);
    await expect(confirmation.continue(profile, owner)).rejects.toMatchObject({ code: 'stale_attempt' });
    expect(await confirmation.pending(profile, owner)).toBeNull();
    expect((await callback(profile, cookie, { state: stateOf(url), code: 'c' })).location).toMatch(/\/consent_state_mismatch$/);
    expect(executor.verifyConsentIdentity).toHaveBeenCalledTimes(1);
    expect(await connectionRow(owner.orgId, profile)).toMatchObject({ status: 'pending-consent', tenantId: null });
  });

  runDb('confirm-tenant: only the Breeze user who signed in can read or confirm the parked tenant', async () => {
    const owner = await ownerFixture();
    const TENANT_A = randomUUID();
    await parkAt(owner, TENANT_A);
    const colleague = await withSystemDbAccessContext(async () => {
      const [org] = await db.select({ partnerId: organizations.partnerId }).from(organizations)
        .where(eq(organizations.id, owner.orgId));
      return (await createUser({
        partnerId: org!.partnerId,
        orgId: owner.orgId,
        email: `m365-colleague-${randomUUID()}@example.com`,
      })).id;
    });
    const other = { orgId: owner.orgId, actorId: colleague };

    expect(await confirmation.pending(profile, other)).toBeNull();
    await expect(confirmation.continue(profile, other)).rejects.toMatchObject({ code: 'stale_attempt' });
    await expect(confirmation.cancel(profile, other)).rejects.toMatchObject({ code: 'stale_attempt' });
    expect(await sessionRows(owner.orgId, profile)).toEqual([expect.objectContaining({ phase: 'tenant_confirmation' })]);
    expect(await confirmation.pending(profile, owner)).toMatchObject({ tenantId: TENANT_A });
  });

  runDb("confirm-tenant: org B cannot read or consume org A's parked confirmation", async () => {
    const ownerA = await ownerFixture();
    const ownerB = await ownerFixture();
    const TENANT_A = randomUUID();
    await parkAt(ownerA, TENANT_A);
    await initiate(profile, ownerB);

    // Same Breeze user id, org B: nothing parked there.
    const crossed = { orgId: ownerB.orgId, actorId: ownerA.actorId };
    expect(await confirmation.pending(profile, crossed)).toBeNull();
    await expect(confirmation.continue(profile, crossed)).rejects.toMatchObject({ code: 'stale_attempt' });
    expect(await sessionRows(ownerA.orgId, profile)).toEqual([expect.objectContaining({ phase: 'tenant_confirmation' })]);
    expect((await sessionRows(ownerB.orgId, profile)).every((row) => row.phase === 'identity_verification')).toBe(true);
  });

  runDb('confirm-tenant: an expired confirmation can be neither read nor confirmed, and binds nothing', async () => {
    const owner = await ownerFixture();
    await parkAt(owner, randomUUID());
    await withSystemDbAccessContext(() => db.update(m365ConsentSessions)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(and(eq(m365ConsentSessions.orgId, owner.orgId), eq(m365ConsentSessions.profile, profile))));

    expect(await confirmation.pending(profile, owner)).toBeNull();
    await expect(confirmation.continue(profile, owner)).rejects.toMatchObject({ code: 'stale_attempt' });
    expect((await sessionRows(owner.orgId, profile)).filter((row) => row.phase === 'admin_consent')).toEqual([]);
    expect(await connectionRow(owner.orgId, profile)).toMatchObject({ status: 'pending-consent', tenantId: null });
  });

  runDb('confirm-tenant: cancel consumes the park, records consent_cancelled, binds nothing; continue afterwards is refused', async () => {
    const owner = await ownerFixture();
    await parkAt(owner, randomUUID());

    const cancelled = await confirmation.cancel(profile, owner);

    expect(cancelled).toMatchObject({ status: 'pending-consent', tenantId: null, lastErrorCode: 'consent_cancelled' });
    expect(await sessionRows(owner.orgId, profile)).toEqual([]);
    expect(await connectionRow(owner.orgId, profile)).toMatchObject({
      status: 'pending-consent', tenantId: null, lastErrorCode: 'consent_cancelled',
    });
    await expect(confirmation.continue(profile, owner)).rejects.toMatchObject({ code: 'stale_attempt' });
    expect(executor.retest).not.toHaveBeenCalled();
  });

  runDb('confirm-tenant: a pinned (bound) reconnect never parks', async () => {
    const owner = await ownerFixture();
    const TENANT_A = randomUUID();
    await initiate(profile, owner);
    await seedBound(owner.orgId, profile, TENANT_A, 'degraded');
    const { cookie, url } = await initiate(profile, owner);
    executor.verifyConsentIdentity.mockResolvedValue(identityOk(TENANT_A));

    const step1 = await callback(profile, cookie, { state: stateOf(url), code: 'c' });

    expect(new URL(step1.location).pathname).toBe(`/${TENANT_A}/oauth2/authorize`);
    expect(await sessionRows(owner.orgId, profile)).toEqual([expect.objectContaining({ phase: 'admin_consent' })]);
    expect(await confirmation.pending(profile, owner)).toBeNull();
  });

  runDb('a row left in verifying by the old flow is restartable by initiating again', async () => {
    const owner = await ownerFixture();
    await initiate(profile, owner);
    await withSystemDbAccessContext(() => db.update(m365Connections).set({ status: 'verifying', tenantId: null })
      .where(and(eq(m365Connections.orgId, owner.orgId), eq(m365Connections.profile, profile))));

    const { url } = await initiate(profile, owner);

    expect(new URL(url).pathname).toBe('/organizations/oauth2/v2.0/authorize');
    expect((await connectionRow(owner.orgId, profile))!.status).toBe('pending-consent');
  });
});

describe('customer-graph-read upgrade (manifest bump), identity-first (real DB)', () => {
  const profile = 'customer-graph-read' as const;
  const CURRENT = M365_PERMISSION_PROFILES[profile].version;

  async function staleBound() {
    const owner = await ownerFixture();
    const TENANT_A = randomUUID();
    await initiate(profile, owner);
    await seedBound(owner.orgId, profile, TENANT_A, 'active', CURRENT - 1);
    return { owner, TENANT_A };
  }

  async function initiateUpgrade(owner: { orgId: string; actorId: string }) {
    const row = await connectionRow(owner.orgId, profile);
    const initiated = await initiateCustomerGraphReadUpgradeConsent({ connectionId: row!.id, orgId: owner.orgId, auth: authFor(owner) });
    return { cookie: cookieFor(profile, initiated.binding), url: initiated.authorizationUrl };
  }

  runDb('pinned to bound tenant, stays executable throughout, promotes on success', async () => {
    const { owner, TENANT_A } = await staleBound();
    const { cookie, url } = await initiateUpgrade(owner);
    expect(new URL(url).pathname).toBe(`/${TENANT_A}/oauth2/v2.0/authorize`);

    executor.verifyConsentIdentity.mockResolvedValue(identityOk(TENANT_A));
    const step1 = await callback(profile, cookie, { state: stateOf(url), code: 'c' });
    expect(new URL(step1.location).pathname).toBe(`/${TENANT_A}/oauth2/authorize`);
    expect(executor.verifyConsentIdentity).toHaveBeenCalledWith(expect.objectContaining({ expectedTenantId: TENANT_A }));
    expect((await connectionRow(owner.orgId, profile))!.status).toBe('active');

    executor.retest.mockResolvedValue(retestOk(TENANT_A, profile));
    const step2 = await callback(profile, step1.cookie, { state: stateOf(step1.location), code: 'x' });

    expect(step2.location).toMatch(/\/active$/);
    expect(await connectionRow(owner.orgId, profile)).toMatchObject({ status: 'active', permissionManifestVersion: CURRENT, tenantId: TENANT_A });
  });

  runDb('upgrade failure at finalize leaves the row byte-identical', async () => {
    const { owner, TENANT_A } = await staleBound();
    const { cookie, url } = await initiateUpgrade(owner);
    executor.verifyConsentIdentity.mockResolvedValue(identityOk(TENANT_A));
    const step1 = await callback(profile, cookie, { state: stateOf(url), code: 'c' });
    const before = await connectionRow(owner.orgId, profile);
    executor.retest.mockResolvedValue({ success: false, errorCode: 'application_token_invalid' });

    const step2 = await callback(profile, step1.cookie, { state: stateOf(step1.location), code: 'x' });

    expect(step2.location).toMatch(/\/application_token_invalid$/);
    expect(await connectionRow(owner.orgId, profile)).toEqual(before);
  });

  runDb('an identity in another tenant never reaches consent and never touches the live row', async () => {
    const { owner } = await staleBound();
    const before = await connectionRow(owner.orgId, profile);
    const { cookie, url } = await initiateUpgrade(owner);
    executor.verifyConsentIdentity.mockResolvedValue({ success: false, errorCode: 'tenant_mismatch' });

    const step1 = await callback(profile, cookie, { state: stateOf(url), code: 'c' });

    expect(step1.location).toMatch(/\/tenant_mismatch$/);
    expect(await connectionRow(owner.orgId, profile)).toEqual(before);
  });
});
