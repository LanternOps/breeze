/**
 * Real-Postgres proof for the W05 raw-SQL writers (spec §5.5, §3.3, §5.8, §5.9):
 * the users enrichment pass, sign-in activity, Secure Score snapshots, the
 * posture rollup, consent seeding and disconnect erasure. Each is a
 * hand-written statement (VALUES lists, casts, ON CONFLICT, data-modifying
 * CTEs) whose bind-time and constraint behaviour a Drizzle mock cannot see.
 * Everything runs as breeze_app through the production `db` under the same
 * system-context wrapping the worker uses, so a missing context would fail
 * closed here exactly as it would in production.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import {
  m365Connections, m365IntuneDevices, m365PostureRollups, m365SecureScoreSnapshots,
  m365SyncState, m365Users,
} from '../../db/schema';
import { M365SyncRunFencedError } from '../../services/m365Sync/domains/persist';
import { persistSecureScore } from '../../services/m365Sync/domains/secureScore';
import { persistSigninActivity } from '../../services/m365Sync/domains/signinActivity';
import { persistUsers, usersPrimaryProjection } from '../../services/m365Sync/domains/users';
import { canonicalHash } from '../../services/m365Sync/hash';
import { onConnectionDisconnected } from '../../services/m365Sync/lifecycle';
import { upsertPostureRollup } from '../../services/m365Sync/rollup';
import { createOrganization, createPartner } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

interface Tenant { orgId: string; connectionId: string; tenantId: string }
let t: Tenant;

async function seedConnection(): Promise<Tenant> {
  return withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const tenantId = randomUUID();
    const credentialVersion = '0123456789abcdef0123456789abcdef';
    const [connection] = await db.insert(m365Connections).values({
      orgId: org.id, userId: null, tenantId, clientId: randomUUID(), clientSecret: null,
      profile: 'customer-graph-read', authMode: 'application-certificate',
      credentialDomain: 'customer-graph-read',
      vaultRef: `akv://vault.example/m365-customer-graph-read-${org.id}/${credentialVersion}`,
      credentialVersion, permissionManifestVersion: 3, consentAttemptId: randomUUID(),
      consentGeneration: 2, status: 'active',
    }).returning({ id: m365Connections.id });
    return { orgId: org.id, connectionId: connection!.id, tenantId };
  });
}

function ctx(existing: Array<[string, { coreHash: string; isStale: boolean }]> = []) {
  return {
    orgId: t.orgId, tenantId: t.tenantId, connectionId: t.connectionId, generation: 1,
    existing: new Map(existing), now: new Date('2026-09-08T12:00:00.000Z'),
  };
}

function user(over: Record<string, unknown> = {}) {
  return {
    id: 'u1', userPrincipalName: 'ann@contoso.example', displayName: 'Ann', mail: 'ann@contoso.example',
    accountEnabled: true, jobTitle: null, department: null, usageLocation: 'US',
    onPremisesSyncEnabled: false, createdDateTime: '2026-01-01T00:00:00.000Z', assignedLicenses: [],
    mfaRegistered: true, mfaCapable: true, defaultMfaMethod: 'microsoftAuthenticatorPush',
    adminRoles: [{ roleTemplateId: 'r1', displayName: 'Global Administrator' }],
    ...over,
  };
}

function result(items: unknown[], sources: Record<string, string>, over: Record<string, unknown> = {}) {
  return {
    success: true as const, kind: 'sync' as const, items: items as Record<string, unknown>[],
    truncated: false, fetchedAt: '2026-09-08T12:00:00.000Z',
    sources: sources as Record<string, 'ok'>, ...over,
  };
}

const ALL_OK = { users: 'ok', mfaRegistration: 'ok', roleAssignments: 'ok' };

async function userRow(graphId = 'u1') {
  return withSystemDbAccessContext(async () => (await db.select().from(m365Users)
    .where(and(eq(m365Users.orgId, t.orgId), eq(m365Users.graphId, graphId))))[0]);
}

beforeEach(async () => {
  t = await seedConnection();
});

describe('users enrichment (real Postgres, spec §5.5)', () => {
  runDb('inserts enrichment with the primary row and derives is_admin from admin_roles', async () => {
    await persistUsers(ctx(), result([user()], ALL_OK));
    const row = await userRow();
    expect(row).toMatchObject({ mfaRegistered: true, mfaCapable: true, isAdmin: true });
    expect(row!.adminRoles).toEqual([{ roleTemplateId: 'r1', displayName: 'Global Administrator' }]);
  });

  runDb('updates enrichment on an UNCHANGED primary row, field-wise, without bumping last_changed_at', async () => {
    await persistUsers(ctx(), result([user()], ALL_OK));
    const before = await userRow();
    const hash = canonicalHash(usersPrimaryProjection(user()));

    const out = await persistUsers(
      ctx([['u1', { coreHash: hash, isStale: false }]]),
      result([user({ mfaRegistered: false, adminRoles: [] })], ALL_OK),
    );

    expect(out).toMatchObject({ inserted: 0, updated: 0, unchanged: 1 });
    const after = await userRow();
    expect(after).toMatchObject({ mfaRegistered: false, isAdmin: false });
    expect(after!.adminRoles).toEqual([]);
    expect(after!.lastChangedAt).toEqual(before!.lastChangedAt);
    expect(after!.coreHash).toBe(before!.coreHash);
  });

  runDb('leaves enrichment untouched when its source failed', async () => {
    await persistUsers(ctx(), result([user()], ALL_OK));
    const hash = canonicalHash(usersPrimaryProjection(user()));

    await persistUsers(
      ctx([['u1', { coreHash: hash, isStale: false }]]),
      result([user({ mfaRegistered: null, adminRoles: [] })],
        { users: 'ok', mfaRegistration: 'error', roleAssignments: 'permission_missing' }),
    );

    expect(await userRow()).toMatchObject({ mfaRegistered: true, isAdmin: true });
  });

  runDb('stores NULL for a user missing from a successful registration report', async () => {
    await persistUsers(ctx(), result([user({ mfaRegistered: null, mfaCapable: null, defaultMfaMethod: null })], ALL_OK));
    expect(await userRow()).toMatchObject({ mfaRegistered: null, mfaCapable: null, defaultMfaMethod: null });
  });
});

describe('sign-in activity (real Postgres, spec §5.5)', () => {
  runDb('updates only existing users, change-only, and ignores users not yet synced', async () => {
    await persistUsers(ctx(), result([user(), user({ id: 'u2' })], ALL_OK));

    const first = await persistSigninActivity(ctx(), result([
      { id: 'u1', lastSuccessfulSignInAt: '2026-09-01T10:00:00.000Z' },
      { id: 'u2', lastSuccessfulSignInAt: null },
      { id: 'ghost', lastSuccessfulSignInAt: '2026-09-02T10:00:00.000Z' },
    ], { signInActivity: 'ok' }));
    expect(first.updated).toBe(1);
    expect((await userRow('u1'))!.lastSuccessfulSignInAt).toEqual(new Date('2026-09-01T10:00:00.000Z'));

    const again = await persistSigninActivity(ctx(), result([
      { id: 'u1', lastSuccessfulSignInAt: '2026-09-01T10:00:00.000Z' },
    ], { signInActivity: 'ok' }));
    expect(again.updated).toBe(0);
  });

  runDb('never touches another org with the same graph id', async () => {
    await persistUsers(ctx(), result([user()], ALL_OK));
    const mine = t;
    t = await seedConnection();
    await persistUsers(ctx(), result([user()], ALL_OK));
    const other = t;
    t = mine;

    await persistSigninActivity(ctx(), result([{ id: 'u1', lastSuccessfulSignInAt: '2026-09-03T10:00:00.000Z' }], { signInActivity: 'ok' }));

    t = other;
    expect((await userRow('u1'))!.lastSuccessfulSignInAt).toBeNull();
  });
});

describe('Secure Score snapshots (real Postgres, spec §3.3)', () => {
  runDb('keys rows by the UTC day of Graph createdDateTime and upserts newest-wins', async () => {
    const first = await persistSecureScore(ctx(), result([
      { createdDateTime: '2026-09-07T23:30:00.000-02:00', currentScore: 400.25, maxScore: 600, activeUserCount: 10, licensedUserCount: 12, controlScores: [] },
      { createdDateTime: '2026-09-06T02:00:00.000Z', currentScore: 380, maxScore: 600, controlScores: [{ controlName: 'MFA' }] },
    ], { secureScores: 'ok' }));
    expect(first).toMatchObject({ inserted: 2, updated: 0, counts: { secure_score: 400.25, secure_score_max: 600 } });

    const second = await persistSecureScore(ctx(), result([
      { createdDateTime: '2026-09-08T01:00:00.000Z', currentScore: 410, maxScore: 600, controlScores: [] },
    ], { secureScores: 'ok' }));
    expect(second).toMatchObject({ inserted: 0, updated: 1 });

    const rows = await withSystemDbAccessContext(() => db.select().from(m365SecureScoreSnapshots)
      .where(eq(m365SecureScoreSnapshots.orgId, t.orgId)));
    const byDate = Object.fromEntries(rows.map((r) => [r.scoreDate, r]));
    // 2026-09-07T23:30-02:00 is 2026-09-08T01:30Z — the UTC day, not the local one.
    expect(Object.keys(byDate).sort()).toEqual(['2026-09-06', '2026-09-08']);
    expect(Number(byDate['2026-09-08']!.currentScore)).toBe(410);
    expect(byDate['2026-09-08']!.tenantId).toBe(t.tenantId);
  });
});

describe('posture rollup (real Postgres, spec §5.9)', () => {
  runDb('assembles counters from last_counts, NULL for unreported, and upserts per day', async () => {
    await withSystemDbAccessContext(async () => {
      await db.insert(m365SyncState).values([
        { orgId: t.orgId, connectionId: t.connectionId, domain: 'users', intervalSeconds: 21600,
          lastCounts: { users_total: 5, users_enabled: 4, users_mfa_registered: 3 },
          lastCompleteSnapshotAt: new Date('2026-09-08T06:00:00.000Z') },
        { orgId: t.orgId, connectionId: t.connectionId, domain: 'secure_score', intervalSeconds: 86400,
          lastCounts: { secure_score: 412.5, secure_score_max: 600 } },
      ]);
      await upsertPostureRollup(t.orgId, t.tenantId, '2026-09-08');
      await upsertPostureRollup(t.orgId, t.tenantId, '2026-09-08');
    });

    const rows = await withSystemDbAccessContext(() => db.select().from(m365PostureRollups)
      .where(eq(m365PostureRollups.orgId, t.orgId)));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenantId: t.tenantId, rollupDate: '2026-09-08', usersTotal: 5, usersEnabled: 4,
      usersMfaRegistered: 3, usersMfaUnknown: null, devicesTotal: null,
    });
    expect(Number(rows[0]!.secureScore)).toBe(412.5);
    expect(rows[0]!.domainsFresh).toMatchObject({
      users: { asOf: '2026-09-08T06:00:00.000Z', complete: true },
      secure_score: { asOf: null, complete: false },
    });
  });
});

describe('run ownership guard (real Postgres, spec §5.3/§5.8)', () => {
  async function seedState(generation: number) {
    await withSystemDbAccessContext(() => db.insert(m365SyncState).values({
      orgId: t.orgId, connectionId: t.connectionId, domain: 'users', intervalSeconds: 21600, runGeneration: generation,
    }));
  }

  runDb('a run that owns its state row persists', async () => {
    await seedState(4);
    await persistUsers({ ...ctx(), generation: 4, domain: 'users' }, result([user()], ALL_OK));
    expect(await userRow()).toBeDefined();
  });

  runDb('a run whose state row was deleted (disconnect) fences and writes NOTHING', async () => {
    await expect(persistUsers({ ...ctx(), generation: 4, domain: 'users' }, result([user()], ALL_OK)))
      .rejects.toBeInstanceOf(M365SyncRunFencedError);
    expect(await userRow()).toBeUndefined();
  });

  runDb('a run whose row was re-claimed (newer generation) fences too', async () => {
    await seedState(5);
    await expect(persistSigninActivity({ ...ctx(), generation: 4, domain: 'users' },
      result([{ id: 'u1', lastSuccessfulSignInAt: null }], { signInActivity: 'ok' })))
      .rejects.toBeInstanceOf(M365SyncRunFencedError);
  });
});

describe('disconnect erasure (real Postgres, spec §5.8)', () => {
  runDb('deletes state and entity rows for the org only, keeping the tenant-stamped history', async () => {
    await persistUsers(ctx(), result([user()], ALL_OK));
    await persistSecureScore(ctx(), result([{ createdDateTime: '2026-09-07T02:00:00.000Z', currentScore: 1, maxScore: 2 }], { secureScores: 'ok' }));
    await withSystemDbAccessContext(async () => {
      await db.insert(m365SyncState).values({ orgId: t.orgId, connectionId: t.connectionId, domain: 'users', intervalSeconds: 21600 });
      await db.insert(m365IntuneDevices).values({ orgId: t.orgId, graphId: 'd1', coreHash: 'f'.repeat(64) });
      await upsertPostureRollup(t.orgId, t.tenantId, '2026-09-08');
    });
    const mine = t;
    t = await seedConnection();
    await persistUsers(ctx(), result([user()], ALL_OK));
    const other = t;
    t = mine;

    await withSystemDbAccessContext(() => onConnectionDisconnected({ id: t.connectionId, orgId: t.orgId }));

    const counts = await withSystemDbAccessContext(async () => ({
      users: (await db.select().from(m365Users).where(eq(m365Users.orgId, t.orgId))).length,
      devices: (await db.select().from(m365IntuneDevices).where(eq(m365IntuneDevices.orgId, t.orgId))).length,
      state: (await db.select().from(m365SyncState).where(eq(m365SyncState.orgId, t.orgId))).length,
      scores: (await db.select().from(m365SecureScoreSnapshots).where(eq(m365SecureScoreSnapshots.orgId, t.orgId))).length,
      rollups: (await db.select().from(m365PostureRollups).where(eq(m365PostureRollups.orgId, t.orgId))).length,
      otherUsers: (await db.select().from(m365Users).where(eq(m365Users.orgId, other.orgId))).length,
    }));
    expect(counts).toEqual({ users: 0, devices: 0, state: 0, scores: 1, rollups: 1, otherUsers: 1 });
  });
});
