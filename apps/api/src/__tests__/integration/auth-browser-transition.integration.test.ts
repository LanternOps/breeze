import './setup';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import postgres, { type Sql } from 'postgres';
import { describe, expect, it, vi } from 'vitest';
import { withSystemDbAccessContext } from '../../db';
import {
  authBrowserTransitions,
  partners,
  refreshTokenFamilies,
  roles,
  users,
  userPasskeys,
} from '../../db/schema';
import { AUTH_BINDING_COOKIE_NAME, authBindingRoutes } from '../../routes/auth/binding';
import {
  AuthIssuanceCapabilityError,
  beginAuthIssuance,
  finishAuthIssuance,
} from '../../services/authBrowserTransition';
import {
  RefreshTokenCurrentnessError,
  digestRefreshTokenJti,
  mintRefreshTokenFamily,
} from '../../services/refreshTokenFamily';
import { invalidateMfaAssuranceAfterFactorChange } from '../../services/mfaAssurance';
import {
  issueUserSession,
  UserSessionEpochMismatchError,
  type UserSessionIdentity,
} from '../../services/userSession';
import {
  completeCfTerminalLogout,
  performOrdinaryTerminalLogout,
  prepareCfTerminalLogout,
} from '../../services/terminalLogout';
import {
  issueTerminalLogoutTicket,
  verifyTerminalLogoutTicket,
} from '../../services/terminalLogoutTicket';
import { advanceUserEpochs } from '../../services/authLifecycle';
import { createPartner as createRegistrationPartner } from '../../services/partnerCreate';
import { createPartner as createFixturePartner, createUser } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const DATABASE_URL = process.env.DATABASE_URL
  ?? 'postgresql://breeze_test:breeze_test@localhost:5433/breeze_test';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve'];
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function freshBrowserBinding(): Promise<string> {
  const response = await authBindingRoutes.request('/browser-binding/bootstrap', { method: 'POST' });
  expect(response.status).toBe(204);
  const cookie = response.headers.get('set-cookie') ?? '';
  const value = /(?:^|,\s*)breeze_auth_binding=([0-9a-f]{64})/.exec(cookie)?.[1];
  if (!value) throw new Error(`bootstrap did not return an auth binding: ${cookie}`);
  return value;
}

