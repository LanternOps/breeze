/**
 * Live-Postgres coverage for #4454: `breeze_cascade_device_org_id()` must
 * tombstone `action_intents.scope_device_id` for every LIVE intent aimed at a
 * device that is leaving its org — not only when the move goes through the
 * `POST /devices/:id/move-org` route.
 *
 * WHY THIS NEEDS A REAL DATABASE
 * ------------------------------
 * The behaviour under test lives entirely inside a Postgres trigger function.
 * No TypeScript executes: `UPDATE devices SET org_id = ...` is the whole input,
 * and the tombstone is a side effect of the AFTER-UPDATE trigger. A mocked
 * suite can only assert the *shape* of the SQL text in the migration — which is
 * what `routes/devices/moveOrg.coverage.test.ts` does, statically, in the unit
 * job. It cannot catch any of the three ways this statement could be present
 * and still not work:
 *
 *   1. FORCE ROW LEVEL SECURITY on `action_intents` silently matching zero rows
 *      (the exact failure mode 2026-09-29's header warns about for a bare
 *      migration-time cleanup, and the one recorded for managed Postgres
 *      backfills that omit `breeze.scope`). A tombstone that reports success
 *      while updating nothing is indistinguishable from the bug it fixes.
 *   2. `action_intents_block_content_update()` — the BEFORE UPDATE immutability
 *      trigger — rejecting the write. It permits `scope_device_id` non-null ->
 *      NULL and nothing else, so a trigger-on-trigger ordering problem or a
 *      future tightening of that deny-list would raise
 *      `action_intents content is immutable` and abort the whole device move.
 *   3. `action_intents_scope_device_chk` rejecting a NULL id under a surviving
 *      `scope_kind = 'device'`.
 *
 * The two suites are complementary and deliberately both exist: the static one
 * fails fast in the blocking `test-api` job when the statement is deleted or
 * drifts from the route, this one proves the statement actually does something
 * against a real server.
 *
 * TWO CALLERS, ONE TRIGGER. The move is driven twice, because the two
 * non-route paths reach the trigger through different privilege levels and
 * only the second can expose failure mode 1:
 *
 *   - as the SUPERUSER admin client (`getTestDb()`) — the literal "somebody ran
 *     UPDATE in psql" path, RLS-exempt;
 *   - as the unprivileged `breeze_app` role under `withSystemDbAccessContext`
 *     — the shape every real non-route caller has, orgMerge's `devices` repoint
 *     included. `breeze_has_org_access()` grants system scope, so the trigger's
 *     UPDATE must match here too; if it silently matched zero rows this case is
 *     the one that goes red.
 *
 * THE TERMINAL-STATUS CONTROL IS NOT OPTIONAL. Every case also seeds a
 * `completed` intent pointing at the same device and asserts it is left ALONE.
 * A tombstone that fired unconditionally would rewrite the historical target of
 * an action that was already decided and executed — which the schema comment on
 * `actionIntents.scopeDeviceId` explicitly forbids, and which an assertion that
 * only checked the live row would happily pass.
 *
 * FIXTURES ARE PER-TEST. The shared integration setup (`./setup`) TRUNCATEs the
 * core tenant tables in a global `beforeEach`, so seeding in `beforeAll` would
 * be CASCADE-deleted before the second case runs.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { actionIntents, devices } from '../../db/schema';
import { createOrganization, createSite, setupTestEnvironment } from './db-utils';
import { getTestDb } from './setup';

const LIVE_STATUSES = ['pending_approval', 'approved', 'executing'] as const;

interface Fixture {
  deviceId: string;
  sourceOrgId: string;
  targetOrgId: string;
  targetSiteId: string;
  /** One id per LIVE status, all scoped to `deviceId`. */
  liveIntentIds: string[];
  /** `completed` intent scoped to the same device — must survive untouched. */
  terminalIntentId: string;
}

