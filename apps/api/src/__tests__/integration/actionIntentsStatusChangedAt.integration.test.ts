/**
 * B-W06 (#6160, D-B50): `action_intents.status_changed_at`, stamped by the
 * BEFORE UPDATE trigger `action_intents_stamp_status_changed_at` on every
 * status change — real Postgres, FORCE RLS as `breeze_app`.
 *
 * The Tasks extension's `lastUpdatedAt` reads this column, so it must move on
 * EVERY status writer, including the ones that change only `status` /
 * `error_code` (cancel, the stale-executing reaper). The trigger covers every
 * writer by construction; this suite drives the real writers so a future
 * writer that bypasses it (or a dropped trigger) goes red here.
 *
 * Fixtures are per-test: `./setup` TRUNCATEs the tenant tables in a global
 * beforeEach (see actionIntentsImmutabilityTrigger.integration.test.ts).
 *
 * Every read/rewind runs through its own top-level `withSystemDbAccessContext`
 * call (never nested inside an open transaction): #9446.
 */
import { getTestDb } from './setup';

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';

import { db, withSystemDbAccessContext } from '../../db';
import { actionIntents, apiKeys } from '../../db/schema';
import type { ActionIntentStatus, NewActionIntent } from '../../db/schema/actionIntents';
import { buildOrgAccessClosures, type AuthContext } from '../../middleware/auth';
import { cancelActionIntent, transitionIntent } from '../../services/actionIntents/intentService';
import { reapExpiredIntents, reapStaleExecutingIntents } from '../../jobs/intentExpiryReaper';
import { createOrganization, createPartner, createUser } from './db-utils';

const sys = withSystemDbAccessContext;

type Seeded = { intentId: string; auth: AuthContext };

async function seedIntent(status: ActionIntentStatus, extra: Partial<NewActionIntent> = {}): Promise<Seeded> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const user = await createUser({ partnerId: partner.id, orgId: org.id, email: `sca-${randomUUID()}@status-changed-at.test` });
  const rawKey = `brz_${randomBytes(24).toString('hex')}`;
  const [key] = await sys(() => db.insert(apiKeys).values({
    orgId: org.id,
    createdBy: user.id,
    name: `sca-${randomUUID().slice(0, 8)}`,
    keyHash: createHash('sha256').update(rawKey).digest('hex'),
    keyPrefix: rawKey.slice(0, 12),
    scopes: ['ai:read', 'ai:execute'],
    status: 'active',
    mcpDomains: null,
  }).returning({ id: apiKeys.id }));
  const values: NewActionIntent = {
    orgId: org.id,
    partnerId: partner.id,
    requestedByUserId: user.id,
    requestingApiKeyId: null,
    requestingAgentRunId: null,
    source: 'mcp_api',
    originPrincipalKind: 'api_key',
    originPrincipalId: key!.id,
    actionName: 'restore_snapshot',
    actionVersion: 1,
    arguments: { snapshotId: randomUUID() },
    argumentDigest: 'b'.repeat(64),
    targetSummary: 'Restore a snapshot',
    impactSummary: 'Overwrites files on the device',
    reason: 'status_changed_at integration test',
    riskTier: 3,
    idempotencyKey: `sca-${randomUUID()}`,
    correlationId: randomUUID(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    status,
    ...extra,
  };
  const [row] = await sys(() => db.insert(actionIntents).values(values).returning({ id: actionIntents.id }));

  const { orgCondition, canAccessOrg } = buildOrgAccessClosures([org.id]);
  const auth: AuthContext = {
    principal: { kind: 'user_session' },
    user: { id: user.id, email: user.email, name: 'Requester', isPlatformAdmin: false },
    token: {
      sub: user.id, email: user.email, roleId: null, orgId: org.id, partnerId: partner.id,
      scope: 'organization', type: 'access', mfa: true,
    },
    partnerId: partner.id,
    orgId: org.id,
    scope: 'organization',
    accessibleOrgIds: [org.id],
    orgCondition,
    canAccessOrg,
  } as AuthContext;
  return { intentId: row!.id, auth };
}

async function readRow(id: string) {
  const [row] = await sys(() => db
    .select({ status: actionIntents.status, statusChangedAt: actionIntents.statusChangedAt })
    .from(actionIntents)
    .where(eq(actionIntents.id, id))
    .limit(1));
  return row!;
}

