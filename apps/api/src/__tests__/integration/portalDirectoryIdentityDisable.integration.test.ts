/**
 * The shared identity writer on real Postgres (portal registration W8 #11385,
 * plan Task 3; D2, D3, D9; Review Focus 3 and 4; invariant 9).
 *
 * disablePortalIdentity / restorePortalIdentity / removeDisabledPortalIdentity
 * run as breeze_app under forced RLS through the real `db` pool with no DB
 * context held, exactly as the job and the routes call them. Races use two
 * concurrent calls, each on its own pooled connection (Promise.allSettled), and
 * assert the invariant over several rounds. Fixtures are seeded and read back
 * over the superuser connection.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getTestDb, getTestRedis } from './setup';
import { createOrganization, createPartner, createUser } from './db-utils';
import {
  auditLogs,
  clientAiTenantMappings,
  portalAccessPolicies,
  portalDirectoryActions,
  portalDirectoryRuns,
  portalUserIdentities,
  portalUsers,
} from '../../db/schema';
import { clientAiAuthMiddleware } from '../../middleware/clientAiAuth';
import { CLIENT_AI_REDIS_KEYS } from '../../routes/clientAi/schemas';
import { portalAuthMiddleware } from '../../routes/portal/auth';
import { portalSessions } from '../../routes/portal/helpers';
import { __testOnly as policyTestOnly } from '../../services/portalAccessPolicy';
import { planPortalAccountTransition, type PortalAccountFacts } from '../../services/portalAccountState';
import {
  resolvePortalOidcSignIn,
  type PortalOidcSignInOutcome,
  type ResolvePortalOidcSignInInput,
} from '../../services/portalOidc/accountResolution';
import { PORTAL_GOOGLE_ISSUER, entraIssuer } from '../../services/portalUserIdentities';
import {
  disablePortalIdentity,
  removeDisabledPortalIdentity,
  restorePortalIdentity,
  retryPendingPurges,
} from '../../services/portalDirectory/identityDisable';

const admin = () => getTestDb();
const ROUNDS = 6;

beforeEach(() => {
  policyTestOnly.setCapabilities({ entra: true, google: true, selfRegistration: false });
});

afterEach(() => {
  policyTestOnly.setCapabilities(null);
});

async function seedOrg(opts: { ssoOnly?: boolean } = {}) {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const tid = randomUUID();
  await admin().insert(clientAiTenantMappings).values({
    orgId: org.id,
    entraTenantId: tid,
    provenAt: new Date(),
    provenVia: 'proof_run' as const,
    provenEvidence: { via: 'proof_run' as const, adminOid: randomUUID(), runId: randomUUID() },
    provenByUserId: null,
  });
  await admin().insert(portalAccessPolicies).values({
    orgId: org.id,
    entraEnabled: true,
    passwordMode: opts.ssoOnly ? 'sso_only' : 'allowed',
    ssoNewPersonMode: 'approval',
  });
  return { partner, org, tid };
}

type AccountSeed = {
  status?: 'invited' | 'active' | 'disabled';
  disabledBy?: 'msp' | 'directory';
  browserAccess?: 'granted' | 'none';
  authMethod?: 'password' | 'entra';
  passwordHash?: string | null;
  entra?: { tid: string; oid: string };
  google?: { sub: string };
};

async function seedAccount(orgId: string, seed: AccountSeed = {}) {
  const status = seed.status ?? 'active';
  const [row] = await admin().insert(portalUsers).values({
    orgId,
    email: `pu-${randomUUID()}@customer.test`,
    authMethod: seed.authMethod ?? 'entra',
    status,
    disabledBy: status === 'disabled' ? (seed.disabledBy ?? 'msp') : null,
    browserAccess: seed.browserAccess ?? 'granted',
    passwordHash: seed.passwordHash ?? null,
    authEpoch: 5,
    ...(seed.entra ? { entraTenantId: seed.entra.tid, entraOid: seed.entra.oid } : {}),
  }).returning();
  const identityIds: { entra?: string; google?: string } = {};
  if (seed.entra) {
    const [i] = await admin().insert(portalUserIdentities).values({
      orgId, portalUserId: row!.id, provider: 'entra', issuer: entraIssuer(seed.entra.tid),
      subject: seed.entra.oid, entraTenantId: seed.entra.tid, linkedVia: 'jit',
    }).returning({ id: portalUserIdentities.id });
    identityIds.entra = i!.id;
  }
  if (seed.google) {
    const [i] = await admin().insert(portalUserIdentities).values({
      orgId, portalUserId: row!.id, provider: 'google', issuer: PORTAL_GOOGLE_ISSUER,
      subject: seed.google.sub, entraTenantId: null, linkedVia: 'jit',
    }).returning({ id: portalUserIdentities.id });
    identityIds.google = i!.id;
  }
  return { account: row!, identityIds };
}

async function readAccount(id: string) {
  const [row] = await admin().select().from(portalUsers).where(eq(portalUsers.id, id));
  return row!;
}

async function readIdentity(id: string) {
  const [row] = await admin().select().from(portalUserIdentities).where(eq(portalUserIdentities.id, id));
  return row;
}

async function seedHeldAction(orgId: string, identityId: string, portalUserId: string, chainKey: string) {
  const [run] = await admin().insert(portalDirectoryRuns).values({
    orgId, source: 'entra', chainKey, snapshotKey: `snap-${randomUUID()}`, snapshotAt: new Date(),
    outcome: 'evaluated', mode: 'enforce', disposition: 'applying',
  }).returning({ id: portalDirectoryRuns.id });
  const [action] = await admin().insert(portalDirectoryActions).values({
    orgId, runId: run!.id, identityId, portalUserId, provider: 'entra', reason: 'account_disabled',
    // An auto-apply (`applying`) run's actions are `pending`; the identity's latest observation is this run's (D8d).
    effect: 'identity_and_account', status: 'pending',
  }).returning({ id: portalDirectoryActions.id });
  await admin().update(portalUserIdentities).set({ directoryLastRunId: run!.id }).where(eq(portalUserIdentities.id, identityId));
  return { runId: run!.id, actionId: action!.id };
}

function entraIdentity(tid: string, oid: string) {
  return {
    provider: 'entra' as const,
    issuer: entraIssuer(tid),
    subject: oid,
    entraTenantId: tid,
    upn: null,
    emailClaim: null,
    emailDomainOwnerVerified: false,
    name: 'Pat Person',
  };
}

const noInvite: ResolvePortalOidcSignInInput['inviteConsumer'] = async () => {
  throw new Error('the invite consumer must not be called on this path');
};

const entraDisable = (orgId: string, identityId: string, extra: Record<string, unknown> = {}) =>
  disablePortalIdentity({ orgId, identityId, blocker: 'entra_directory', reason: 'account_disabled', ...extra });

describe('disablePortalIdentity — the account rule on real Postgres (Review Focus 3)', () => {
  it('identity-only account: identity and account disabled, epoch bumped, action applied and audited', async () => {
    const { org, tid } = await seedOrg();
    const { account, identityIds } = await seedAccount(org.id, { entra: { tid, oid: randomUUID() } });
    const chain = `entra:${tid}:conn:1:${org.id}`;
    await admin().update(portalUserIdentities).set({ directoryChain: chain }).where(eq(portalUserIdentities.id, identityIds.entra!));
    const { runId, actionId } = await seedHeldAction(org.id, identityIds.entra!, account.id, chain);

    const out = await entraDisable(org.id, identityIds.entra!, { actionId, expect: { directoryChain: chain } });

    expect(out).toEqual({ kind: 'disabled', portalUserId: account.id, accountDisabled: true, keepsPassword: false });
    expect(await readAccount(account.id)).toMatchObject({ status: 'disabled', disabledBy: 'directory', authEpoch: 6 });
    expect(await readIdentity(identityIds.entra!)).toMatchObject({
      disabledBlockers: ['entra_directory'], disabledReason: 'account_disabled',
    });
    const [action] = await admin().select().from(portalDirectoryActions).where(eq(portalDirectoryActions.id, actionId));
    expect(action!.status).toBe('applied');
    expect(action!.appliedAt).not.toBeNull();
    expect(action!.sessionsPurgedAt).not.toBeNull();
    const audits = await admin().select().from(auditLogs)
      .where(and(eq(auditLogs.orgId, org.id), eq(auditLogs.action, 'portal.directory.identity.disable')));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorType: 'system', resourceType: 'portal_user', resourceId: account.id });
    expect(audits[0]!.details).toMatchObject({ identityId: identityIds.entra, runId, accountDisabled: true, keepsPassword: false });
  });

  it('password account under allowed keeps the account active; under sso_only it is disabled', async () => {
    for (const ssoOnly of [false, true]) {
      const { org, tid } = await seedOrg({ ssoOnly });
      const { account, identityIds } = await seedAccount(org.id, {
        authMethod: 'password', passwordHash: 'argon2-hash', entra: { tid, oid: randomUUID() },
      });
      const out = await entraDisable(org.id, identityIds.entra!);
      expect(out).toMatchObject({ kind: 'disabled', accountDisabled: ssoOnly, keepsPassword: !ssoOnly });
      expect(await readAccount(account.id)).toMatchObject({
        status: ssoOnly ? 'disabled' : 'active',
        disabledBy: ssoOnly ? 'directory' : null,
        authEpoch: 6,
      });
    }
  });

  it('an already-disabled (MSP) account keeps disabled_by msp', async () => {
    const { org, tid } = await seedOrg();
    const { account, identityIds } = await seedAccount(org.id, { status: 'disabled', disabledBy: 'msp', entra: { tid, oid: randomUUID() } });
    await entraDisable(org.id, identityIds.entra!);
    expect(await readAccount(account.id)).toMatchObject({ status: 'disabled', disabledBy: 'msp' });
  });

  it('after deprovision the browser and add-in sessions are refused on the next request', async () => { // inv. 9
    const { org, tid } = await seedOrg();
    const { account, identityIds } = await seedAccount(org.id, { entra: { tid, oid: randomUUID() } });
    const browserToken = `portal-${randomUUID()}`;
    portalSessions.set(browserToken, {
      token: browserToken, portalUserId: account.id, orgId: org.id, authEpoch: 5,
      createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000),
    });
    const addinToken = `client-ai-${randomUUID()}`;
    const redis = getTestRedis();
    await redis.set(
      CLIENT_AI_REDIS_KEYS.session(addinToken),
      JSON.stringify({ portalUserId: account.id, orgId: org.id, authEpoch: 5, createdAt: new Date().toISOString() }),
    );
    await redis.sadd(CLIENT_AI_REDIS_KEYS.userSessions(account.id), addinToken);

    await entraDisable(org.id, identityIds.entra!);

    const browser = new Hono();
    browser.use('*', portalAuthMiddleware);
    browser.get('/protected', () => new Response('downstream'));
    expect((await browser.request('/protected', { headers: { Authorization: `Bearer ${browserToken}` } })).status).toBe(401);
    const addin = new Hono();
    addin.use('*', clientAiAuthMiddleware);
    addin.get('/protected', () => new Response('downstream'));
    expect((await addin.request('/protected', { headers: { Authorization: `Bearer ${addinToken}` } })).status).toBe(401);
  });

  describe('races (two concurrent calls, separate pool connections)', () => {
    it('concurrent disables of both identities disable the account', async () => { // RF3, quorum omission 2
      for (let round = 0; round < ROUNDS; round += 1) {
        const { org, tid } = await seedOrg();
        const { account, identityIds } = await seedAccount(org.id, { entra: { tid, oid: randomUUID() }, google: { sub: randomUUID() } });

        const settled = await Promise.allSettled([
          entraDisable(org.id, identityIds.entra!),
          disablePortalIdentity({ orgId: org.id, identityId: identityIds.google!, blocker: 'google_directory', reason: 'suspended' }),
        ]);
        expect(settled.map((s) => s.status)).toEqual(['fulfilled', 'fulfilled']);
        // Each saw the other's disable or waited for it: never both "the other still signs in".
        expect(await readAccount(account.id)).toMatchObject({ status: 'disabled', disabledBy: 'directory' });
        expect((await readIdentity(identityIds.entra!))!.disabledAt).not.toBeNull();
        expect((await readIdentity(identityIds.google!))!.disabledAt).not.toBeNull();
      }
    });

    it('a sign-in racing a disable cannot keep a session', async () => { // RF3, quorum D1
      for (let round = 0; round < ROUNDS; round += 1) {
        const { org, tid } = await seedOrg();
        const oid = randomUUID();
        const { account, identityIds } = await seedAccount(org.id, { entra: { tid, oid } });

        const [signIn, disable] = await Promise.allSettled([
          resolvePortalOidcSignIn({ purpose: { kind: 'login' }, hostOrgId: null, inviteConsumer: noInvite, identity: entraIdentity(tid, oid) }),
          entraDisable(org.id, identityIds.entra!),
        ]);
        expect(signIn.status).toBe('fulfilled');
        expect(disable.status).toBe('fulfilled');
        const outcome = (signIn as PromiseFulfilledResult<PortalOidcSignInOutcome>).value;
        const after = await readAccount(account.id);
        expect(after.status).toBe('disabled');
        if (outcome.kind === 'session') {
          // The sign-in won the account lock: its session's epoch is already dead.
          expect(after.authEpoch).toBeGreaterThan(outcome.authEpoch);
        } else {
          expect(outcome).toMatchObject({ kind: 'denied' });
        }
      }
    });
  });

  it('not found, chain changed and rearmed are skips that write nothing', async () => {
    const { org, tid } = await seedOrg();
    const { account, identityIds } = await seedAccount(org.id, { entra: { tid, oid: randomUUID() } });
    await admin().update(portalUserIdentities).set({ directoryChain: 'entra:old' }).where(eq(portalUserIdentities.id, identityIds.entra!));

    const other = await seedOrg();
    expect(await entraDisable(other.org.id, identityIds.entra!)).toEqual({ kind: 'skipped', reason: 'not_found' });
    expect(await entraDisable(org.id, identityIds.entra!, { expect: { directoryChain: 'entra:new' } }))
      .toEqual({ kind: 'skipped', reason: 'chain_changed' });
    await admin().update(portalUserIdentities).set({ directoryRearmSince: new Date() }).where(eq(portalUserIdentities.id, identityIds.entra!));
    expect(await entraDisable(org.id, identityIds.entra!)).toEqual({ kind: 'skipped', reason: 'rearmed' });

    expect(await readAccount(account.id)).toMatchObject({ status: 'active', authEpoch: 5 });
    expect((await readIdentity(identityIds.entra!))!.disabledAt).toBeNull();
  });

  it('a purge left unfinished is completed by retryPendingPurges', async () => {
    const { org, tid } = await seedOrg();
    const { account, identityIds } = await seedAccount(org.id, { entra: { tid, oid: randomUUID() } });
    const { actionId } = await seedHeldAction(org.id, identityIds.entra!, account.id, 'entra:c');
    await entraDisable(org.id, identityIds.entra!, { actionId });
    await admin().update(portalDirectoryActions).set({ sessionsPurgedAt: null }).where(eq(portalDirectoryActions.id, actionId));

    expect(await retryPendingPurges(new Date())).toBeGreaterThanOrEqual(1);
    const [action] = await admin().select().from(portalDirectoryActions).where(eq(portalDirectoryActions.id, actionId));
    expect(action!.sessionsPurgedAt).not.toBeNull();
  });
});

describe('restore and remove (D9, OD3; Review Focus 4)', () => {
  it('a second blocker is added, not a no-op; restore clears both and reactivates', async () => {
    const { partner, org, tid } = await seedOrg();
    const actor = await createUser({ partnerId: partner.id, email: `tech-${randomUUID()}@msp.test`, name: 'Tech One' });
    const { account, identityIds } = await seedAccount(org.id, { entra: { tid, oid: randomUUID() } });
    const { actionId } = await seedHeldAction(org.id, identityIds.entra!, account.id, 'entra:c');

    await entraDisable(org.id, identityIds.entra!, { actionId });
    const second = await disablePortalIdentity({ orgId: org.id, identityId: identityIds.entra!, blocker: 'scim', reason: 'scim_deactivated' });
    expect(second).toEqual({ kind: 'blocker_added', portalUserId: account.id, accountDisabled: false });
    expect((await readIdentity(identityIds.entra!))!.disabledBlockers).toEqual(['entra_directory', 'scim']);
    expect((await readAccount(account.id)).authEpoch).toBe(6); // one bump, on the first blocker

    const restored = await restorePortalIdentity({
      orgId: org.id, portalUserId: account.id, identityId: identityIds.entra!,
      reactivateAccount: true, confirmMspDisabled: false, actorUserId: actor.id,
    });
    expect(restored).toEqual({ accountStatus: 'active', blockersCleared: ['entra_directory', 'scim'] });
    expect(await readIdentity(identityIds.entra!)).toMatchObject({
      disabledAt: null, disabledReason: null, disabledBlockers: [], directoryAbsentRuns: 0,
    });
    expect((await readIdentity(identityIds.entra!))!.directoryRearmSince).not.toBeNull();
    expect(await readAccount(account.id)).toMatchObject({ status: 'active', disabledBy: null });
    const [action] = await admin().select().from(portalDirectoryActions).where(eq(portalDirectoryActions.id, actionId));
    expect(action).toMatchObject({ status: 'restored', restoredByUserId: actor.id });
    const actions = (await admin().select().from(auditLogs).where(eq(auditLogs.orgId, org.id))).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['organization.portal_user.identity.restore', 'organization.portal_user.update']));
  });

  it('restore of an msp-disabled account needs both confirmations to reactivate', async () => {
    const { partner, org, tid } = await seedOrg();
    const actor = await createUser({ partnerId: partner.id, email: `tech-${randomUUID()}@msp.test`, name: 'Tech One' });
    const { account, identityIds } = await seedAccount(org.id, { status: 'disabled', disabledBy: 'msp', entra: { tid, oid: randomUUID() } });
    await entraDisable(org.id, identityIds.entra!);
    const input = { orgId: org.id, portalUserId: account.id, identityId: identityIds.entra!, reactivateAccount: true, actorUserId: actor.id };

    await expect(restorePortalIdentity({ ...input, confirmMspDisabled: false })).rejects.toMatchObject({ code: 'PORTAL_ACCOUNT_MSP_DISABLED_CONFIRM' });
    expect((await readIdentity(identityIds.entra!))!.disabledAt).not.toBeNull(); // rolled back whole
    expect(await restorePortalIdentity({ ...input, confirmMspDisabled: true })).toMatchObject({ accountStatus: 'active' });
  });

  // W08a known follow-up (OD3): removing the account's LAST sign-in method
  // must leave an account the MSP can re-invite. Before, it kept
  // auth_method 'entra' and every invite writer refused it (identity_managed),
  // so the only recovery was deleting the account.
  const factsOf = (row: Awaited<ReturnType<typeof readAccount>>, identities: number): PortalAccountFacts => ({
    status: row.status,
    browserAccess: row.browserAccess,
    authMethod: row.authMethod,
    hasPasswordHash: Boolean(row.passwordHash),
    hasExternalIdentity: identities > 0,
    hasUsableExternalIdentity: identities > 0,
    passwordUsable: false,
    disabledBy: row.disabledBy,
  });

  it('removing the last sign-in method makes the account invitable: password method, no hash, epoch bumped', async () => {
    const { partner, org, tid } = await seedOrg();
    const actor = await createUser({ partnerId: partner.id, email: `tech-${randomUUID()}@msp.test`, name: 'Tech One' });
    // A stray hash on a non-password row is not a credential; it must not become one.
    const { account, identityIds } = await seedAccount(org.id, { entra: { tid, oid: randomUUID() }, passwordHash: 'h'.repeat(60) });
    await entraDisable(org.id, identityIds.entra!);
    const disabled = await readAccount(account.id);
    expect(disabled).toMatchObject({ status: 'disabled', disabledBy: 'directory', authMethod: 'entra' });

    await removeDisabledPortalIdentity({ orgId: org.id, portalUserId: account.id, identityId: identityIds.entra!, actorUserId: actor.id });

    const after = await readAccount(account.id);
    expect(after).toMatchObject({ status: 'disabled', disabledBy: 'directory', authMethod: 'password', passwordHash: null });
    expect(after.authEpoch).toBe(disabled.authEpoch + 1);
    // Reactivate (no credential ⇒ invited), then an invite or a Microsoft invite is accepted.
    const reactivated = planPortalAccountTransition(factsOf(after, 0), 'msp_reactivate');
    expect(reactivated.status).toBe('invited');
    const invitedFacts = { ...factsOf(after, 0), status: 'invited', disabledBy: null };
    expect(planPortalAccountTransition(invitedFacts, 'msp_resend_invite').status).toBe('invited');
    expect(planPortalAccountTransition(invitedFacts, 'msp_sso_invite').status).toBe('invited');
    const audit = await admin().select().from(auditLogs)
      .where(and(eq(auditLogs.orgId, org.id), eq(auditLogs.action, 'organization.portal_user.identity.remove')));
    expect(audit[0]!.details).toMatchObject({ provider: 'entra', authMethodReset: true });
  });

  it('a google-method account gets the same reset when its last sign-in method goes', async () => {
    const { partner, org } = await seedOrg();
    const actor = await createUser({ partnerId: partner.id, email: `tech-${randomUUID()}@msp.test`, name: 'Tech One' });
    const { account, identityIds } = await seedAccount(org.id, { authMethod: 'google' as never, google: { sub: randomUUID() } });
    await disablePortalIdentity({ orgId: org.id, identityId: identityIds.google!, blocker: 'google_directory', reason: 'suspended' });
    expect(await readAccount(account.id)).toMatchObject({ status: 'disabled', disabledBy: 'directory' });
    await removeDisabledPortalIdentity({ orgId: org.id, portalUserId: account.id, identityId: identityIds.google!, actorUserId: actor.id });
    const after = await readAccount(account.id);
    expect(after).toMatchObject({ authMethod: 'password', passwordHash: null });
    expect(planPortalAccountTransition(factsOf(after, 0), 'msp_reactivate').status).toBe('invited');
  });

  it('removing one of two sign-in methods leaves the account as it is', async () => {
    const { partner, org, tid } = await seedOrg();
    const actor = await createUser({ partnerId: partner.id, email: `tech-${randomUUID()}@msp.test`, name: 'Tech One' });
    const { account, identityIds } = await seedAccount(org.id, { entra: { tid, oid: randomUUID() }, google: { sub: randomUUID() } });
    await entraDisable(org.id, identityIds.entra!);
    const before = await readAccount(account.id);
    await removeDisabledPortalIdentity({ orgId: org.id, portalUserId: account.id, identityId: identityIds.entra!, actorUserId: actor.id });
    expect(await readAccount(account.id)).toMatchObject({ authMethod: 'entra', status: before.status, authEpoch: before.authEpoch });
    expect(await readIdentity(identityIds.google!)).toBeDefined();
  });

  it('a password account keeps its password when its last identity is removed', async () => {
    const { partner, org, tid } = await seedOrg();
    const actor = await createUser({ partnerId: partner.id, email: `tech-${randomUUID()}@msp.test`, name: 'Tech One' });
    const { account, identityIds } = await seedAccount(org.id, { authMethod: 'password', passwordHash: 'p'.repeat(60), entra: { tid, oid: randomUUID() } });
    await entraDisable(org.id, identityIds.entra!);
    const before = await readAccount(account.id);
    expect(before.status).toBe('active'); // keeps password access (OD4)
    await removeDisabledPortalIdentity({ orgId: org.id, portalUserId: account.id, identityId: identityIds.entra!, actorUserId: actor.id });
    expect(await readAccount(account.id)).toMatchObject({ authMethod: 'password', passwordHash: 'p'.repeat(60), status: 'active', authEpoch: before.authEpoch });
  });

  it('remove deletes one directory-disabled identity, cascades its actions and frees the legacy columns', async () => {
    const { partner, org, tid } = await seedOrg();
    const actor = await createUser({ partnerId: partner.id, email: `tech-${randomUUID()}@msp.test`, name: 'Tech One' });
    const { account, identityIds } = await seedAccount(org.id, { entra: { tid, oid: randomUUID() } });
    const { actionId } = await seedHeldAction(org.id, identityIds.entra!, account.id, 'entra:c');
    const input = { orgId: org.id, portalUserId: account.id, identityId: identityIds.entra!, actorUserId: actor.id };

    await expect(removeDisabledPortalIdentity(input)).rejects.toMatchObject({ code: 'PORTAL_IDENTITY_NOT_DIRECTORY_DISABLED' });
    await entraDisable(org.id, identityIds.entra!, { actionId });
    expect(await removeDisabledPortalIdentity(input)).toEqual({ identityId: identityIds.entra, provider: 'entra', blockers: ['entra_directory'] });

    expect(await readIdentity(identityIds.entra!)).toBeUndefined();
    expect(await admin().select().from(portalDirectoryActions).where(eq(portalDirectoryActions.id, actionId))).toEqual([]);
    expect(await readAccount(account.id)).toMatchObject({ entraOid: null, entraTenantId: null, status: 'disabled' });
    // The applied disable stays in the audit log (D12).
    const actions = (await admin().select().from(auditLogs).where(eq(auditLogs.orgId, org.id))).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['portal.directory.identity.disable', 'organization.portal_user.identity.remove']));
  });
});
