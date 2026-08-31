import './setup';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  authBrowserTransitions,
  refreshTokenFamilies,
  roles,
  ssoProviders,
  ssoSessions,
  ssoTokenExchangeGrants,
  users,
} from '../../db/schema';
import {
  AuthBindingUnavailableError,
  AuthIssuanceCapabilityError,
  beginAuthIssuance,
  cancelAuthIssuance,
  finishAuthIssuance,
} from '../../services/authBrowserTransition';
import { revokeRefreshFamilyById } from '../../services/authLifecycle';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { issueUserSession } from '../../services/userSession';
import {
  claimSsoCallbackIssuance,
  consumeDurableSsoExchangeGrant,
  createDurableSsoExchangeGrant,
  digestSsoExchangeCode,
  lockSsoProviderAuthority,
} from '../../services/ssoBrowserTransition';
import {
  createOrganization,
  createPartner,
  createRole,
  createUser,
} from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

async function withTestSystemTransaction<T>(callback: (tx: any) => Promise<T>): Promise<T> {
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(() => db.transaction(callback)),
  );
}

async function freshBrowserBinding(): Promise<string> {
  try {
    await beginAuthIssuance({ kind: 'browser', value: '' });
  } catch (error) {
    const replacement = (error as { replacement?: { value?: string } }).replacement;
    if (replacement?.value) return replacement.value;
    throw error;
  }
  throw new Error('Missing binding did not produce a replacement');
}

