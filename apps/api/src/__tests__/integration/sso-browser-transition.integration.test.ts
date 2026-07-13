import { beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import './setup';
import { getTestDb } from './setup';
import {
  createOrganization,
  createPartner,
  createRole,
  createUser,
} from './db-utils';
import {
  authBrowserTransitions,
  refreshTokenFamilies,
  roles,
  ssoProviders,
  ssoSessions,
  ssoTokenExchangeGrants,
} from '../../db/schema';
import {
  AuthBindingRotationRequiredError,
  AuthBindingUnavailableError,
  AuthIssuanceCapabilityError,
  beginAuthIssuance,
  cancelAuthIssuance,
  finishAuthIssuance,
  resolveAuthBinding,
  type AuthBindingSource,
} from '../../services/authBrowserTransition';
import {
  revokeUserSessionFamily,
  withAuthLifecycleSystemTransaction,
} from '../../services/authLifecycle';
import { issueUserSession } from '../../services/userSession';
import {
  claimSsoCallbackIssuance,
  consumeDurableSsoExchangeGrant,
  createDurableSsoExchangeGrant,
  digestSsoExchangeCode,
} from '../../services/ssoBrowserTransition';

const CURRENT_KEY = 'integration-sso-browser-transition-current-key';

function freshBrowserBinding(): AuthBindingSource {
  try {
    resolveAuthBinding(undefined);
  } catch (error) {
    if (error instanceof AuthBindingRotationRequiredError) return error.replacement;
    throw error;
  }
  throw new Error('Missing binding did not produce a replacement');
}

async function waitForBlockedTransitionQueries(minimum: number): Promise<void> {
  const db = getTestDb();
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const rows = await db.execute(sql`
      SELECT count(*)::int AS blocked_count
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND usename = 'breeze_app'
        AND wait_event_type = 'Lock'
        AND position('auth_browser_transitions' in lower(query)) > 0
    `) as unknown as Array<{ blocked_count: number }>;
    if (Number(rows[0]?.blocked_count ?? 0) >= minimum) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Expected ${minimum} blocked transition queries`);
}

async function queueTransitionRacers<TFirst, TSecond>(
  transitionId: string,
  first: () => Promise<TFirst>,
  second: () => Promise<TSecond>,
): Promise<[Promise<TFirst>, Promise<TSecond>]> {
  const db = getTestDb();
  let firstPromise!: Promise<TFirst>;
  let secondPromise!: Promise<TSecond>;
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      SELECT id FROM auth_browser_transitions
      WHERE id = ${transitionId}::uuid
      FOR UPDATE
    `);
    firstPromise = first();
    void firstPromise.catch(() => undefined);
    await waitForBlockedTransitionQueries(1);
    secondPromise = second();
    void secondPromise.catch(() => undefined);
    await waitForBlockedTransitionQueries(2);
  });
  return [firstPromise, secondPromise];
}

async function beginLogoutAndRevokeLinkedFamily(transitionId: string): Promise<void> {
  await withAuthLifecycleSystemTransaction(async (tx) => {
    const [transition] = await tx
      .select({
        id: authBrowserTransitions.id,
        currentUserId: authBrowserTransitions.currentUserId,
        currentFamilyId: authBrowserTransitions.currentFamilyId,
      })
      .from(authBrowserTransitions)
      .where(eq(authBrowserTransitions.id, transitionId))
      .for('update')
      .limit(1);
    if (!transition) throw new Error('Missing browser transition');

    await tx
      .update(authBrowserTransitions)
      .set({
        state: 'logout_pending',
        generation: sql`${authBrowserTransitions.generation} + 1`,
        activeOperationId: null,
        activeOperationExpiresAt: null,
        logoutId: crypto.randomUUID(),
        completionNonceDigest: 'd'.repeat(64),
        logoutExpiresAt: sql`now() + interval '10 minutes'`,
        updatedAt: sql`now()`,
      })
      .where(eq(authBrowserTransitions.id, transition.id));

    if (transition.currentUserId && transition.currentFamilyId) {
      await revokeUserSessionFamily(
        tx,
        transition.currentUserId,
        transition.currentFamilyId,
        'terminal-logout',
      );
    }
  });
}

