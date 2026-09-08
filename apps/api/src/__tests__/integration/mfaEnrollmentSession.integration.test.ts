import './setup';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import postgres, { type Sql } from 'postgres';
import { describe, expect, it } from 'vitest';
import { withSystemDbAccessContext } from '../../db';
import { refreshTokenFamilies, users } from '../../db/schema';
import { authBindingRoutes } from '../../routes/auth/binding';
import { beginAuthIssuance } from '../../services/authBrowserTransition';
import {
  completeInitialMfaEnrollment,
  completeMfaFactorReplacement,
  replaceSessionOnMfaFactorWrite,
} from '../../services/mfaEnrollmentSession';
import { mintRefreshTokenFamily } from '../../services/refreshTokenFamily';
import { isUserTokenRevoked } from '../../services/tokenRevocation';
import type { UserSessionIdentity } from '../../services/userSession';
import { createPartner, createUser } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const DATABASE_URL = process.env.DATABASE_URL
  ?? 'postgresql://breeze_test:breeze_test@localhost:5433/breeze_test';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitForBlockedBackends(blockerPid: number, expected: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const rows = await getTestDb().execute<{ waiting: number }>(sql`
      WITH RECURSIVE wait_chain(pid) AS (
        SELECT pid
        FROM pg_catalog.pg_stat_activity
        WHERE datname = current_database()
          AND state = 'active'
          AND ${blockerPid} = ANY(pg_catalog.pg_blocking_pids(pid))
        UNION
        SELECT activity.pid
        FROM pg_catalog.pg_stat_activity activity
        JOIN wait_chain blocker
          ON blocker.pid = ANY(pg_catalog.pg_blocking_pids(activity.pid))
        WHERE activity.datname = current_database()
          AND activity.state = 'active'
      )
      SELECT count(*)::int AS waiting FROM wait_chain
    `);
    if ((rows[0]?.waiting ?? 0) >= expected) return;
    if (Date.now() > deadline) throw new Error('enrollment completions did not reach the user-row barrier');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function closeClient(client: Sql): Promise<void> {
  await client.end({ timeout: 1 });
}

async function freshBrowserCapability() {
  const response = await authBindingRoutes.request('/browser-binding/bootstrap', { method: 'POST' });
  expect(response.status).toBe(204);
  const cookie = response.headers.get('set-cookie') ?? '';
  const binding = /(?:^|,\s*)breeze_auth_binding=([0-9a-f]{64})/.exec(cookie)?.[1];
  if (!binding) throw new Error('bootstrap did not return an auth binding');
  return beginAuthIssuance({ kind: 'browser', value: binding });
}

async function fixture() {
  const partner = await createPartner();
  const user = await createUser({
    partnerId: partner.id,
    withMembership: true,
    email: `mfa-enrollment-${randomUUID()}@example.test`,
  });
  const identity: UserSessionIdentity = {
    userId: user.id,
    email: user.email,
    roleId: null,
    orgId: null,
    partnerId: partner.id,
    scope: 'partner',
    mfa: true,
  };
  const oldFamilyId = await mintRefreshTokenFamily(user.id);
  return { user, identity, oldFamilyId };
}

function completeTotpEnrollment(
  fixtureValue: Awaited<ReturnType<typeof fixture>>,
  capability: Awaited<ReturnType<typeof freshBrowserCapability>>,
  secret: string,
) {
  return withSystemDbAccessContext(() => completeInitialMfaEnrollment({
    userId: fixtureValue.user.id,
    identity: fixtureValue.identity,
    capability,
    expectedAuthEpoch: fixtureValue.user.authEpoch,
    expectedMfaEpoch: fixtureValue.user.mfaEpoch,
    revokeReason: 'integration-initial-mfa',
    recoveryCodes: [`code-${secret}`],
    recoveryCodeHashes: [`hash-${secret}`],
    persistFactor: async (tx, hashes) => {
      const rows = await tx.update(users).set({
        mfaEnabled: true,
        mfaMethod: 'totp',
        mfaSecret: secret,
        mfaRecoveryCodes: [...hashes],
        updatedAt: new Date(),
      }).where(eq(users.id, fixtureValue.user.id)).returning({ id: users.id });
      if (rows.length !== 1) throw new Error('factor write missed user');
      return secret;
    },
  }));
}

/** Unverified `iat` read — these tests own the token they just minted. */
function tokenIssuedAt(jwt: string): number {
  const [, payload] = jwt.split('.');
  if (!payload) throw new Error('not a JWT');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { iat?: number };
  if (typeof claims.iat !== 'number') throw new Error('token carries no iat');
  return claims.iat;
}

describe('completeInitialMfaEnrollment — real-PG atomicity', () => {
  runDb('rolls back epoch, family changes, replacement issuance, and factor together', async () => {
    const value = await fixture();
    const capability = await freshBrowserCapability();

    await expect(withSystemDbAccessContext(() => completeInitialMfaEnrollment({
      userId: value.user.id,
      identity: value.identity,
      capability,
      expectedAuthEpoch: value.user.authEpoch,
      expectedMfaEpoch: value.user.mfaEpoch,
      revokeReason: 'integration-rollback',
      recoveryCodes: ['plain-code'],
      recoveryCodeHashes: ['hash-code'],
      persistFactor: async (tx, hashes) => {
        await tx.update(users).set({
          mfaEnabled: true,
          mfaMethod: 'totp',
          mfaSecret: 'must-roll-back',
          mfaRecoveryCodes: [...hashes],
        }).where(eq(users.id, value.user.id));
        throw new Error('injected factor failure');
      },
    }))).rejects.toThrow('injected factor failure');

    const [after] = await getTestDb().select().from(users).where(eq(users.id, value.user.id)).limit(1);
    expect(after).toMatchObject({ mfaEnabled: false, mfaEpoch: value.user.mfaEpoch, mfaSecret: null });
    const families = await getTestDb().select().from(refreshTokenFamilies)
      .where(eq(refreshTokenFamilies.userId, value.user.id));
    expect(families).toHaveLength(1);
    expect(families[0]).toMatchObject({ familyId: value.oldFamilyId, revokedAt: null });
  });

  runDb('allows exactly one concurrent initial-factor completion', async () => {
    const value = await fixture();
    const [capabilityA, capabilityB] = await Promise.all([
      freshBrowserCapability(),
      freshBrowserCapability(),
    ]);
    const holder = postgres(DATABASE_URL, { max: 1, onnotice: () => undefined });
    const holderPid = (await holder<{ pid: number }[]>`SELECT pg_backend_pid()::int AS pid`)[0]?.pid;
    if (holderPid === undefined) throw new Error('could not determine barrier backend PID');
    const rowLocked = deferred();
    const release = deferred();
    let settled!: PromiseSettledResult<Awaited<ReturnType<typeof completeTotpEnrollment>>>[];

    try {
      const barrier = holder.begin(async (tx) => {
        await tx`SELECT id FROM users WHERE id = ${value.user.id} FOR UPDATE`;
        rowLocked.resolve();
        await release.promise;
      });
      await rowLocked.promise;
      const completions = Promise.allSettled([
        completeTotpEnrollment(value, capabilityA, 'secret-a'),
        completeTotpEnrollment(value, capabilityB, 'secret-b'),
      ]);
      await waitForBlockedBackends(holderPid, 2);
      release.resolve();
      await barrier;
      settled = await completions;
    } finally {
      release.resolve();
      await closeClient(holder);
    }

    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const losers = settled.filter((result) => result.status === 'rejected');
    expect(losers).toHaveLength(1);
    expect(losers[0]?.reason).toMatchObject({ name: 'AuthIssuanceConflictError' });

    const [after] = await getTestDb().select().from(users).where(eq(users.id, value.user.id)).limit(1);
    expect(after?.mfaEnabled).toBe(true);
    expect(after?.mfaEpoch).toBe(value.user.mfaEpoch + 1);
    expect(['secret-a', 'secret-b']).toContain(after?.mfaSecret);

    const families = await getTestDb().select().from(refreshTokenFamilies)
      .where(eq(refreshTokenFamilies.userId, value.user.id));
    expect(families.filter((family) => family.revokedAt === null)).toHaveLength(1);
    expect(families.find((family) => family.familyId === value.oldFamilyId)?.revokedAt).toBeInstanceOf(Date);
  });

  runDb('rejects enrollment when an auth-epoch cutoff commits while the request is waiting', async () => {
    const value = await fixture();
    const capability = await freshBrowserCapability();
    const holder = postgres(DATABASE_URL, { max: 1, onnotice: () => undefined });
    const holderPid = (await holder<{ pid: number }[]>`SELECT pg_backend_pid()::int AS pid`)[0]?.pid;
    if (holderPid === undefined) throw new Error('could not determine barrier backend PID');
    const rowLocked = deferred();
    const release = deferred();

    try {
      const cutoff = holder.begin(async (tx) => {
        await tx`SELECT id FROM users WHERE id = ${value.user.id} FOR UPDATE`;
        rowLocked.resolve();
        await release.promise;
        await tx`UPDATE users SET auth_epoch = auth_epoch + 1 WHERE id = ${value.user.id}`;
      });
      await rowLocked.promise;
      const enrollment = completeTotpEnrollment(value, capability, 'stale-secret');
      await waitForBlockedBackends(holderPid, 1);
      release.resolve();
      await cutoff;

      await expect(enrollment).rejects.toMatchObject({ name: 'AuthIssuanceConflictError' });
    } finally {
      release.resolve();
      await closeClient(holder);
    }

    const [after] = await getTestDb().select().from(users).where(eq(users.id, value.user.id)).limit(1);
    expect(after).toMatchObject({
      authEpoch: value.user.authEpoch + 1,
      mfaEpoch: value.user.mfaEpoch,
      mfaEnabled: false,
      mfaSecret: null,
    });
    const families = await getTestDb().select().from(refreshTokenFamilies)
      .where(eq(refreshTokenFamilies.userId, value.user.id));
    expect(families).toHaveLength(1);
    expect(families[0]).toMatchObject({ familyId: value.oldFamilyId, revokedAt: null });
  });
});


/**
 * #4480 — recovery-code rotation on an ALREADY-protected account. Same
 * primitive, `expectedMfaEnabled: true`: every other session must die and the
 * caller must leave holding a session that still works, because the response
 * body carries the one-time codes.
 */
describe('replaceSessionOnMfaFactorWrite — recovery-code rotation (#4480)', () => {
  runDb('evicts every other session and hands the caller a live replacement', async () => {
    const value = await fixture();
    // Get the account to the state a rotation starts from: MFA enrolled.
    const enrolled = await completeTotpEnrollment(value, await freshBrowserCapability(), 'enrolled-secret');
    const [afterEnroll] = await getTestDb().select().from(users).where(eq(users.id, value.user.id)).limit(1);
    if (!afterEnroll) throw new Error('enrolled user vanished');
    // A second device logs in after enrollment; the rotation must kill it.
    const otherDeviceFamilyId = await mintRefreshTokenFamily(value.user.id);
    const rotationCapability = await freshBrowserCapability();

    const rotated = await withSystemDbAccessContext(() => replaceSessionOnMfaFactorWrite({
      userId: value.user.id,
      identity: value.identity,
      capability: rotationCapability,
      expectedAuthEpoch: afterEnroll.authEpoch,
      expectedMfaEpoch: afterEnroll.mfaEpoch,
      expectedMfaEnabled: true,
      revokeReason: 'integration-recovery-rotate',
      recoveryCodes: ['rotated-code'],
      recoveryCodeHashes: ['rotated-hash'],
      persistFactor: async (tx, hashes) => {
        const rows = await tx.update(users)
          .set({ mfaRecoveryCodes: [...hashes], updatedAt: new Date() })
          .where(eq(users.id, value.user.id))
          .returning({ id: users.id });
        if (rows.length !== 1) throw new Error('rotation missed user');
        return undefined;
      },
    }));

    const [after] = await getTestDb().select().from(users).where(eq(users.id, value.user.id)).limit(1);
    // The factor survives; only its recovery-code set and the epoch moved.
    expect(after).toMatchObject({ mfaEnabled: true, mfaSecret: 'enrolled-secret' });
    expect(after?.mfaEpoch).toBe(afterEnroll.mfaEpoch + 1);
    expect(after?.mfaRecoveryCodes).toEqual(['rotated-hash']);

    const families = await getTestDb().select().from(refreshTokenFamilies)
      .where(eq(refreshTokenFamilies.userId, value.user.id));
    const live = families.filter((family) => family.revokedAt === null);
    // Exactly one family survives, and it is the one just minted for the caller.
    expect(live).toHaveLength(1);
    expect(live[0]?.familyId).toBe(rotated.issued.familyId);
    expect(rotated.issued.familyId).not.toBe(otherDeviceFamilyId);
    expect(rotated.issued.familyId).not.toBe(enrolled.issued.familyId);
    expect(families.find((family) => family.familyId === otherDeviceFamilyId)?.revokedAt).toBeInstanceOf(Date);
    expect(families.find((family) => family.familyId === enrolled.issued.familyId)?.revokedAt).toBeInstanceOf(Date);
    expect(families.find((family) => family.familyId === value.oldFamilyId)?.revokedAt).toBeInstanceOf(Date);

    // The OTHER half of the eviction is the Redis cutoff `runPostCommitCleanup`
    // writes, and /auth/refresh rejects any refresh token with
    // `iat <= revokedAfter`. Proven here against the real Redis this suite runs:
    // the cutoff is armed, and the replacement token clears it.
    //
    // Scope note — this does NOT discriminate the `preserveTokensIssuedAtOrAfter`
    // clamp on its own. On a fast run the mint and the cleanup land in the same
    // second, so the plain `now - 1` default already sits below the replacement's
    // `iat`; the clamp only decides the outcome once a commit stalls past a
    // second, which this test cannot force. The clamp's arithmetic is pinned by
    // `services/tokenRevocation.test.ts`. What this adds is that the two halves
    // are actually wired together end to end.
    expect(rotated.cleanup.redisOk).toBe(true);
    const replacementIat = tokenIssuedAt(rotated.issued.refreshToken);
    expect(await isUserTokenRevoked(value.user.id, replacementIat)).toBe(false);
    // ...and the cutoff is genuinely armed: anything predating the rotation is.
    expect(await isUserTokenRevoked(value.user.id, replacementIat - 60)).toBe(true);
  });

  runDb('refuses to rotate onto an account whose MFA was disabled underneath it', async () => {
    const value = await fixture();
    const [before] = await getTestDb().select().from(users).where(eq(users.id, value.user.id)).limit(1);
    if (!before) throw new Error('user vanished');
    // Never enrolled: mfa_enabled is false, so the expectedMfaEnabled: true
    // precondition must lose — no epoch bump, no revoke, no code write.
    const capability = await freshBrowserCapability();

    await expect(withSystemDbAccessContext(() => replaceSessionOnMfaFactorWrite({
      userId: value.user.id,
      identity: value.identity,
      capability,
      expectedAuthEpoch: before.authEpoch,
      expectedMfaEpoch: before.mfaEpoch,
      expectedMfaEnabled: true,
      revokeReason: 'integration-recovery-rotate-conflict',
      recoveryCodes: ['must-not-land'],
      recoveryCodeHashes: ['must-not-land-hash'],
      persistFactor: async () => undefined,
    }))).rejects.toMatchObject({ name: 'AuthIssuanceConflictError' });

    const [after] = await getTestDb().select().from(users).where(eq(users.id, value.user.id)).limit(1);
    expect(after?.mfaEpoch).toBe(before.mfaEpoch);
    expect(after?.mfaRecoveryCodes ?? null).toEqual(before.mfaRecoveryCodes ?? null);
    const families = await getTestDb().select().from(refreshTokenFamilies)
      .where(eq(refreshTokenFamilies.userId, value.user.id));
    expect(families.find((family) => family.familyId === value.oldFamilyId)?.revokedAt).toBeNull();
  });
});

/**
 * #5198: swapping the number behind a LIVE SMS factor. The unit suites prove the
 * shape (no code pair) and the route wiring, but both mock away Postgres — and
 * the claim this primitive actually makes is transactional: one commit advances
 * `mfa_epoch`, revokes every family, mints the caller's replacement, and writes
 * the new number, or none of it happens. That is only provable against real PG.
 */
describe('completeMfaFactorReplacement — swapping the material behind a live factor (#5198)', () => {
  /** Get the account to the state a phone replacement starts from: SMS-protected. */
  async function smsProtected() {
    const value = await fixture();
    const enrolled = await completeTotpEnrollment(value, await freshBrowserCapability(), 'enrolled-secret');
    await withSystemDbAccessContext(() => getTestDb().update(users).set({
      mfaMethod: 'sms',
      mfaSecret: null,
      phoneNumber: '+15555550100',
      phoneVerified: true,
    }).where(eq(users.id, value.user.id)));
    const [row] = await getTestDb().select().from(users).where(eq(users.id, value.user.id)).limit(1);
    if (!row) throw new Error('enrolled user vanished');
    return { value, enrolled, row };
  }

  runDb('evicts every other session, keeps the caller live, and leaves the recovery-code set alone', async () => {
    const { value, enrolled, row } = await smsProtected();
    // A second device logged in behind the old number; the swap must kill it.
    const otherDeviceFamilyId = await mintRefreshTokenFamily(value.user.id);
    const capability = await freshBrowserCapability();

    const replaced = await withSystemDbAccessContext(() => completeMfaFactorReplacement({
      userId: value.user.id,
      // Assurance is carried forward, never elevated — this caller's token was
      // NOT MFA-assured, so neither may the replacement.
      identity: { ...value.identity, mfa: false },
      capability,
      expectedAuthEpoch: row.authEpoch,
      expectedMfaEpoch: row.mfaEpoch,
      revokeReason: 'phone-replacement',
      persistFactor: async (tx) => {
        const rows = await tx.update(users)
          .set({ phoneNumber: '+15555550999', phoneVerified: true, updatedAt: new Date() })
          .where(eq(users.id, value.user.id))
          .returning({ id: users.id });
        if (rows.length !== 1) throw new Error('phone replacement missed user');
        return undefined;
      },
    }));

    const [after] = await getTestDb().select().from(users).where(eq(users.id, value.user.id)).limit(1);
    expect(after).toMatchObject({ mfaEnabled: true, mfaMethod: 'sms', phoneNumber: '+15555550999' });
    expect(after?.mfaEpoch).toBe(row.mfaEpoch + 1);
    // THE assertion that separates a replacement from a removal: the account's
    // existing recovery codes must survive. A `replace` mis-classified as a
    // codes-carrying write would persist `[]` here and silently destroy the
    // user's only lockout escape hatch.
    expect(after?.mfaRecoveryCodes).toEqual(row.mfaRecoveryCodes);
    expect((after?.mfaRecoveryCodes as string[] | null | undefined)?.length ?? 0).toBeGreaterThan(0);

    const families = await getTestDb().select().from(refreshTokenFamilies)
      .where(eq(refreshTokenFamilies.userId, value.user.id));
    const live = families.filter((family) => family.revokedAt === null);
    // Exactly one family survives, and it is the CALLER's replacement — the
    // whole point of #5198. Before it, zero survived and the actor was evicted.
    expect(live).toHaveLength(1);
    expect(live[0]?.familyId).toBe(replaced.issued.familyId);
    expect(families.find((family) => family.familyId === otherDeviceFamilyId)?.revokedAt).toBeInstanceOf(Date);
    expect(families.find((family) => family.familyId === enrolled.issued.familyId)?.revokedAt).toBeInstanceOf(Date);
    expect(families.find((family) => family.familyId === value.oldFamilyId)?.revokedAt).toBeInstanceOf(Date);

    // The Redis half of the eviction: the cutoff is armed against everything
    // that predates the swap, and the replacement token clears it.
    expect(replaced.cleanup.redisOk).toBe(true);
    const replacementIat = tokenIssuedAt(replaced.issued.refreshToken);
    expect(await isUserTokenRevoked(value.user.id, replacementIat)).toBe(false);
    expect(await isUserTokenRevoked(value.user.id, replacementIat - 60)).toBe(true);
  });

  runDb('rolls the phone write back with everything else when the factor write throws', async () => {
    const { value, row } = await smsProtected();
    const capability = await freshBrowserCapability();

    await expect(withSystemDbAccessContext(() => completeMfaFactorReplacement({
      userId: value.user.id,
      identity: value.identity,
      capability,
      expectedAuthEpoch: row.authEpoch,
      expectedMfaEpoch: row.mfaEpoch,
      revokeReason: 'phone-replacement-rollback',
      // Mirrors the route's `rows.length !== 1` guard: if the user row is gone
      // mid-transaction the whole commit must unwind, not half-apply.
      persistFactor: async (tx) => {
        await tx.update(users)
          .set({ phoneNumber: '+15555550999', updatedAt: new Date() })
          .where(eq(users.id, value.user.id));
        throw new Error('Phone replacement user disappeared');
      },
    }))).rejects.toThrow('Phone replacement user disappeared');

    const [after] = await getTestDb().select().from(users).where(eq(users.id, value.user.id)).limit(1);
    // Nothing landed: not the number, not the epoch.
    expect(after?.phoneNumber).toBe('+15555550100');
    expect(after?.mfaEpoch).toBe(row.mfaEpoch);
    const families = await getTestDb().select().from(refreshTokenFamilies)
      .where(eq(refreshTokenFamilies.userId, value.user.id));
    expect(families.filter((family) => family.revokedAt === null).length).toBeGreaterThan(0);
  });

  runDb('refuses to replace on an account whose factor was removed underneath it', async () => {
    const value = await fixture();
    const [before] = await getTestDb().select().from(users).where(eq(users.id, value.user.id)).limit(1);
    if (!before) throw new Error('user vanished');
    // Never enrolled: `expectedMfaEnabled: true` (fixed by the wrapper) must
    // lose — a replacement predicated on a factor that is gone writes nothing.
    const capability = await freshBrowserCapability();

    await expect(withSystemDbAccessContext(() => completeMfaFactorReplacement({
      userId: value.user.id,
      identity: value.identity,
      capability,
      expectedAuthEpoch: before.authEpoch,
      expectedMfaEpoch: before.mfaEpoch,
      revokeReason: 'phone-replacement-conflict',
      persistFactor: async () => { throw new Error('must never run'); },
    }))).rejects.toMatchObject({ name: 'AuthIssuanceConflictError' });

    const [after] = await getTestDb().select().from(users).where(eq(users.id, value.user.id)).limit(1);
    expect(after?.mfaEpoch).toBe(before.mfaEpoch);
    expect(after?.phoneNumber ?? null).toEqual(before.phoneNumber ?? null);
    const families = await getTestDb().select().from(refreshTokenFamilies)
      .where(eq(refreshTokenFamilies.userId, value.user.id));
    expect(families.find((family) => family.familyId === value.oldFamilyId)?.revokedAt).toBeNull();
  });
});
