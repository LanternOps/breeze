/**
 * Live-Postgres coverage for #4792: a device org-move must not 23503 on
 * `action_intents_scope_ticket_org_fk` and abort, when the moving device has
 * a bound ticket that some intent is scoped to.
 *
 * WHY THIS NEEDS A REAL DATABASE
 * ------------------------------
 * `tickets` IS returned by `breeze_device_child_orgid_tables()`, so a device
 * org-move re-stamps `tickets.org_id` for every ticket bound to the moved
 * device. `action_intents_scope_ticket_org_fk` is a composite FK
 * `(scope_ticket_id, org_id) -> tickets(id, org_id)`, `DEFERRABLE INITIALLY
 * IMMEDIATE`, with no `ON UPDATE` clause (defaults to `NO ACTION`) — so
 * without the tombstone this file exercises, the tickets re-stamp itself
 * raises `23503` and the WHOLE move transaction rolls back. A mocked suite
 * can only assert the shape of the SQL text (`moveOrg.coverage.test.ts` does
 * that, statically, in the unit job); it cannot prove the move actually
 * *succeeds* against a real FK, and it cannot catch any of:
 *
 *   1. FORCE ROW LEVEL SECURITY on `action_intents` silently matching zero
 *      rows for the tombstone UPDATE.
 *   2. `action_intents_block_content_update()` rejecting the non-null ->
 *      NULL transition on `scope_ticket_id`.
 *   3. `action_intents_scope_ticket_chk` (`scope_ticket_id IS NULL OR
 *      scope_kind = 'ticket'`) — satisfied trivially once nulled, but worth
 *      a real-server pass since a bad statement could violate it instead.
 *
 * UNLIKE #4454's scope_device_id gap (silently stale, not fatal), this gap is
 * a hard abort: before the fix, a device org-move carrying a ticket-scoped
 * intent could not succeed at all, on either the route or a direct-SQL
 * caller. So every case below asserts the move SUCCEEDS, not just that the
 * pointer ends up null.
 *
 * TWO CALLERS, both asserted, mirroring the #4454 sibling
 * (deviceMoveOrgIntentScopeTombstone.integration.test.ts):
 *
 *   - `POST /devices/:id/move-org` (the route's own tombstone statement) —
 *     the primary bug report's exact path.
 *   - a raw `UPDATE devices SET org_id` under `withSystemDbAccessContext` as
 *     the unprivileged `breeze_app` role (the shape orgMerge's `devices`
 *     repoint has) — proves `breeze_cascade_device_org_id()`'s mirrored
 *     tombstone, not just the route's.
 *
 * TERMINAL STATUS IS NOT A CONTROL HERE, unlike #4454: this FK does not gate
 * on `status`, so a terminal-status intent is not a "must survive" case — it
 * is a "must ALSO be tombstoned, or it still 23503s the very next unrelated
 * write to that row" case. Both a live and a completed intent are seeded and
 * both must end up nulled.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { actionIntents, devices, tickets } from '../../db/schema';
import { createOrganization, createSite, setupTestEnvironment } from './db-utils';
import { getTestDb } from './setup';
import { createAccessToken } from '../../services/jwt';
import { moveOrgRoutes } from '../../routes/devices/moveOrg';

function uid(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function seed() {
  const adminDb = getTestDb() as never as {
    insert: (typeof db)['insert'];
    select: (typeof db)['select'];
  };
  const sfx = uid();

  const { partner, organization: sourceOrg, site: sourceSite, user, role } = await setupTestEnvironment({
    scope: 'partner',
  });
  const targetOrg = await createOrganization({ partnerId: partner.id });
  const targetSite = await createSite({ orgId: targetOrg.id });

  const [device] = await adminDb
    .insert(devices)
    .values({
      orgId: sourceOrg.id,
      siteId: sourceSite.id,
      agentId: `ticket-scope-agent-${sfx}`,
      hostname: `ticket-scope-host-${sfx}`,
      osType: 'linux',
      osVersion: '22.04',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      status: 'offline',
    })
    .returning({ id: devices.id });

  const [ticket] = await adminDb
    .insert(tickets)
    .values({
      orgId: sourceOrg.id,
      partnerId: partner.id,
      deviceId: device!.id,
      ticketNumber: `TS-${sfx}`,
      subject: `ticket-scope intent coverage ${sfx}`,
      source: 'manual',
    } as never)
    .returning({ id: tickets.id });

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
    actionName: 'ticket.comment.add',
    actionVersion: 1,
    arguments: { ticketId: ticket!.id } as never,
    argumentDigest: 'c'.repeat(64),
    targetSummary: `Comment on ticket ${ticket!.id}`,
    impactSummary: 'Adds a comment to the target ticket',
    reason: 'Integration coverage for #4792',
    riskTier: 1,
    connectionId: null,
    tenantId: null,
    // The live-status partial unique index is (org_id, idempotency_key), so
    // every LIVE row in this org needs a distinct key.
    idempotencyKey: `idem-ts-${sfx}-${index}`,
    correlationId: randomUUID(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    status,
    scopeKind: 'ticket' as const,
    scopeTicketId: ticket!.id,
  });

  const [live] = await adminDb
    .insert(actionIntents)
    .values(intentValues('pending_approval', 0) as never)
    .returning({ id: actionIntents.id });

  const [terminal] = await adminDb
    .insert(actionIntents)
    .values({
      ...intentValues('completed', 1),
      decidedAt: new Date(),
      decidedByUserId: user.id,
      executedAt: new Date(),
    } as never)
    .returning({ id: actionIntents.id });

  const token = await createAccessToken({
    sub: user.id,
    email: user.email,
    roleId: role.id,
    orgId: null,
    partnerId: partner.id,
    scope: 'partner',
    mfa: true,
    aep: 1,
    mep: 1,
    sid: 'it-session',
  });

  const app = new Hono();
  app.route('/devices', moveOrgRoutes);

  const post = () =>
    app.request(`/devices/${device!.id}/move-org`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgId: targetOrg.id, siteId: targetSite.id }),
    });

  return {
    deviceId: device!.id,
    ticketId: ticket!.id,
    sourceOrgId: sourceOrg.id,
    targetOrgId: targetOrg.id,
    targetSiteId: targetSite.id,
    liveIntentId: live!.id,
    terminalIntentId: terminal!.id,
    post,
  };
}

type Fixture = Awaited<ReturnType<typeof seed>>;

async function readScopeTicketIds(ids: string[]): Promise<Array<string | null>> {
  const adminDb = getTestDb();
  const out: Array<string | null> = [];
  for (const id of ids) {
    const [row] = await adminDb
      .select({ scopeTicketId: actionIntents.scopeTicketId })
      .from(actionIntents)
      .where(eq(actionIntents.id, id));
    out.push(row!.scopeTicketId);
  }
  return out;
}

async function readOrgs(f: Pick<Fixture, 'deviceId' | 'ticketId'>) {
  const [d] = await getTestDb().select({ orgId: devices.orgId }).from(devices).where(eq(devices.id, f.deviceId));
  const [t] = await getTestDb().select({ orgId: tickets.orgId }).from(tickets).where(eq(tickets.id, f.ticketId));
  return { deviceOrgId: d?.orgId, ticketOrgId: t?.orgId };
}

describe('POST /devices/:id/move-org — action_intents.scope_ticket_id tombstone (#4792)', () => {
  it('moves a device with a ticket-scoped intent (any status) without 23503, and tombstones scope_ticket_id', async () => {
    const f: Fixture = await seed();

    // Control: the pointers are live BEFORE the move, so a green assertion
    // below cannot be an artifact of a seed that never set them.
    expect(await readScopeTicketIds([f.liveIntentId, f.terminalIntentId])).toEqual([f.ticketId, f.ticketId]);

    const res = await f.post();
    const body = (await res.json()) as { success?: boolean; error?: string };

    // The bug report's exact symptom: without the fix this is a 500 with a
    // pg 23503 error, not a graceful 4xx — the move must succeed outright.
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.success).toBe(true);

    const afterOrgs = await readOrgs(f);
    expect(afterOrgs.deviceOrgId).toBe(f.targetOrgId);
    expect(afterOrgs.ticketOrgId, 'the bound ticket must have moved with the device').toBe(f.targetOrgId);

    expect(
      await readScopeTicketIds([f.liveIntentId, f.terminalIntentId]),
      'BOTH a live and a terminal-status intent must be tombstoned — this FK does not gate on status',
    ).toEqual([null, null]);
  });
});

describe('breeze_cascade_device_org_id(): action_intents.scope_ticket_id tombstone (#4792)', () => {
  it('a raw UPDATE devices under the unprivileged breeze_app role (system context) does not 23503 and tombstones both statuses', async () => {
    const f: Fixture = await seed();

    expect(await readScopeTicketIds([f.liveIntentId, f.terminalIntentId])).toEqual([f.ticketId, f.ticketId]);

    // The shape every real non-route, direct-SQL caller has — orgMerge's
    // `devices` repoint included. If FORCE RLS on action_intents made the
    // trigger's tombstone UPDATE match zero rows, this is the case that would
    // surface it as a 23503 thrown out of this very statement.
    await withSystemDbAccessContext(async () => {
      await db.execute(sql`
        UPDATE devices SET org_id = ${f.targetOrgId}::uuid, site_id = ${f.targetSiteId}::uuid
         WHERE id = ${f.deviceId}::uuid
      `);
    });

    const afterOrgs = await readOrgs(f);
    expect(afterOrgs.deviceOrgId).toBe(f.targetOrgId);
    expect(afterOrgs.ticketOrgId).toBe(f.targetOrgId);
    expect(await readScopeTicketIds([f.liveIntentId, f.terminalIntentId])).toEqual([null, null]);
  });

  it('a raw superuser UPDATE devices SET org_id also tombstones the ticket-scoped intents', async () => {
    const f: Fixture = await seed();

    await getTestDb().execute(sql`
      UPDATE devices SET org_id = ${f.targetOrgId}::uuid, site_id = ${f.targetSiteId}::uuid
       WHERE id = ${f.deviceId}::uuid
    `);

    const afterOrgs = await readOrgs(f);
    expect(afterOrgs.deviceOrgId).toBe(f.targetOrgId);
    expect(afterOrgs.ticketOrgId).toBe(f.targetOrgId);
    expect(await readScopeTicketIds([f.liveIntentId, f.terminalIntentId])).toEqual([null, null]);
  });
});