async function waitForBackendBlockedBy(blockerPid: number, expectedWaiters = 1): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const rows = await getTestDb().execute<{ waiting: number }>(sql`
      SELECT count(*)::int AS waiting
      FROM pg_catalog.pg_stat_activity
      WHERE datname = current_database()
        AND state = 'active'
        AND ${blockerPid} = ANY(pg_catalog.pg_blocking_pids(pid))
    `);
    if ((rows[0]?.waiting ?? 0) >= expectedWaiters) return;
    if (Date.now() > deadline) throw new Error('finalization did not block on the transition lock');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForBackendPidBlocked(backendPid: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const rows = await getTestDb().execute<{ waiting: boolean }>(sql`
      SELECT cardinality(pg_catalog.pg_blocking_pids(${backendPid})) > 0 AS waiting
    `);
    if (rows[0]?.waiting) return;
    if (Date.now() > deadline) throw new Error('logout did not block on the transition lock');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function closeClient(client: Sql): Promise<void> {
  await client.end({ timeout: 1 });
}

async function installTerminalRetireFailpoint(
  client: Sql,
  transitionId: string,
): Promise<() => Promise<void>> {
  const suffix = randomUUID().replaceAll('-', '');
  const functionName = `terminal_logout_failpoint_${suffix}`;
  const triggerName = `terminal_logout_failpoint_${suffix}`;

  await client.unsafe(`
    CREATE FUNCTION public.${functionName}() RETURNS trigger
    LANGUAGE plpgsql AS $failpoint$
    BEGIN
      RAISE EXCEPTION 'injected terminal transition failure';
    END
    $failpoint$
  `);
  try {
    await client.unsafe(`
      CREATE TRIGGER ${triggerName}
      BEFORE UPDATE ON auth_browser_transitions
      FOR EACH ROW
      WHEN (
        OLD.id = '${transitionId}'::uuid
        AND OLD.state = 'active'
        AND NEW.state = 'retired'
      )
      EXECUTE FUNCTION public.${functionName}()
    `);
  } catch (error) {
    await client.unsafe(`DROP FUNCTION IF EXISTS public.${functionName}()`);
    throw error;
  }

  return async () => {
    await client.unsafe(`DROP TRIGGER IF EXISTS ${triggerName} ON auth_browser_transitions`);
    await client.unsafe(`DROP FUNCTION IF EXISTS public.${functionName}()`);
  };
}

async function fixture() {
  const partner = await createFixturePartner();
  const user = await createUser({
    partnerId: partner.id,
    withMembership: true,
    email: `auth-transition-${randomUUID()}@example.test`,
  });
  const identity: UserSessionIdentity = {
    userId: user.id,
    email: user.email,
    roleId: null,
    orgId: null,
    partnerId: partner.id,
    scope: 'partner',
    mfa: false,
  };
  return { user, identity };
}

describe('guarded auth browser transition races', () => {
  runDb('ordinary terminal logout atomically revokes A/C and retires C1 with C2', async () => {
    const { user, identity } = await fixture();
    const binding = await freshBrowserBinding();
    const capability = await beginAuthIssuance({ kind: 'browser', value: binding });
    const issued = await finishAuthIssuance(capability, (tx) => issueUserSession(identity, {
      tx,
      capability,
      expectedEpochs: { authEpoch: user.authEpoch, mfaEpoch: user.mfaEpoch },
    }));

    const result = await performOrdinaryTerminalLogout({
      binding: { kind: 'browser', value: binding },
      access: {
        userId: user.id,
        authEpoch: user.authEpoch,
        mfaEpoch: user.mfaEpoch,
        familyId: issued.familyId,
      },
      refreshToken: null,
    });

    const [transition] = await getTestDb().select().from(authBrowserTransitions)
      .where(eq(authBrowserTransitions.id, capability.transitionId)).limit(1);
    const [family] = await getTestDb().select().from(refreshTokenFamilies)
      .where(eq(refreshTokenFamilies.familyId, issued.familyId)).limit(1);
    const [liveUser] = await getTestDb().select({ authEpoch: users.authEpoch }).from(users)
      .where(eq(users.id, user.id)).limit(1);
    expect(transition?.state).toBe('retired');
    expect(family?.revokedAt).toBeInstanceOf(Date);
    expect(liveUser?.authEpoch).toBe(user.authEpoch + 1);
    expect(result.replacement.kind).toBe('browser');
    expect(result.replacement.value).not.toBe(binding);
  });

  runDb('rolls back epochs, families, operation invalidation, and transition after a post-revocation failure', async () => {
    const { user, identity } = await fixture();
    const binding = await freshBrowserBinding();
    const issuance = await beginAuthIssuance({ kind: 'browser', value: binding });
    const issued = await finishAuthIssuance(issuance, (tx) => issueUserSession(identity, {
      tx,
      capability: issuance,
      expectedEpochs: { authEpoch: user.authEpoch, mfaEpoch: user.mfaEpoch },
    }));
    const activeOperation = await beginAuthIssuance({ kind: 'browser', value: binding });
    const failpointClient = postgres(DATABASE_URL, { max: 1, onnotice: () => undefined });
    let removeFailpoint: () => Promise<void> = async () => undefined;

    try {
      removeFailpoint = await installTerminalRetireFailpoint(
        failpointClient,
        issuance.transitionId,
      );
      let failure: unknown;
      try {
        await performOrdinaryTerminalLogout({
          binding: { kind: 'browser', value: binding },
          access: {
            userId: user.id,
            authEpoch: user.authEpoch,
            mfaEpoch: user.mfaEpoch,
            familyId: issued.familyId,
          },
          refreshToken: null,
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).cause).toBeInstanceOf(Error);
      expect(((failure as Error).cause as Error).message)
        .toContain('injected terminal transition failure');

      const [transition] = await getTestDb().select().from(authBrowserTransitions)
        .where(eq(authBrowserTransitions.id, issuance.transitionId)).limit(1);
      const [family] = await getTestDb().select().from(refreshTokenFamilies)
        .where(eq(refreshTokenFamilies.familyId, issued.familyId)).limit(1);
      const [liveUser] = await getTestDb().select({
        authEpoch: users.authEpoch,
        mfaEpoch: users.mfaEpoch,
      }).from(users).where(eq(users.id, user.id)).limit(1);
      expect(liveUser).toEqual({ authEpoch: user.authEpoch, mfaEpoch: user.mfaEpoch });
      expect(family?.revokedAt).toBeNull();
      expect(transition).toMatchObject({
        state: 'active',
        generation: activeOperation.generation,
        activeOperationId: activeOperation.operationId,
      });
    } finally {
      await removeFailpoint();
      await closeClient(failpointClient);
    }
  });

  runDb('a delayed C1 response after logout is inert and deterministically recovers C2', async () => {
    const { user, identity } = await fixture();
    const c1 = await freshBrowserBinding();
    const capability = await beginAuthIssuance({ kind: 'browser', value: c1 });
    const issuedBeforeDelayedResponse = await finishAuthIssuance(capability, (tx) => issueUserSession(identity, {
      tx,
      capability,
      expectedEpochs: { authEpoch: user.authEpoch, mfaEpoch: user.mfaEpoch },
    }));

    const logout = await performOrdinaryTerminalLogout({
      binding: { kind: 'browser', value: c1 },
      access: {
        userId: user.id,
        authEpoch: user.authEpoch,
        mfaEpoch: user.mfaEpoch,
        familyId: issuedBeforeDelayedResponse.familyId,
      },
      refreshToken: null,
    });

    // Model an already-issued response arriving late and overwriting the
    // browser's binding cookie with C1. Bootstrap cannot revive C1; it resolves
    // the retired row to the deterministic successor created by logout.
    const recovery = await authBindingRoutes.request('/browser-binding/bootstrap', {
      method: 'POST',
      headers: { cookie: `${AUTH_BINDING_COOKIE_NAME}=${c1}` },
    });
    expect(recovery.status).toBe(204);
    const recovered = new RegExp(`${AUTH_BINDING_COOKIE_NAME}=([0-9a-f]{64})`)
      .exec(recovery.headers.get('set-cookie') ?? '')?.[1];
    expect(recovered).toBe(logout.replacement.value);
    expect(recovered).not.toBe(c1);
  });

  runDb('two CF completions consume one nonce and return the same deterministic C2', async () => {
    const { user, identity } = await fixture();
    const binding = await freshBrowserBinding();
    const capability = await beginAuthIssuance({ kind: 'browser', value: binding });
    const issued = await finishAuthIssuance(capability, (tx) => issueUserSession(identity, {
      tx,
      capability,
      expectedEpochs: { authEpoch: user.authEpoch, mfaEpoch: user.mfaEpoch },
    }));
    const pending = await prepareCfTerminalLogout({
      binding: { kind: 'browser', value: binding },
      access: {
        userId: user.id,
        authEpoch: user.authEpoch,
        mfaEpoch: user.mfaEpoch,
        familyId: issued.familyId,
      },
      refreshToken: null,
    });
    const ticket = issueTerminalLogoutTicket({
      version: 1,
      audience: 'terminal-logout-completion',
      transitionId: pending.transitionId,
      logoutId: pending.logoutId,
      generation: pending.generation,
      nonce: pending.nonce,
      issuedAt: pending.issuedAt,
      expiresAt: pending.expiresAt,
    });
    const verified = verifyTerminalLogoutTicket(ticket);
    if (!verified) throw new Error('fresh terminal logout ticket did not verify');
    const completionInput = {
      transitionId: verified.claims.transitionId,
      logoutId: verified.claims.logoutId,
      generation: verified.claims.generation,
      nonce: verified.claims.nonce,
      signingKeyId: verified.signingKeyId,
    };
    const holder = postgres(DATABASE_URL, { max: 1, onnotice: () => undefined });
    const holderPid = (await holder<{ pid: number }[]>`
      SELECT pg_backend_pid()::int AS pid
    `)[0]?.pid;
    if (holderPid === undefined) throw new Error('could not determine completion barrier PID');
    const barrierReady = deferred<void>();
    const releaseBarrier = deferred<void>();
    let settled;
    try {
      const barrier = holder.begin(async (tx) => {
        await tx`
          SELECT id FROM auth_browser_transitions
          WHERE id = ${pending.transitionId}
          FOR UPDATE
        `;
        barrierReady.resolve();
        await releaseBarrier.promise;
      });
      await barrierReady.promise;
      const completions = Promise.all([
        completeCfTerminalLogout(completionInput),
        completeCfTerminalLogout(completionInput),
      ]);
      // The shared Drizzle pool may queue the second promise behind the first;
      // observing one backend blocked by our row lock is the deterministic
      // barrier proving completion cannot pass before both promises exist.
      await waitForBackendBlockedBy(holderPid);
      releaseBarrier.resolve();
      await barrier;
      settled = await completions;
    } finally {
      releaseBarrier.resolve();
      await closeClient(holder);
    }
    expect(settled.map((result) => result.kind).sort()).toEqual(['completed', 'replayed']);
    expect(settled[0]).toHaveProperty('replacement.value');
    expect(settled[1]).toHaveProperty('replacement.value');
    if (settled[0].kind === 'invalid' || settled[1].kind === 'invalid') {
      throw new Error('completion unexpectedly invalid');
    }
    expect(settled[0].replacement).toEqual(settled[1].replacement);

    const replay = await completeCfTerminalLogout(completionInput);
    expect(replay.kind).toBe('replayed');
  });

  runDb('allows at most one cross-binding registration account and session winner', async () => {
    const suffix = randomUUID();
    const email = `registration-race-${suffix}@example.test`;
    const companyName = `Registration Race ${suffix}`;
    await getTestDb().insert(roles).values({
      partnerId: null,
      scope: 'partner',
      name: 'Partner Admin',
      description: 'Registration concurrency fixture',
      isSystem: true,
    });
    const capabilityA = await beginAuthIssuance({ kind: 'browser', value: await freshBrowserBinding() });
    const capabilityB = await beginAuthIssuance({ kind: 'browser', value: await freshBrowserBinding() });
    const bothArrived = deferred<void>();
    const release = deferred<void>();
    let arrivals = 0;

    const finalize = (capability: typeof capabilityA) => finishAuthIssuance(capability, async (tx) => {
      arrivals += 1;
      if (arrivals === 2) bothArrived.resolve();
      await release.promise;

      const created = await createRegistrationPartner({
        orgName: companyName,
        adminEmail: email,
        adminName: 'Registration Race Admin',
        passwordHash: 'integration-test-password-hash',
        origin: { mcp: false },
        status: 'active',
      }, { tx });
      const [createdUser] = await tx
        .select({
          id: users.id,
          email: users.email,
          authEpoch: users.authEpoch,
          mfaEpoch: users.mfaEpoch,
        })
        .from(users)
        .where(eq(users.id, created.adminUserId))
        .limit(1);
      if (!createdUser) throw new Error('registration race winner user missing');
      const epochs = await advanceUserEpochs(tx, createdUser.id, { auth: true });
      const issued = await issueUserSession({
        userId: createdUser.id,
        email: createdUser.email,
        roleId: created.adminRoleId,
        orgId: created.orgId,
        partnerId: created.partnerId,
        scope: 'partner',
        mfa: true,
      }, {
        tx,
        capability,
        expectedEpochs: { authEpoch: epochs.authEpoch, mfaEpoch: epochs.mfaEpoch },
      });
      return { created, issued };
    });

    const first = finalize(capabilityA);
    const second = finalize(capabilityB);
    await bothArrived.promise;
    release.resolve();
    const settled = await Promise.allSettled([first, second]);

    if (settled.every((result) => result.status === 'rejected')) {
      throw new Error(`both registration finalizations rejected: ${settled.map((result) =>
        result.status === 'rejected'
          ? `${result.reason instanceof Error ? result.reason.name : typeof result.reason}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`
          : 'fulfilled').join(' | ')}`);
    }
    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const accountRows = await getTestDb()
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email));
    expect(accountRows).toHaveLength(1);
    const tenantRows = await getTestDb()
      .select({ id: partners.id })
      .from(partners)
      .where(eq(partners.billingEmail, email));
    expect(tenantRows).toHaveLength(1);
    const families = await getTestDb()
      .select({ id: refreshTokenFamilies.familyId })
      .from(refreshTokenFamilies)
      .where(eq(refreshTokenFamilies.userId, accountRows[0]!.id));
    expect(families).toHaveLength(1);
  });

  runDb('allows exactly one concurrent refresh successor after both finalizations reach a barrier', async () => {
    const { user, identity } = await fixture();
    const presentedJti = randomUUID();
    const familyId = await mintRefreshTokenFamily(user.id, presentedJti);
    const capabilityA = await beginAuthIssuance({ kind: 'browser', value: await freshBrowserBinding() });
    const capabilityB = await beginAuthIssuance({ kind: 'browser', value: await freshBrowserBinding() });
    const release = deferred<void>();
    const bothArrived = deferred<void>();
    let arrivals = 0;

    const rotate = (capability: typeof capabilityA) => finishAuthIssuance(capability, async (tx) => {
      arrivals += 1;
      if (arrivals === 2) bothArrived.resolve();
      await release.promise;
      return issueUserSession(identity, {
        tx,
        capability,
        expectedEpochs: { authEpoch: user.authEpoch, mfaEpoch: user.mfaEpoch },
        familyId,
        refreshRotation: {
          presentedJti,
        },
      });
    });

    const first = rotate(capabilityA);
    const second = rotate(capabilityB);
    await bothArrived.promise;
    release.resolve();
    const settled = await Promise.allSettled([first, second]);

    const winners = settled.filter((result): result is PromiseFulfilledResult<Awaited<typeof first>> =>
      result.status === 'fulfilled');
    const losers = settled.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]?.reason).toBeInstanceOf(RefreshTokenCurrentnessError);

    const [family] = await getTestDb()
      .select({ digest: refreshTokenFamilies.currentRefreshJtiDigest })
      .from(refreshTokenFamilies)
      .where(eq(refreshTokenFamilies.familyId, familyId))
      .limit(1);
    expect(family?.digest).toBe(digestRefreshTokenJti(winners[0]!.value.refreshJti));
  });

  runDb('serializes issuance-first: logout waits, then observes the committed session binding', async () => {
    const { user, identity } = await fixture();
    const capability = await beginAuthIssuance({ kind: 'browser', value: await freshBrowserBinding() });
    const issuedInside = deferred<void>();
    const releaseIssuance = deferred<void>();
    const logoutClient = postgres(DATABASE_URL, { max: 1, onnotice: () => undefined });
    const logoutPid = (await logoutClient<{ pid: number }[]>`
      SELECT pg_backend_pid()::int AS pid
    `)[0]?.pid;
    if (logoutPid === undefined) throw new Error('could not determine logout backend PID');
    const logoutId = randomUUID();

    try {
      const issuance = finishAuthIssuance(capability, async (tx) => {
        const issued = await issueUserSession(identity, {
          tx,
          capability,
          expectedEpochs: { authEpoch: user.authEpoch, mfaEpoch: user.mfaEpoch },
        });
        issuedInside.resolve();
        await releaseIssuance.promise;
        return issued;
      });
      await issuedInside.promise;

      const logout = logoutClient.begin(async (tx) => {
        const [transition] = await tx<{ current_family_id: string | null }[]>`
          SELECT current_family_id
          FROM auth_browser_transitions
          WHERE id = ${capability.transitionId}
          FOR UPDATE
        `;
        await tx`
          UPDATE auth_browser_transitions
          SET state = 'logout_pending',
              generation = generation + 1,
              active_operation_id = NULL,
              active_operation_expires_at = NULL,
              logout_id = ${logoutId},
              completion_nonce_digest = ${'a'.repeat(64)},
              logout_expires_at = now() + interval '5 minutes',
              updated_at = now()
          WHERE id = ${capability.transitionId}
        `;
        await tx`
        UPDATE refresh_token_families AS family
        SET revoked_at = COALESCE(family.revoked_at, now()),
            revoked_reason = COALESCE(family.revoked_reason, 'logout')
        WHERE family.family_id = ${transition?.current_family_id ?? null}
        `;
      });
      await waitForBackendPidBlocked(logoutPid);
      releaseIssuance.resolve();
      const issued = await issuance;
      await logout;

      const [transition] = await getTestDb()
        .select()
        .from(authBrowserTransitions)
        .where(eq(authBrowserTransitions.id, capability.transitionId))
        .limit(1);
      expect(transition).toMatchObject({
        state: 'logout_pending',
        currentUserId: user.id,
        currentFamilyId: issued.familyId,
      });
      const [family] = await getTestDb()
        .select({ revokedAt: refreshTokenFamilies.revokedAt })
        .from(refreshTokenFamilies)
        .where(eq(refreshTokenFamilies.familyId, issued.familyId))
        .limit(1);
      expect(family?.revokedAt).toBeInstanceOf(Date);
    } finally {
      releaseIssuance.resolve();
      await closeClient(logoutClient);
    }
  });

  runDb('serializes logout-first: finalization waits, then rejects before issuer side effects', async () => {
    const { identity } = await fixture();
    const capability = await beginAuthIssuance({ kind: 'browser', value: await freshBrowserBinding() });
    const holder = postgres(DATABASE_URL, { max: 1, onnotice: () => undefined });
    const holderPid = (await holder<{ pid: number }[]>`
      SELECT pg_backend_pid()::int AS pid
    `)[0]?.pid;
    if (holderPid === undefined) throw new Error('could not determine logout holder backend PID');
    const logoutWritten = deferred<void>();
    const releaseLogout = deferred<void>();
    const callback = vi.fn(async () => 'must-not-run');

    try {
      const logout = holder.begin(async (tx) => {
        await tx`
          UPDATE auth_browser_transitions
          SET state = 'logout_pending',
              generation = generation + 1,
              active_operation_id = NULL,
              active_operation_expires_at = NULL,
              logout_id = ${randomUUID()},
              completion_nonce_digest = ${'b'.repeat(64)},
              logout_expires_at = now() + interval '5 minutes',
              updated_at = now()
          WHERE id = ${capability.transitionId}
        `;
        logoutWritten.resolve();
        await releaseLogout.promise;
      });
      await logoutWritten.promise;
      const finalization = finishAuthIssuance(capability, callback);
      await waitForBackendBlockedBy(holderPid);
      releaseLogout.resolve();
      await logout;

      await expect(finalization).rejects.toBeInstanceOf(AuthIssuanceCapabilityError);
      expect(callback).not.toHaveBeenCalled();
      const families = await getTestDb()
        .select({ id: refreshTokenFamilies.familyId })
        .from(refreshTokenFamilies)
        .where(eq(refreshTokenFamilies.userId, identity.userId));
      expect(families).toEqual([]);
    } finally {
      releaseLogout.resolve();
      await closeClient(holder);
    }
  });

  runDb('lets a committed password change win over a verified password proof waiting to finalize', async () => {
    const { user, identity } = await fixture();
    const capability = await beginAuthIssuance({ kind: 'browser', value: await freshBrowserBinding() });
    const passwordWriter = postgres(DATABASE_URL, { max: 1, onnotice: () => undefined });
    const writerPid = (await passwordWriter<{ pid: number }[]>`
      SELECT pg_backend_pid()::int AS pid
    `)[0]?.pid;
    if (writerPid === undefined) throw new Error('could not determine password-writer backend PID');
    const passwordChanged = deferred<void>();
    const releasePasswordChange = deferred<void>();

    try {
      const change = passwordWriter.begin(async (tx) => {
        await tx`
          UPDATE users
          SET auth_epoch = auth_epoch + 1,
              password_changed_at = now(),
              updated_at = now()
          WHERE id = ${user.id}
        `;
        passwordChanged.resolve();
        await releasePasswordChange.promise;
      });
      await passwordChanged.promise;

      const finalization = finishAuthIssuance(capability, (tx) => issueUserSession(identity, {
        tx,
        capability,
        expectedEpochs: { authEpoch: user.authEpoch, mfaEpoch: user.mfaEpoch },
      }));
      await waitForBackendBlockedBy(writerPid);
      releasePasswordChange.resolve();
      await change;

      await expect(finalization).rejects.toBeInstanceOf(UserSessionEpochMismatchError);
      const families = await getTestDb()
        .select({ id: refreshTokenFamilies.familyId })
        .from(refreshTokenFamilies)
        .where(eq(refreshTokenFamilies.userId, user.id));
      expect(families).toEqual([]);
    } finally {
      releasePasswordChange.resolve();
      await closeClient(passwordWriter);
    }
  });

  runDb('lets passkey deletion win without deadlock when factor change reaches its mutation first', async () => {
    const { user, identity } = await fixture();
    const [passkey] = await getTestDb().insert(userPasskeys).values({
      userId: user.id,
      credentialId: `delete-wins-${randomUUID()}`,
      publicKey: 'dGVzdC1wdWJsaWMta2V5',
      counter: 0,
      deviceType: 'singleDevice',
      backedUp: false,
    }).returning();
    if (!passkey) throw new Error('failed to create passkey race fixture');

    const capability = await beginAuthIssuance({ kind: 'browser', value: await freshBrowserBinding() });
    const factorMutated = deferred<void>();
    const releaseFactorChange = deferred<void>();
    let factorPid: number | undefined;

    const factorChange = withSystemDbAccessContext(() =>
      invalidateMfaAssuranceAfterFactorChange(user.id, 'passkey-delete-race', async (tx) => {
        const pidRows = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid()::int AS pid`);
        factorPid = pidRows[0]?.pid;
        await tx.delete(userPasskeys).where(eq(userPasskeys.id, passkey.id));
        factorMutated.resolve();
        await releaseFactorChange.promise;
      })
    );

    try {
      await factorMutated.promise;
      if (factorPid === undefined) throw new Error('could not determine factor-change backend PID');
      const finalization = finishAuthIssuance(capability, async (tx) => {
        const issued = await issueUserSession(identity, {
          tx,
          capability,
          expectedEpochs: { authEpoch: user.authEpoch, mfaEpoch: user.mfaEpoch },
        });
        await tx.update(userPasskeys).set({ counter: 1 }).where(eq(userPasskeys.id, passkey.id));
        return issued;
      });
      await waitForBackendBlockedBy(factorPid);
      releaseFactorChange.resolve();
      await factorChange;

      await expect(finalization).rejects.toBeInstanceOf(UserSessionEpochMismatchError);
      const remaining = await getTestDb()
        .select({ id: userPasskeys.id })
        .from(userPasskeys)
        .where(eq(userPasskeys.id, passkey.id));
      expect(remaining).toEqual([]);
      const families = await getTestDb()
        .select({ id: refreshTokenFamilies.familyId })
        .from(refreshTokenFamilies)
        .where(eq(refreshTokenFamilies.userId, user.id));
      expect(families).toEqual([]);
    } finally {
      releaseFactorChange.resolve();
      await factorChange.catch(() => undefined);
    }
  });

  runDb('serializes passkey verify before deletion using user then family then passkey order', async () => {
    const { user, identity } = await fixture();
    const [passkey] = await getTestDb().insert(userPasskeys).values({
      userId: user.id,
      credentialId: `verify-wins-${randomUUID()}`,
      publicKey: 'dGVzdC1wdWJsaWMta2V5',
      counter: 0,
      deviceType: 'singleDevice',
      backedUp: false,
    }).returning();
    if (!passkey) throw new Error('failed to create passkey race fixture');

    const capability = await beginAuthIssuance({ kind: 'browser', value: await freshBrowserBinding() });
    const verifyMutated = deferred<void>();
    const releaseVerify = deferred<void>();
    let issuancePid: number | undefined;

    const finalization = finishAuthIssuance(capability, async (tx) => {
      const issued = await issueUserSession(identity, {
        tx,
        capability,
        expectedEpochs: { authEpoch: user.authEpoch, mfaEpoch: user.mfaEpoch },
      });
      const pidRows = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid()::int AS pid`);
      issuancePid = pidRows[0]?.pid;
      await tx.update(userPasskeys).set({ counter: 1 }).where(eq(userPasskeys.id, passkey.id));
      verifyMutated.resolve();
      await releaseVerify.promise;
      return issued;
    });

    try {
      await verifyMutated.promise;
      if (issuancePid === undefined) throw new Error('could not determine issuance backend PID');
      const factorChange = withSystemDbAccessContext(() =>
        invalidateMfaAssuranceAfterFactorChange(user.id, 'passkey-delete-after-verify', async (tx) => {
          await tx.delete(userPasskeys).where(eq(userPasskeys.id, passkey.id));
        })
      );
      await waitForBackendBlockedBy(issuancePid);
      releaseVerify.resolve();
      const issued = await finalization;
      await factorChange;

      const [family] = await getTestDb()
        .select()
        .from(refreshTokenFamilies)
        .where(eq(refreshTokenFamilies.familyId, issued.familyId))
        .limit(1);
      expect(family?.revokedReason).toBe('passkey-delete-after-verify');
      const remaining = await getTestDb()
        .select({ id: userPasskeys.id })
        .from(userPasskeys)
        .where(eq(userPasskeys.id, passkey.id));
      expect(remaining).toEqual([]);
    } finally {
      releaseVerify.resolve();
      await finalization.catch(() => undefined);
    }
  });
});
