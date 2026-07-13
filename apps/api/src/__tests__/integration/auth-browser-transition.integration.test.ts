import { beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import './setup';
import { getTestDb } from './setup';
import {
  authBrowserTransitions,
  refreshTokenFamilies,
  roles,
  users,
} from '../../db/schema';
import {
  createOrganization,
  createPartner,
  createRole,
  createUser,
} from './db-utils';
import {
  AuthBindingRotationRequiredError,
  AuthIssuanceConflictError,
  beginAuthIssuance,
  createAuthBrowserTransitionService,
  finishAuthIssuance,
  resolveAuthBinding,
  rotateExpiredBinding,
  type AuthBindingSource,
} from '../../services/authBrowserTransition';
import { getSecretDerivedKeyMaterials } from '../../services/secretCrypto';
import { issueUserSession } from '../../services/userSession';
import { prepareTerminalLogout } from '../../services/terminalLogout';
import { verifyToken } from '../../services/jwt';
import {
  classifyRefreshTokenAuthority,
  isAccessSessionFamilyActive,
} from '../../services/tokenRevocation';
import { withAuthLifecycleSystemTransaction } from '../../services/authLifecycle';

const CURRENT_KEY = 'integration-browser-binding-current-key-material';
const OLD_KEY = 'integration-browser-binding-old-key-material';

function freshBrowserBinding(): AuthBindingSource {
  try {
    resolveAuthBinding(undefined);
  } catch (error) {
    if (error instanceof AuthBindingRotationRequiredError) return error.replacement;
    throw error;
  }
  throw new Error('Missing binding did not produce a replacement');
}

async function waitForBlockedTransitionQueries(minimum = 1): Promise<void> {
  const db = getTestDb();
  for (let attempt = 0; attempt < 200; attempt += 1) {
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
  throw new Error(`Expected ${minimum} blocked auth-browser transition queries`);
}

async function waitForBlockedAppQuery(
  tableName: 'auth_browser_transitions' | 'users',
  settled?: () => unknown,
): Promise<void> {
  const db = getTestDb();
  for (let attempt = 0; attempt < 5_000; attempt += 1) {
    const rows = await db.execute(sql`
      SELECT count(*)::int AS blocked_count
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND usename = 'breeze_app'
        AND cardinality(pg_blocking_pids(pid)) > 0
        AND position(${tableName} in lower(query)) > 0
    `) as unknown as Array<{ blocked_count: number }>;
    if (Number(rows[0]?.blocked_count ?? 0) > 0) return;
    const outcome = settled?.();
    if (outcome !== undefined) {
      throw new Error(`Expected a breeze_app query blocked on ${tableName}, but it settled: ${String(outcome)}`);
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`Expected a breeze_app query blocked on ${tableName}`);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function issueTestSession(input: {
  binding: AuthBindingSource;
  user: Awaited<ReturnType<typeof createUser>>;
  partnerId: string;
  orgId: string;
  roleId: string;
}) {
  const capability = await beginAuthIssuance(input.binding);
  const tokens = await finishAuthIssuance(capability, (tx) => issueUserSession({
    userId: input.user.id,
    email: input.user.email,
    roleId: input.roleId,
    orgId: input.orgId,
    partnerId: input.partnerId,
    scope: 'organization',
    mfa: false,
    amr: ['password'],
  }, { tx, capability }));
  return { capability, tokens };
}

async function terminalFixture() {
  const db = getTestDb();
  if ((await db.select().from(roles)).length === 0) {
    await db.insert(roles).values({
      name: 'Partner Admin', scope: 'partner', isSystem: true, partnerId: null,
    });
  }
  const partner = await createPartner({ name: 'Terminal Transition Partner' });
  const org = await createOrganization({ partnerId: partner.id });
  const role = await createRole({ scope: 'organization', partnerId: partner.id, orgId: org.id });
  const userA = await createUser({
    partnerId: partner.id,
    orgId: org.id,
    email: `terminal-a-${crypto.randomUUID()}@example.com`,
  });
  const userC = await createUser({
    partnerId: partner.id,
    orgId: org.id,
    email: `terminal-c-${crypto.randomUUID()}@example.com`,
  });
  const bindingA = freshBrowserBinding();
  const sessionA = await issueTestSession({
    binding: bindingA,
    user: userA,
    partnerId: partner.id,
    orgId: org.id,
    roleId: role.id,
  });
  const accessPayload = await verifyToken(sessionA.tokens.accessToken);
  if (!accessPayload?.sid) throw new Error('Failed to mint access authority fixture');
  const bindingC = freshBrowserBinding();
  const capabilityC = await beginAuthIssuance(bindingC);
  return { partner, org, role, userA, userC, sessionA, accessPayload, bindingC, capabilityC };
}

beforeEach(() => {
  delete process.env.APP_ENCRYPTION_KEY;
  process.env.APP_ENCRYPTION_KEY_ID = 'current';
  process.env.APP_ENCRYPTION_KEYRING = JSON.stringify({ current: CURRENT_KEY });
});

describe('auth browser transition leases against PostgreSQL', () => {
  it('finalizes a lease whose database timestamp contains sub-millisecond precision', async () => {
    const db = getTestDb();
    const binding = freshBrowserBinding();
    const capability = await beginAuthIssuance(binding);

    const precision = await db.execute(sql`
      UPDATE auth_browser_transitions
      SET active_operation_expires_at =
        date_trunc('milliseconds', active_operation_expires_at) + interval '321 microseconds'
      WHERE id = ${capability.transitionId}::uuid
      RETURNING extract(microseconds FROM active_operation_expires_at)::bigint AS micros
    `) as unknown as Array<{ micros: string }>;
    expect(BigInt(precision[0]!.micros) % 1000n).toBe(321n);

    await expect(finishAuthIssuance(capability, async () => 'committed')).resolves.toBe(
      'committed',
    );

    const [row] = await db
      .select()
      .from(authBrowserTransitions)
      .where(eq(authBrowserTransitions.id, capability.transitionId));
    expect(row).toMatchObject({
      activeOperationId: null,
      activeOperationExpiresAt: null,
    });
  });

  it('serializes expired lease replacement behind the transition row lock', async () => {
    const db = getTestDb();
    const binding = freshBrowserBinding();
    const stale = await beginAuthIssuance(binding);
    await db.execute(sql`
      UPDATE auth_browser_transitions
      SET active_operation_expires_at = now() - interval '1 second'
      WHERE id = ${stale.transitionId}::uuid
    `);

    let settled = false;
    let replacementPromise!: Promise<Awaited<ReturnType<typeof beginAuthIssuance>>>;
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        SELECT id
        FROM auth_browser_transitions
        WHERE id = ${stale.transitionId}::uuid
        FOR UPDATE
      `);
      replacementPromise = beginAuthIssuance(binding);
      void replacementPromise.then(
        () => { settled = true; },
        () => { settled = true; },
      );
      await waitForBlockedTransitionQueries();
      expect(settled).toBe(false);
    });

    const replacement = await replacementPromise;
    expect(replacement.operationId).not.toBe(stale.operationId);
    const [row] = await db
      .select()
      .from(authBrowserTransitions)
      .where(eq(authBrowserTransitions.id, stale.transitionId));
    expect(row?.activeOperationId).toBe(replacement.operationId);
  });

  it('forces concurrent retired-C1 rotations to return the same cookie and one active C2 row', async () => {
    const db = getTestDb();
    const c1 = freshBrowserBinding();
    const admission = await beginAuthIssuance(c1);
    await db.execute(sql`
      UPDATE auth_browser_transitions
      SET state = 'retired',
          active_operation_id = NULL,
          active_operation_expires_at = NULL,
          retired_at = now(),
          updated_at = now()
      WHERE id = ${admission.transitionId}::uuid
    `);

    let rotations!: Array<Promise<AuthBindingSource>>;
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        SELECT id
        FROM auth_browser_transitions
        WHERE id = ${admission.transitionId}::uuid
        FOR UPDATE
      `);
      rotations = [rotateExpiredBinding(c1), rotateExpiredBinding(c1)];
      await waitForBlockedTransitionQueries(2);
    });

    const [left, right] = await Promise.all(rotations);
    if (!left || !right) throw new Error('Concurrent rotations did not both complete');
    expect(left).toEqual(right);
    expect(left.value).not.toBe(c1.value);

    const rows = await db.select().from(authBrowserTransitions);
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.state === 'retired')).toHaveLength(1);
    const activeRows = rows.filter((row) => row.state === 'active');
    expect(activeRows).toHaveLength(1);
    expect(activeRows[0]?.bindingDigest).toBe(resolveAuthBinding(left).bindingDigest);
  });

  it('canonicalizes concurrent first admission across old-active and new-active replicas', async () => {
    const db = getTestDb();
    process.env.APP_ENCRYPTION_KEYRING = JSON.stringify({
      old: OLD_KEY,
      current: CURRENT_KEY,
    });
    process.env.APP_ENCRYPTION_KEY_ID = 'old';
    const oldActiveMaterials = getSecretDerivedKeyMaterials('auth-browser-binding:v1');
    process.env.APP_ENCRYPTION_KEY_ID = 'current';
    const newActiveMaterials = getSecretDerivedKeyMaterials('auth-browser-binding:v1');
    const oldReplica = createAuthBrowserTransitionService(() => oldActiveMaterials);
    const newReplica = createAuthBrowserTransitionService(() => newActiveMaterials);
    let binding!: AuthBindingSource;
    try {
      oldReplica.resolveAuthBinding(undefined);
    } catch (error) {
      if (!(error instanceof AuthBindingRotationRequiredError)) throw error;
      binding = error.replacement;
    }

    expect(oldReplica.resolveAuthBinding(binding).bindingDigest).toBe(
      newReplica.resolveAuthBinding(binding).bindingDigest,
    );

    type Outcome =
      | { kind: 'capability'; value: Awaited<ReturnType<typeof beginAuthIssuance>> }
      | { kind: 'error'; error: unknown };
    let admissions!: Array<Promise<Outcome>>;
    await db.transaction(async (tx) => {
      await tx.execute(sql`LOCK TABLE auth_browser_transitions IN SHARE MODE`);
      admissions = [oldReplica, newReplica].map((replica) =>
        replica.beginAuthIssuance(binding).then(
          (value): Outcome => ({ kind: 'capability', value }),
          (error): Outcome => ({ kind: 'error', error }),
        ),
      );
      await waitForBlockedTransitionQueries(2);
    });

    const outcomes = await Promise.all(admissions);
    const capabilities = outcomes.filter(
      (outcome): outcome is Extract<Outcome, { kind: 'capability' }> =>
        outcome.kind === 'capability',
    );
    const errors = outcomes.filter(
      (outcome): outcome is Extract<Outcome, { kind: 'error' }> => outcome.kind === 'error',
    );
    expect(capabilities).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.error).toBeInstanceOf(AuthIssuanceConflictError);

    const rows = await db.select().from(authBrowserTransitions);
    expect(rows).toHaveLength(1);
    expect(capabilities[0]?.value.transitionId).toBe(rows[0]?.id);
    expect(rows[0]?.bindingDigest).toBe(oldReplica.resolveAuthBinding(binding).bindingDigest);
    expect(rows[0]?.bindingDigest).toBe(newReplica.resolveAuthBinding(binding).bindingDigest);
  });

  it('forces concurrent expired logout-pending rotations to one C2 lineage', async () => {
    const db = getTestDb();
    const c1 = freshBrowserBinding();
    const admission = await beginAuthIssuance(c1);
    await db.execute(sql`
      UPDATE auth_browser_transitions
      SET state = 'logout_pending',
          generation = generation + 1,
          active_operation_id = NULL,
          active_operation_expires_at = NULL,
          logout_id = '30000000-0000-4000-8000-000000000001'::uuid,
          completion_nonce_digest = ${'a'.repeat(64)},
          updated_at = now() - interval '2 minutes',
          logout_expires_at = now() - interval '1 minute'
      WHERE id = ${admission.transitionId}::uuid
    `);

    let rotations!: Array<Promise<AuthBindingSource>>;
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        SELECT id
        FROM auth_browser_transitions
        WHERE id = ${admission.transitionId}::uuid
        FOR UPDATE
      `);
      rotations = [rotateExpiredBinding(c1), rotateExpiredBinding(c1)];
      await waitForBlockedTransitionQueries(2);
    });

    const [left, right] = await Promise.all(rotations);
    if (!left || !right) throw new Error('Concurrent rotations did not both complete');
    expect(left).toEqual(right);
    const rows = await db.select().from(authBrowserTransitions);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === admission.transitionId)?.state).toBe('retired');
    expect(rows.filter((row) => row.state === 'active')).toHaveLength(1);
  });

  it('commits or rolls back callback writes atomically with operation clearing', async () => {
    const db = getTestDb();
    const binding = freshBrowserBinding();
    const capability = await beginAuthIssuance(binding);
    const markerDigest = '9'.repeat(64);

    await expect(finishAuthIssuance(capability, async (tx) => {
      await tx.insert(authBrowserTransitions).values({ bindingDigest: markerDigest });
      throw new Error('rollback marker');
    })).rejects.toThrow('rollback marker');

    expect(await db
      .select()
      .from(authBrowserTransitions)
      .where(eq(authBrowserTransitions.bindingDigest, markerDigest))).toHaveLength(0);
    const [leasedAfterRollback] = await db
      .select()
      .from(authBrowserTransitions)
      .where(eq(authBrowserTransitions.id, capability.transitionId));
    expect(leasedAfterRollback?.activeOperationId).toBe(capability.operationId);

    await finishAuthIssuance(capability, async (tx) => {
      await tx.insert(authBrowserTransitions).values({ bindingDigest: markerDigest });
    });

    expect(await db
      .select()
      .from(authBrowserTransitions)
      .where(eq(authBrowserTransitions.bindingDigest, markerDigest))).toHaveLength(1);
    const [clearedAfterCommit] = await db
      .select()
      .from(authBrowserTransitions)
      .where(eq(authBrowserTransitions.id, capability.transitionId));
    expect(clearedAfterCommit).toMatchObject({
      activeOperationId: null,
      activeOperationExpiresAt: null,
    });
  });
});

describe('terminal preparation against issuer finalization', () => {
  it('waits behind an issuer that owns transition first, then revokes its linked C family', async () => {
    const fixture = await terminalFixture();
    const issuerEntered = deferred();
    const releaseIssuer = deferred();
    const issuer = finishAuthIssuance(fixture.capabilityC, async (tx) => {
      issuerEntered.resolve();
      await releaseIssuer.promise;
      return issueUserSession({
        userId: fixture.userC.id,
        email: fixture.userC.email,
        roleId: fixture.role.id,
        orgId: fixture.org.id,
        partnerId: fixture.partner.id,
        scope: 'organization',
        mfa: false,
        amr: ['password'],
      }, { tx, capability: fixture.capabilityC });
    });
    await issuerEntered.promise;

    const prepare = prepareTerminalLogout({
      binding: fixture.bindingC,
      access: {
        userId: fixture.userA.id,
        familyId: fixture.accessPayload.sid!,
        authEpoch: fixture.accessPayload.ae,
        mfaEpoch: fixture.accessPayload.me,
      },
      refreshToken: fixture.sessionA.tokens.refreshToken,
    });
    void prepare.catch(() => undefined);
    await waitForBlockedAppQuery('auth_browser_transitions');
    releaseIssuer.resolve();

    const issuedC = await issuer;
    const prepared = await prepare;
    expect(prepared.subjectIds).toEqual([fixture.userA.id]);
    const [linkedFamily] = await getTestDb()
      .select()
      .from(refreshTokenFamilies)
      .where(eq(refreshTokenFamilies.familyId, issuedC.familyId));
    expect(linkedFamily).toMatchObject({
      userId: fixture.userC.id,
      revokedReason: 'cf-access-terminal-logout',
    });
    await expect(isAccessSessionFamilyActive(
      fixture.accessPayload.sid!,
      fixture.userA.id,
    )).resolves.toBe(false);
    await expect(withAuthLifecycleSystemTransaction((tx) =>
      classifyRefreshTokenAuthority(tx, issuedC.refreshToken)))
      .resolves.toEqual({ kind: 'invalid' });
  });

  it('wins transition first so a waiting issuer rejects without family writes', async () => {
    const fixture = await terminalFixture();
    // Before issuer finalization, C is not yet linked to the transition. The
    // prepare candidate set therefore contains only bearer/refresh user A.
    const firstUserId = fixture.userA.id;
    const blockerHeld = deferred();
    const releaseBlocker = deferred();
    const blocker = getTestDb().transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM users WHERE id = ${firstUserId}::uuid FOR UPDATE`);
      blockerHeld.resolve();
      await releaseBlocker.promise;
    });
    await blockerHeld.promise;

    let prepare: ReturnType<typeof prepareTerminalLogout> | undefined;
    let issuer: ReturnType<typeof finishAuthIssuance> | undefined;
    try {
      let prepareOutcome: unknown;
      prepare = prepareTerminalLogout({
        binding: fixture.bindingC,
        access: {
          userId: fixture.userA.id,
          familyId: fixture.accessPayload.sid!,
          authEpoch: fixture.accessPayload.ae,
          mfaEpoch: fixture.accessPayload.me,
        },
        refreshToken: fixture.sessionA.tokens.refreshToken,
      });
      void prepare.then(
        () => { prepareOutcome = 'resolved'; },
        (error) => { prepareOutcome = error; },
      );
      await waitForBlockedAppQuery('users', () => prepareOutcome);

      issuer = finishAuthIssuance(fixture.capabilityC, (tx) => issueUserSession({
        userId: fixture.userC.id,
        email: fixture.userC.email,
        roleId: fixture.role.id,
        orgId: fixture.org.id,
        partnerId: fixture.partner.id,
        scope: 'organization',
        mfa: false,
        amr: ['password'],
      }, { tx, capability: fixture.capabilityC }));
      void issuer.catch(() => undefined);
      await waitForBlockedAppQuery('auth_browser_transitions');
      releaseBlocker.resolve();

      await expect(prepare).resolves.toMatchObject({ subjectIds: [fixture.userA.id] });
      await expect(issuer).rejects.toThrow('capability is no longer valid');
      expect(await getTestDb()
        .select()
        .from(refreshTokenFamilies)
        .where(eq(refreshTokenFamilies.userId, fixture.userC.id))).toHaveLength(0);
      await expect(isAccessSessionFamilyActive(
        fixture.accessPayload.sid!,
        fixture.userA.id,
      )).resolves.toBe(false);
      await expect(withAuthLifecycleSystemTransaction((tx) =>
        classifyRefreshTokenAuthority(tx, fixture.sessionA.tokens.refreshToken)))
        .resolves.toEqual({ kind: 'invalid' });
    } finally {
      releaseBlocker.resolve();
      await Promise.allSettled([
        blocker,
        ...(prepare ? [prepare] : []),
        ...(issuer ? [issuer] : []),
      ]);
    }
  });
});