async function createGrantFixture() {
  const partner = await createPartner({ name: 'SSO Durable Grant Partner' });
  const org = await createOrganization({ partnerId: partner.id });
  const role = await createRole({
    scope: 'organization',
    partnerId: partner.id,
    orgId: org.id,
  });
  const user = await createUser({
    partnerId: partner.id,
    orgId: org.id,
    email: `sso-grant-${crypto.randomUUID()}@example.com`,
  });
  const capability = await beginAuthIssuance(freshBrowserBinding());
  const finalized = await finishAuthIssuance(capability, async (tx) => {
    const issued = await issueUserSession({
      userId: user.id,
      email: user.email,
      roleId: role.id,
      orgId: org.id,
      partnerId: partner.id,
      scope: 'organization',
      mfa: false,
      amr: ['sso'],
    }, { tx, capability });
    const code = await createDurableSsoExchangeGrant(tx, {
      capability,
      userId: user.id,
      familyId: issued.familyId,
      tokens: {
        accessToken: issued.accessToken,
        refreshToken: issued.refreshToken,
        expiresInSeconds: issued.expiresInSeconds,
      },
    });
    return { code, issued };
  });
  return { partner, org, role, user, capability, ...finalized };
}

async function createCallbackStateFixture() {
  const partner = await createPartner({ name: 'SSO Callback State Partner' });
  const org = await createOrganization({ partnerId: partner.id });
  const [provider] = await getTestDb()
    .insert(ssoProviders)
    .values({
      orgId: org.id,
      partnerId: null,
      name: 'SSO Callback State Provider',
      type: 'oidc',
      status: 'active',
      issuer: 'https://idp.example.test',
      clientId: 'callback-state-client',
      authorizationUrl: 'https://idp.example.test/authorize',
      tokenUrl: 'https://idp.example.test/token',
      userInfoUrl: 'https://idp.example.test/userinfo',
      jwksUrl: 'https://idp.example.test/jwks',
      autoProvision: false,
    })
    .returning();
  if (!provider) throw new Error('Missing SSO provider fixture');
  const snapshot = await beginAuthIssuance(freshBrowserBinding());
  if (!await cancelAuthIssuance(snapshot)) throw new Error('Failed to release snapshot lease');
  const state = crypto.randomUUID();
  await getTestDb().insert(ssoSessions).values({
    providerId: provider.id,
    state,
    nonce: crypto.randomUUID(),
    codeVerifier: 'callback-state-verifier',
    redirectUrl: '/',
    browserTransitionId: snapshot.transitionId,
    browserGeneration: snapshot.generation,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  });
  return { partner, org, provider, snapshot, state };
}

beforeEach(async () => {
  delete process.env.APP_ENCRYPTION_KEY;
  process.env.APP_ENCRYPTION_KEY_ID = 'current';
  process.env.APP_ENCRYPTION_KEYRING = JSON.stringify({ current: CURRENT_KEY });
  await getTestDb().insert(roles).values({
    name: 'Partner Admin',
    scope: 'partner',
    isSystem: true,
    partnerId: null,
  });
});

