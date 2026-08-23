import './setup';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import postgres, { type Sql } from 'postgres';
import { describe, expect, it, vi } from 'vitest';
import { withSystemDbAccessContext } from '../../db';
import {
  authBrowserTransitions,
  refreshTokenFamilies,
  userPasskeys,
} from '../../db/schema';
import { authBindingRoutes } from '../../routes/auth/binding';
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
import { createPartner, createUser } from './db-utils';
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

async function waitForBackendBlockedBy(blockerPid: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const rows = await getTestDb().execute<{ waiting: number }>(sql`
      SELECT count(*)::int AS waiting
      FROM pg_catalog.pg_stat_activity
      WHERE datname = current_database()
        AND state = 'active'
        AND ${blockerPid} = ANY(pg_catalog.pg_blocking_pids(pid))
    `);
    if ((rows[0]?.waiting ?? 0) > 0) return;
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

async function fixture() {
  const partner = await createPartner();
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

      const logout = logoutClient.begin(async (tx) => tx`
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
      `);
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