async function seed(): Promise<Fixture> {
  const adminDb = getTestDb() as never as {
    insert: (typeof db)['insert'];
    select: (typeof db)['select'];
  };
  const sfx = randomUUID().slice(0, 8);

  const { partner, organization: sourceOrg, site: sourceSite, user } = await setupTestEnvironment({
    scope: 'partner',
  });
  const targetOrg = await createOrganization({ partnerId: partner.id });
  const targetSite = await createSite({ orgId: targetOrg.id });

  const [device] = await adminDb
    .insert(devices)
    .values({
      orgId: sourceOrg.id,
      siteId: sourceSite.id,
      agentId: `intent-scope-agent-${sfx}`,
      hostname: `intent-scope-host-${sfx}`,
      osType: 'linux',
      osVersion: '22.04',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      status: 'offline',
    })
    .returning({ id: devices.id });

  // A human-originated intent satisfies action_intents_one_actor_chk (exactly
  // one of the three actor columns), action_intents_agent_origin_chk and
  // action_intents_agent_source_chk (source and origin_principal_kind move
  // together, neither is the agent value).
  const intentValues = (status: string, index: number) => ({
    orgId: sourceOrg.id,
    partnerId: partner.id,
    requestedByUserId: user.id,
    requestingApiKeyId: null,
    requestingAgentRunId: null,
    source: 'chat' as const,
    originPrincipalKind: 'user_session' as const,
    originPrincipalId: user.id,
    actionName: 'device.script.run',
    actionVersion: 1,
    arguments: { scriptId: randomUUID() } as never,
    argumentDigest: 'b'.repeat(64),
    targetSummary: `Run script on ${device!.id}`,
    impactSummary: 'Executes a script on the target device',
    reason: 'Integration coverage for #4454',
    riskTier: 2,
    connectionId: null,
    tenantId: null,
    // The live-status partial unique index is (org_id, idempotency_key), so
    // every LIVE row in this org needs a distinct key.
    idempotencyKey: `idem-${sfx}-${index}`,
    correlationId: randomUUID(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    status,
    scopeKind: 'device' as const,
    scopeDeviceId: device!.id,
  });

  const liveIntentIds: string[] = [];
  for (const [index, status] of LIVE_STATUSES.entries()) {
    const [row] = await adminDb
      .insert(actionIntents)
      .values(intentValues(status, index) as never)
      .returning({ id: actionIntents.id });
    liveIntentIds.push(row!.id);
  }

  const [terminal] = await adminDb
    .insert(actionIntents)
    .values({
      ...intentValues('completed', LIVE_STATUSES.length),
      decidedAt: new Date(),
      decidedByUserId: user.id,
      executedAt: new Date(),
    } as never)
    .returning({ id: actionIntents.id });

  return {
    deviceId: device!.id,
    sourceOrgId: sourceOrg.id,
    targetOrgId: targetOrg.id,
    targetSiteId: targetSite.id,
    liveIntentIds,
    terminalIntentId: terminal!.id,
  };
}

async function readScopes(ids: string[]): Promise<Array<string | null>> {
  const adminDb = getTestDb();
  const out: Array<string | null> = [];
  for (const id of ids) {
    const [row] = await adminDb
      .select({ scopeDeviceId: actionIntents.scopeDeviceId, status: actionIntents.status })
      .from(actionIntents)
      .where(eq(actionIntents.id, id));
    out.push(row!.scopeDeviceId);
  }
  return out;
}

async function readDeviceOrg(deviceId: string): Promise<string | undefined> {
  const [row] = await getTestDb()
    .select({ orgId: devices.orgId })
    .from(devices)
    .where(eq(devices.id, deviceId));
  return row?.orgId;
}

describe('breeze_cascade_device_org_id(): action_intents scope tombstone (#4454)', () => {
  it('a raw superuser UPDATE devices SET org_id tombstones every LIVE intent scoped to the device', async () => {
    const f = await seed();

    // Control: the pointers are live BEFORE the move, so a green assertion
    // below cannot be an artifact of a seed that never set them.
    expect(await readScopes(f.liveIntentIds)).toEqual([f.deviceId, f.deviceId, f.deviceId]);
    expect(await readScopes([f.terminalIntentId])).toEqual([f.deviceId]);

    await getTestDb().execute(sql`
      UPDATE devices SET org_id = ${f.targetOrgId}::uuid, site_id = ${f.targetSiteId}::uuid
       WHERE id = ${f.deviceId}::uuid
    `);

    expect(await readDeviceOrg(f.deviceId)).toBe(f.targetOrgId);
    expect(
      await readScopes(f.liveIntentIds),
      'every pending_approval/approved/executing intent must be tombstoned by the trigger, not just the route',
    ).toEqual([null, null, null]);
  });

  it('leaves a terminal-status intent pointing at the moved device', async () => {
    const f = await seed();

    await getTestDb().execute(sql`
      UPDATE devices SET org_id = ${f.targetOrgId}::uuid, site_id = ${f.targetSiteId}::uuid
       WHERE id = ${f.deviceId}::uuid
    `);

    expect(
      await readScopes([f.terminalIntentId]),
      'a completed intent is a historical record of an already-decided action — its target at decision time must survive the move',
    ).toEqual([f.deviceId]);
  });

  it('tombstones under the unprivileged breeze_app role in a system access context (forced RLS does not swallow the UPDATE)', async () => {
    const f = await seed();

    // The shape every real non-route caller has — orgMerge's `devices` repoint
    // included. If FORCE RLS on action_intents made the trigger's UPDATE match
    // zero rows, ONLY this case would catch it: the superuser case above is
    // RLS-exempt and would stay green.
    await withSystemDbAccessContext(async () => {
      await db.execute(sql`
        UPDATE devices SET org_id = ${f.targetOrgId}::uuid, site_id = ${f.targetSiteId}::uuid
         WHERE id = ${f.deviceId}::uuid
      `);
    });

    expect(await readDeviceOrg(f.deviceId)).toBe(f.targetOrgId);
    expect(await readScopes(f.liveIntentIds)).toEqual([null, null, null]);
    expect(await readScopes([f.terminalIntentId])).toEqual([f.deviceId]);
  });
});