describe('durable SSO exchange authority', () => {
  it('stores only the code digest and consumes once across concurrent app callers', async () => {
    const fixture = await createGrantFixture();
    const [row] = await getTestDb().select().from(ssoTokenExchangeGrants);
    if (!row) throw new Error('Missing durable SSO grant fixture');
    expect(row.codeDigest).toBe(digestSsoExchangeCode(fixture.code));
    expect(JSON.stringify(row)).not.toContain(fixture.code);

    const results = await Promise.all([
      consumeDurableSsoExchangeGrant(fixture.code),
      consumeDurableSsoExchangeGrant(fixture.code),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.find(Boolean)).toEqual(expect.objectContaining({
      refreshToken: fixture.issued.refreshToken,
    }));
    await expect(consumeDurableSsoExchangeGrant(fixture.code)).resolves.toBeNull();
  });

  it('rejects an expired grant', async () => {
    const fixture = await createGrantFixture();
    await getTestDb()
      .update(ssoTokenExchangeGrants)
      .set({
        createdAt: sql`now() - interval '10 minutes'`,
        expiresAt: sql`now() - interval '5 minutes'`,
      })
      .where(eq(ssoTokenExchangeGrants.codeDigest, digestSsoExchangeCode(fixture.code)));
    await expect(consumeDurableSsoExchangeGrant(fixture.code)).resolves.toBeNull();
  });

  it('rejects a grant from the wrong browser generation', async () => {
    const fixture = await createGrantFixture();
    await getTestDb()
      .update(authBrowserTransitions)
      .set({ generation: sql`${authBrowserTransitions.generation} + 1` })
      .where(eq(authBrowserTransitions.id, fixture.capability.transitionId));
    await expect(consumeDurableSsoExchangeGrant(fixture.code)).resolves.toBeNull();
  });

  it('rejects a grant whose refresh family is revoked', async () => {
    const fixture = await createGrantFixture();
    await withAuthLifecycleSystemTransaction((tx) => revokeUserSessionFamily(
      tx,
      fixture.user.id,
      fixture.issued.familyId,
      'test-revocation',
    ));
    await expect(consumeDurableSsoExchangeGrant(fixture.code)).resolves.toBeNull();
  });

  it('linearizes exchange before logout, then logout revokes the returned family', async () => {
    const fixture = await createGrantFixture();
    const [exchange, logout] = await queueTransitionRacers(
      fixture.capability.transitionId,
      () => consumeDurableSsoExchangeGrant(fixture.code),
      () => beginLogoutAndRevokeLinkedFamily(fixture.capability.transitionId),
    );

    await expect(exchange).resolves.toEqual(expect.objectContaining({
      refreshToken: fixture.issued.refreshToken,
    }));
    await expect(logout).resolves.toBeUndefined();
    const [family] = await getTestDb()
      .select({ revokedAt: refreshTokenFamilies.revokedAt })
      .from(refreshTokenFamilies)
      .where(eq(refreshTokenFamilies.familyId, fixture.issued.familyId));
    if (!family) throw new Error('Missing refresh family fixture');
    expect(family.revokedAt).not.toBeNull();
  });

  it('linearizes logout before exchange and returns no token handoff', async () => {
    const fixture = await createGrantFixture();
    const [logout, exchange] = await queueTransitionRacers(
      fixture.capability.transitionId,
      () => beginLogoutAndRevokeLinkedFamily(fixture.capability.transitionId),
      () => consumeDurableSsoExchangeGrant(fixture.code),
    );

    await expect(logout).resolves.toBeUndefined();
    await expect(exchange).resolves.toBeNull();
  });
});

describe('durable SSO callback state claim', () => {
  it('consumes state with admission so cancellation cannot make replay claimable', async () => {
    const fixture = await createCallbackStateFixture();
    const first = await claimSsoCallbackIssuance(fixture.state);
    expect(first?.kind).toBe('login');
    if (!first || first.kind !== 'login') throw new Error('Missing login claim');
    await expect(cancelAuthIssuance(first.capability)).resolves.toBe(true);

    expect(await getTestDb().select().from(ssoSessions)
      .where(eq(ssoSessions.state, fixture.state))).toHaveLength(0);
    await expect(claimSsoCallbackIssuance(fixture.state)).resolves.toBeNull();
  });

  it('leaves callback state untouched when terminal logout owns the transition first', async () => {
    const fixture = await createCallbackStateFixture();
    const [logout, claim] = await queueTransitionRacers(
      fixture.snapshot.transitionId,
      () => beginLogoutAndRevokeLinkedFamily(fixture.snapshot.transitionId),
      () => claimSsoCallbackIssuance(fixture.state),
    );

    await expect(logout).resolves.toBeUndefined();
    await expect(claim).rejects.toBeInstanceOf(AuthBindingUnavailableError);
    expect(await getTestDb().select().from(ssoSessions)
      .where(eq(ssoSessions.state, fixture.state))).toHaveLength(1);
  });

  it('consumes state first but finalizes no local write when logout takes ownership next', async () => {
    const fixture = await createCallbackStateFixture();
    const [claim, logout] = await queueTransitionRacers(
      fixture.snapshot.transitionId,
      () => claimSsoCallbackIssuance(fixture.state),
      () => beginLogoutAndRevokeLinkedFamily(fixture.snapshot.transitionId),
    );

    const admitted = await claim;
    expect(admitted?.kind).toBe('login');
    await expect(logout).resolves.toBeUndefined();
    if (!admitted || admitted.kind !== 'login') throw new Error('Missing login claim');
    let localWrites = 0;
    await expect(finishAuthIssuance(admitted.capability, async () => {
      localWrites += 1;
    })).rejects.toBeInstanceOf(AuthIssuanceCapabilityError);
    expect(localWrites).toBe(0);
    expect(await getTestDb().select().from(ssoSessions)
      .where(eq(ssoSessions.state, fixture.state))).toHaveLength(0);
  });
});
