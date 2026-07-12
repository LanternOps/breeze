import { afterAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import './setup';
import { getTestDb } from './setup';
import {
  assignUserToPartner,
  createPartner,
  createRole,
  createUser,
} from './db-utils';
import { refreshTokenFamilies, users } from '../../db/schema';
import {
  PendingMfaInvalidError,
  createPendingMfa,
  issueVerifiedPendingMfaSession,
  readPendingMfa,
} from '../../services/mfaAssurance';
import { closeRedis, getRedis } from '../../services/redis';
import { runLockedMfaMutation } from '../../services/mfaAssuranceMutation';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitForBlockedRefreshFamilyInsert(): Promise<void> {
  const tdb = getTestDb();
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const rows = await tdb.execute(sql`
      SELECT count(*)::int AS blocked_count
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND usename = 'breeze_app'
        AND wait_event_type = 'Lock'
        AND position('insert into "refresh_token_families"' in lower(query)) > 0
    `) as unknown as Array<{ blocked_count: number }>;
    if (Number(rows[0]?.blocked_count ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Pending issuance never reached the blocked refresh-family insert');
}

describe('pending MFA issuance serialization against real PostgreSQL and Redis', () => {
  afterAll(async () => {
    await closeRedis();
  });

  it('waits for a locked epoch mutation, then rejects without creating a family', async () => {
    const tdb = getTestDb();
    const partner = await createPartner();
    const role = await createRole({ scope: 'partner', partnerId: partner.id });
    const user = await createUser({ partnerId: partner.id, mfaEnabled: true });
    await assignUserToPartner(user.id, partner.id, role.id, 'all');
    const [enrolledUser] = await tdb
      .update(users)
      .set({ mfaMethod: 'totp', mfaSecret: 'integration-encrypted-secret' })
      .where(eq(users.id, user.id))
      .returning();
    expect(enrolledUser).toBeDefined();
    if (!enrolledUser) throw new Error('Integration user enrollment update returned no row');

    const tempToken = await createPendingMfa({
      userId: user.id,
      authEpoch: enrolledUser.authEpoch,
      mfaEpoch: enrolledUser.mfaEpoch,
      expectedStatus: 'active',
      roleId: role.id,
      orgId: null,
      partnerId: partner.id,
      scope: 'partner',
      policyRequired: false,
      policySources: [],
      allowedMethods: new Set(['totp', 'sms', 'passkey', 'recovery_code']),
      enrolledMethods: new Set(['totp']),
      primaryAuthenticationMethod: 'password',
      configuredMfaMethod: 'totp',
      primaryMfaMethod: 'totp',
    });
    const expectedPending = await readPendingMfa(tempToken);
    expect(expectedPending).not.toBeNull();

    const mutationLocked = deferred();
    const allowMutationCommit = deferred();
    const mutation = runLockedMfaMutation({
      userId: user.id,
      partnerId: partner.id,
      authEpoch: enrolledUser.authEpoch,
      mfaEpoch: enrolledUser.mfaEpoch,
      reason: 'totp-factor-changed',
    }, async (tx) => {
      await tx.update(users).set({ updatedAt: new Date() }).where(eq(users.id, user.id));
      mutationLocked.resolve();
      await allowMutationCommit.promise;
    });
    await mutationLocked.promise;

    const issuance = issueVerifiedPendingMfaSession({
      tempToken,
      expectedPending: expectedPending!,
      verifiedMethod: 'totp',
    });
    const redis = getRedis();
    expect(redis).not.toBeNull();
    for (let attempt = 0; attempt < 100 && await redis!.exists(`mfa:pending:${tempToken}`); attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(await redis!.exists(`mfa:pending:${tempToken}`)).toBe(0);

    allowMutationCommit.resolve();
    await mutation;
    await expect(issuance).rejects.toBeInstanceOf(PendingMfaInvalidError);

    const families = await tdb
      .select({ familyId: refreshTokenFamilies.familyId })
      .from(refreshTokenFamilies)
      .where(eq(refreshTokenFamilies.userId, user.id));
    expect(families).toEqual([]);
  });

  it('lets an overlapping issuance that holds assurance locks commit before mutation without deadlock', async () => {
    const tdb = getTestDb();
    const partner = await createPartner();
    const role = await createRole({ scope: 'partner', partnerId: partner.id });
    const user = await createUser({ partnerId: partner.id, mfaEnabled: true });
    await assignUserToPartner(user.id, partner.id, role.id, 'all');
    const [enrolled] = await tdb.update(users).set({
      mfaMethod: 'totp', mfaSecret: 'integration-encrypted-secret',
    }).where(eq(users.id, user.id)).returning();
    if (!enrolled) throw new Error('Failed to seed issuance-first user');
    const tempToken = await createPendingMfa({
      userId: user.id, authEpoch: enrolled.authEpoch, mfaEpoch: enrolled.mfaEpoch,
      expectedStatus: 'active', roleId: role.id, orgId: null, partnerId: partner.id,
      scope: 'partner', policyRequired: false, policySources: [],
      allowedMethods: new Set(['totp', 'sms', 'passkey', 'recovery_code']),
      enrolledMethods: new Set(['totp']), primaryAuthenticationMethod: 'password',
      configuredMfaMethod: 'totp', primaryMfaMethod: 'totp',
    });
    const expectedPending = await readPendingMfa(tempToken);
    if (!expectedPending) throw new Error('Pending state missing');

    const tableLocked = deferred();
    const releaseTable = deferred();
    const blocker = tdb.transaction(async (tx) => {
      await tx.execute(sql`LOCK TABLE refresh_token_families IN ACCESS EXCLUSIVE MODE`);
      tableLocked.resolve();
      await releaseTable.promise;
    });
    await tableLocked.promise;

    const issuance = issueVerifiedPendingMfaSession({ tempToken, expectedPending, verifiedMethod: 'totp' });
    // Reaching this blocked INSERT proves issuance already acquired the shared
    // partner -> user -> factor locks. Starting mutation only after that point
    // makes this a deterministic issuance-first overlap instead of a sleep race.
    await waitForBlockedRefreshFamilyInsert();
    const mutation = runLockedMfaMutation({
      userId: user.id, partnerId: partner.id,
      authEpoch: enrolled.authEpoch, mfaEpoch: enrolled.mfaEpoch,
      reason: 'issuance-first-overlap',
    }, async () => undefined);
    releaseTable.resolve();
    await blocker;

    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('issuance-vs-mutation deadlock')), 5_000);
    });
    const [issued] = await Promise.race([Promise.all([issuance, mutation]), timeout]);
    const [afterUser] = await tdb.select().from(users).where(eq(users.id, user.id));
    expect(afterUser?.mfaEpoch).toBe(enrolled.mfaEpoch + 1);
    const [family] = await tdb.select().from(refreshTokenFamilies)
      .where(eq(refreshTokenFamilies.familyId, issued.tokens.familyId));
    expect(family?.revokedAt).not.toBeNull();
  });
});