/** Push the stamp an hour into the past through a raw UPDATE that does not change status. */
async function rewindStamp(id: string): Promise<Date> {
  // The trigger keeps OLD.status_changed_at on a non-status UPDATE, so the
  // rewind goes through the superuser test connection with replica-mode
  // triggers off for this one transaction (no DDL, no table lock — #9446).
  await getTestDb().transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL session_replication_role = replica`);
    await tx.execute(sql`UPDATE action_intents SET status_changed_at = now() - interval '1 hour' WHERE id = ${id}`);
  });
  const row = await readRow(id);
  expect(row.statusChangedAt).not.toBeNull();
  return row.statusChangedAt!;
}

describe('action_intents.status_changed_at (B-W06 D-B50, live DB)', () => {
  it('a newly created intent has status_changed_at set (column default)', async () => {
    const before = Date.now() - 5_000;
    const { intentId } = await seedIntent('pending_approval');
    const row = await readRow(intentId);
    expect(row.statusChangedAt).toBeInstanceOf(Date);
    expect(row.statusChangedAt!.getTime()).toBeGreaterThan(before);
  });

  it.each<[string, ActionIntentStatus, Partial<NewActionIntent>, (s: Seeded) => Promise<unknown>, ActionIntentStatus]>([
    ['cancelActionIntent (pending → cancelled)', 'pending_approval', {},
      (s) => cancelActionIntent(s.auth, s.intentId), 'cancelled'],
    ['decide-path CAS (pending → approved)', 'pending_approval', {},
      (s) => transitionIntent(s.intentId, 'pending_approval', 'approved', { decidedAt: new Date() }), 'approved'],
    ['transitionIntent executing → completed', 'executing', { executionStartedAt: new Date() },
      (s) => transitionIntent(s.intentId, 'executing', 'completed', { executedAt: new Date(), result: { ok: true } }), 'completed'],
    ['expiry reaper (pending → expired)', 'pending_approval',
      { expiresAt: new Date(Date.now() - 60_000), approvalExpiresAt: new Date(Date.now() - 60_000) },
      () => sys(() => reapExpiredIntents()), 'expired'],
    ['stale-executing reaper (executing → failed execution_lost)', 'executing',
      { executionStartedAt: new Date(Date.now() - 24 * 60 * 60 * 1000), decidedAt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      () => sys(() => reapStaleExecutingIntents()), 'failed'],
  ])('status_changed_at stamps every status writer: %s', async (_label, from, extra, write, to) => {
    const seeded = await seedIntent(from, extra);
    const before = await rewindStamp(seeded.intentId);
    await write(seeded);
    const after = await readRow(seeded.intentId);
    expect(after.status).toBe(to);
    expect(after.statusChangedAt!.getTime()).toBeGreaterThan(before.getTime());
    // clock_timestamp(): within the last minute, not the rewound hour.
    expect(Date.now() - after.statusChangedAt!.getTime()).toBeLessThan(60_000);
  });

  it('an UPDATE that does not change status keeps status_changed_at (retention nulling result)', async () => {
    const { intentId } = await seedIntent('completed', { result: { ok: true }, executedAt: new Date() });
    const before = await rewindStamp(intentId);
    await sys(() => db.update(actionIntents).set({ result: null }).where(eq(actionIntents.id, intentId)));
    const after = await readRow(intentId);
    expect(after.status).toBe('completed');
    expect(after.statusChangedAt!.getTime()).toBe(before.getTime());
  });

  it('an application write cannot forge or clear it', async () => {
    const { intentId } = await seedIntent('pending_approval');
    const before = await rewindStamp(intentId);
    await sys(() => db.execute(sql`UPDATE action_intents SET status_changed_at = '2000-01-01T00:00:00Z' WHERE id = ${intentId}`));
    expect((await readRow(intentId)).statusChangedAt!.getTime()).toBe(before.getTime());
    await sys(() => db.execute(sql`UPDATE action_intents SET status_changed_at = NULL WHERE id = ${intentId}`));
    expect((await readRow(intentId)).statusChangedAt!.getTime()).toBe(before.getTime());
  });

  it('a status UPDATE that also names status_changed_at gets the server clock, not the supplied value', async () => {
    const { intentId } = await seedIntent('pending_approval');
    await rewindStamp(intentId);
    await sys(() => db.execute(sql`UPDATE action_intents SET status = 'cancelled', status_changed_at = '2000-01-01T00:00:00Z' WHERE id = ${intentId}`));
    const after = await readRow(intentId);
    expect(after.status).toBe('cancelled');
    expect(Date.now() - after.statusChangedAt!.getTime()).toBeLessThan(60_000);
  });
});