async function waitForBlockedTransitionQueries(minimum: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const rows = await getTestDb().execute<{ blockedCount: number }>(sql`
      SELECT count(*)::int AS "blockedCount"
      FROM pg_catalog.pg_stat_activity
      WHERE datname = current_database()
        AND state = 'active'
        AND cardinality(pg_catalog.pg_blocking_pids(pid)) > 0
        AND position('auth_browser_transitions' in lower(query)) > 0
    `);
    if (Number(rows[0]?.blockedCount ?? 0) >= minimum) return;
    if (Date.now() > deadline) throw new Error(`Expected ${minimum} blocked transition queries`);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function waitForBlockedProviderQueries(minimum: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const rows = await getTestDb().execute<{ blockedCount: number }>(sql`
      SELECT count(*)::int AS "blockedCount"
      FROM pg_catalog.pg_stat_activity
      WHERE datname = current_database()
        AND state = 'active'
        AND cardinality(pg_catalog.pg_blocking_pids(pid)) > 0
        AND position('sso_providers' in lower(query)) > 0
    `);
    if (Number(rows[0]?.blockedCount ?? 0) >= minimum) return;
    if (Date.now() > deadline) throw new Error(`Expected ${minimum} blocked provider queries`);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function queueTransitionRacers<TFirst, TSecond>(
  transitionId: string,
  first: () => Promise<TFirst>,
  second: () => Promise<TSecond>,
): Promise<[Promise<TFirst>, Promise<TSecond>]> {
  let firstPromise!: Promise<TFirst>;
  let secondPromise!: Promise<TSecond>;
  await getTestDb().transaction(async (tx) => {
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

async function queueProviderRacers<TFirst, TSecond>(
  providerId: string,
  first: () => Promise<TFirst>,
  second: () => Promise<TSecond>,
): Promise<[Promise<TFirst>, Promise<TSecond>]> {
  let firstPromise!: Promise<TFirst>;
  let secondPromise!: Promise<TSecond>;
  await getTestDb().transaction(async (tx) => {
    await tx.execute(sql`
      SELECT id FROM sso_providers
      WHERE id = ${providerId}::uuid
      FOR UPDATE
    `);
    firstPromise = first();
    void firstPromise.catch(() => undefined);
    await waitForBlockedProviderQueries(1);
    secondPromise = second();
    void secondPromise.catch(() => undefined);
    await waitForBlockedProviderQueries(2);
  });
  return [firstPromise, secondPromise];
}

async function beginLogoutAndRevokeLinkedFamily(transitionId: string): Promise<void> {
  await withTestSystemTransaction(async (tx) => {
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
        logoutId: randomUUID(),
        completionNonceDigest: 'd'.repeat(64),
        logoutExpiresAt: sql`now() + interval '10 minutes'`,
        updatedAt: sql`now()`,
      })
      .where(eq(authBrowserTransitions.id, transition.id));

    if (transition.currentUserId && transition.currentFamilyId) {
      await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, transition.currentUserId))
        .for('update')
        .limit(1);
      await revokeRefreshFamilyById(tx, transition.currentFamilyId, 'terminal-logout');
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
    email: `sso-grant-${randomUUID()}@example.com`,
  });
  const capability = await beginAuthIssuance({
    kind: 'browser',
    value: await freshBrowserBinding(),
  });
  const finalized = await finishAuthIssuance(capability, async (tx) => {
    const issued = await issueUserSession({
      userId: user.id,
      email: user.email,
      roleId: role.id,
      orgId: org.id,
      partnerId: partner.id,
      scope: 'organization',
      mfa: false,
    }, {
      tx,
      capability,
      expectedEpochs: { authEpoch: user.authEpoch, mfaEpoch: user.mfaEpoch },
    });
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
  return { user, capability, ...finalized };
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
  const role = await createRole({
    scope: 'organization',
    partnerId: partner.id,
    orgId: org.id,
  });
  const user = await createUser({
    partnerId: partner.id,
    orgId: org.id,
    email: `sso-callback-${randomUUID()}@example.com`,
  });
  const snapshot = await beginAuthIssuance({
    kind: 'browser',
    value: await freshBrowserBinding(),
  });
  await cancelAuthIssuance(snapshot);
  const state = randomUUID();
  await getTestDb().insert(ssoSessions).values({
    providerId: provider.id,
    state,
    nonce: randomUUID(),
    codeVerifier: 'callback-state-verifier',
    redirectUrl: '/',
    providerVersion: provider.configVersion,
    browserTransitionId: snapshot.transitionId,
    browserGeneration: snapshot.generation,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  });
  return { snapshot, state, partner, org, provider, role, user };
}

async function finishProviderBoundCallback(
  fixture: Awaited<ReturnType<typeof createCallbackStateFixture>>,
  capability: Extract<Awaited<ReturnType<typeof claimSsoCallbackIssuance>>, { kind: 'login' }>['capability'],
) {
  return finishAuthIssuance(capability, async (tx) => {
    const issued = await issueUserSession({
      userId: fixture.user.id,
      email: fixture.user.email,
      roleId: fixture.role.id,
      orgId: fixture.org.id,
      partnerId: fixture.partner.id,
      scope: 'organization',
      mfa: false,
    }, {
      tx,
      capability,
      expectedEpochs: {
        authEpoch: fixture.user.authEpoch,
        mfaEpoch: fixture.user.mfaEpoch,
      },
    });
    const authority = await lockSsoProviderAuthority(tx, {
      providerId: fixture.provider.id,
      providerVersion: fixture.provider.configVersion,
      mode: 'login',
    });
    if (!authority.ok) throw new Error(`provider authority rejected: ${authority.reason}`);
    const code = await createDurableSsoExchangeGrant(tx, {
      capability,
      userId: fixture.user.id,
      familyId: issued.familyId,
      tokens: {
        accessToken: issued.accessToken,
        refreshToken: issued.refreshToken,
        expiresInSeconds: issued.expiresInSeconds,
      },
    });
    return { issued, code };
  });
}

async function disableProvider(providerId: string): Promise<void> {
  await getTestDb()
    .update(ssoProviders)
    .set({
      status: 'inactive',
      configVersion: sql`${ssoProviders.configVersion} + 1`,
      updatedAt: sql`now()`,
    })
    .where(eq(ssoProviders.id, providerId));
}

describe('durable SSO exchange authority', () => {
  runDb('stores only the code digest and consumes once across concurrent app callers', async () => {
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

  runDb('rejects expired, wrong-generation, and revoked-family grants', async () => {
    const expired = await createGrantFixture();
    await getTestDb().update(ssoTokenExchangeGrants).set({
      createdAt: sql`now() - interval '10 minutes'`,
      expiresAt: sql`now() - interval '5 minutes'`,
    }).where(eq(ssoTokenExchangeGrants.codeDigest, digestSsoExchangeCode(expired.code)));
    await expect(consumeDurableSsoExchangeGrant(expired.code)).resolves.toBeNull();

    const wrongGeneration = await createGrantFixture();
    await getTestDb().update(authBrowserTransitions)
      .set({ generation: sql`${authBrowserTransitions.generation} + 1` })
      .where(eq(authBrowserTransitions.id, wrongGeneration.capability.transitionId));
    await expect(consumeDurableSsoExchangeGrant(wrongGeneration.code)).resolves.toBeNull();

    const revoked = await createGrantFixture();
    await withTestSystemTransaction(async (tx) => {
      await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, revoked.user.id))
        .for('update')
        .limit(1);
      await revokeRefreshFamilyById(tx, revoked.issued.familyId, 'test-revocation');
    });
    await expect(consumeDurableSsoExchangeGrant(revoked.code)).resolves.toBeNull();
  });

  runDb('linearizes exchange before logout, then logout revokes the returned family', async () => {
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
    expect(family?.revokedAt).not.toBeNull();
  });

  runDb('linearizes logout before exchange and returns no token handoff', async () => {
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
  runDb('consumes state with admission so cancellation cannot make replay claimable', async () => {
    const fixture = await createCallbackStateFixture();
    const first = await claimSsoCallbackIssuance(fixture.state);
    expect(first?.kind).toBe('login');
    if (!first || first.kind !== 'login') throw new Error('Missing login claim');
    await cancelAuthIssuance(first.capability);

    expect(await getTestDb().select().from(ssoSessions)
      .where(eq(ssoSessions.state, fixture.state))).toHaveLength(0);
    await expect(claimSsoCallbackIssuance(fixture.state)).resolves.toBeNull();
  });

  runDb('leaves callback state untouched when terminal logout owns the transition first', async () => {
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

  runDb('consumes state first but finalizes no local write when logout takes ownership next', async () => {
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

  runDb('rejects finalization when provider disable wins before the guarded callback', async () => {
    const fixture = await createCallbackStateFixture();
    const admitted = await claimSsoCallbackIssuance(fixture.state);
    if (!admitted || admitted.kind !== 'login') throw new Error('Missing login claim');

    const [disable, callback] = await queueProviderRacers(
      fixture.provider.id,
      () => disableProvider(fixture.provider.id),
      () => finishProviderBoundCallback(fixture, admitted.capability),
    );

    await expect(disable).resolves.toBeUndefined();
    await expect(callback).rejects.toThrow('provider authority rejected: provider_inactive');
    await cancelAuthIssuance(admitted.capability);
    const [transition] = await getTestDb()
      .select({ currentFamilyId: authBrowserTransitions.currentFamilyId })
      .from(authBrowserTransitions)
      .where(eq(authBrowserTransitions.id, fixture.snapshot.transitionId));
    expect(transition?.currentFamilyId).toBeNull();
    expect(await getTestDb().select().from(ssoTokenExchangeGrants)
      .where(eq(ssoTokenExchangeGrants.browserTransitionId, fixture.snapshot.transitionId)))
      .toHaveLength(0);
  });

  runDb('commits callback authority before a queued provider disable', async () => {
    const fixture = await createCallbackStateFixture();
    const admitted = await claimSsoCallbackIssuance(fixture.state);
    if (!admitted || admitted.kind !== 'login') throw new Error('Missing login claim');

    const [callback, disable] = await queueProviderRacers(
      fixture.provider.id,
      () => finishProviderBoundCallback(fixture, admitted.capability),
      () => disableProvider(fixture.provider.id),
    );

    const finalized = await callback;
    await expect(disable).resolves.toBeUndefined();
    const [transition] = await getTestDb()
      .select({ currentFamilyId: authBrowserTransitions.currentFamilyId })
      .from(authBrowserTransitions)
      .where(eq(authBrowserTransitions.id, fixture.snapshot.transitionId));
    expect(transition?.currentFamilyId).toBe(finalized.issued.familyId);
    expect(await getTestDb().select().from(ssoTokenExchangeGrants)
      .where(eq(ssoTokenExchangeGrants.codeDigest, digestSsoExchangeCode(finalized.code))))
      .toHaveLength(1);
  });
});
