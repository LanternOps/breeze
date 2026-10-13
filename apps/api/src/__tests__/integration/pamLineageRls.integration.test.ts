/**
 * Survivor read access to held PAM history, and device-move read isolation —
 * PAM ownership epochs W5 (#8207), spec §7.3.
 *
 * Runs as breeze_app (rolbypassrls = false), so RLS is genuinely enforced.
 *
 * Proves:
 *   - an org-scoped survivor user reads the held loser's PAM chain and lineage
 *     rows through the SELECT-only `breeze_merged_lineage_select` branch, and
 *     can neither UPDATE nor DELETE them through it;
 *   - an unrelated org in the same partner sees nothing;
 *   - a merge without a hold, a forged cross-partner merge event/hold, and a
 *     lineage longer than five hops grant nothing;
 *   - `target never sees source history`: after a device move A -> B, an
 *     org-B user gets zero epoch-1 rows and no closure snapshot from the PAM
 *     list and active routes and from the audit export;
 *   - the source org's history rows render the device hostname from the epoch
 *     closure snapshot, not from the live (now foreign) device row.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { getTestDb } from './setup';
import {
  assignUserToOrganization,
  createOrganization,
  createPartner,
  createRole,
  createUser,
  grantRolePermissions,
} from './db-utils';
import { seedMovedDeviceWithHistory, type SeededMovedDevice } from './ownershipEpochFixture';
import { insertHoldRaw, markMergedShell, rowsOf, seedHeldLineage } from './orgEvidenceHoldFixture';
import { PERMISSIONS } from '../../services/permissions';
import { createAccessToken, type TokenPayload } from '../../services/jwt';
import { pamRoutes } from '../../routes/pam';
import { fetchElevationAuditExportPage } from '../../services/pamAuditExport';
import { elevationAudit } from '../../db/schema';
import { eq } from 'drizzle-orm';

const LINEAGE_TABLES = [
  'pam_actuations',
  'pam_actuation_results',
  'elevation_requests',
  'elevation_audit',
  'device_ownership_epochs',
  'device_ownership_epoch_closures',
] as const;

function orgCtx(orgId: string): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null };
}

/** Rows of `table` owned by `ownerOrgId` that `viewerOrgId`'s org-scoped context can SELECT. */
async function visibleRows(viewerOrgId: string, table: string, ownerOrgId: string): Promise<number> {
  return withDbAccessContext(orgCtx(viewerOrgId), async () => {
    const [row] = rowsOf<{ n: number }>(await db.execute(sql`
      SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE org_id = ${ownerOrgId}::uuid`));
    return Number(row?.n ?? 0);
  });
}

async function seedElevationAudit(seeded: SeededMovedDevice, orgId: string): Promise<string> {
  const id = randomUUID();
  await getTestDb().execute(sql`
    INSERT INTO elevation_audit (id, org_id, elevation_request_id, event_type, actor, details, created_at, occurred_at)
    VALUES (${id}::uuid, ${orgId}::uuid, ${seeded.epoch1.requestId}::uuid, 'requested', 'system', '{}'::jsonb,
            now() - interval '10 days', now() - interval '10 days')`);
  return id;
}

/** L's closed chain, device since moved to S, L merged into S and held. */
async function seedHeldMerge() {
  const seeded = await seedMovedDeviceWithHistory({ path: ['L', 'S'] });
  const loser = seeded.orgs.L!.id;
  const survivor = seeded.orgs.S!.id;
  await seedElevationAudit(seeded, loser);
  const eventId = await markMergedShell({ partnerId: seeded.partnerId, loserOrgId: loser, survivorOrgId: survivor });
  return { seeded, loser, survivor, eventId };
}

describe('lineage RLS branch: survivor reads held loser history', () => {
  it('an org-scoped survivor user sees the held loser rows on every lineage table', async () => {
    const m = await seedHeldMerge();
    for (const table of LINEAGE_TABLES) {
      expect(await visibleRows(m.survivor, table, m.loser), `${table} before the hold`).toBe(0);
    }
    await insertHoldRaw({ partnerId: m.seeded.partnerId, loserOrgId: m.loser, survivorOrgId: m.survivor, mergeEventId: m.eventId });
    for (const table of LINEAGE_TABLES) {
      expect(await visibleRows(m.survivor, table, m.loser), `${table} after the hold`).toBeGreaterThan(0);
    }
  });

  it('the branch is SELECT-only: the survivor can neither update nor delete held rows', async () => {
    const m = await seedHeldMerge();
    await insertHoldRaw({ partnerId: m.seeded.partnerId, loserOrgId: m.loser, survivorOrgId: m.survivor, mergeEventId: m.eventId });
    const touched = await withDbAccessContext(orgCtx(m.survivor), async () => ({
      updated: rowsOf(await db.execute(sql`
        UPDATE elevation_requests SET reason = 'rewritten' WHERE org_id = ${m.loser}::uuid RETURNING id`)).length,
      deleted: rowsOf(await db.execute(sql`
        DELETE FROM elevation_audit WHERE org_id = ${m.loser}::uuid RETURNING id`)).length,
    }));
    expect(touched).toEqual({ updated: 0, deleted: 0 });

    const policies = rowsOf<{ tablename: string; cmd: string }>(await getTestDb().execute(sql`
      SELECT tablename, cmd FROM pg_policies
       WHERE schemaname = 'public' AND policyname = 'breeze_merged_lineage_select' ORDER BY tablename`));
    expect(policies.map((p) => p.tablename)).toEqual([...LINEAGE_TABLES].sort());
    expect(new Set(policies.map((p) => p.cmd))).toEqual(new Set(['SELECT']));
  });

  it('an unrelated org in the same partner sees nothing', async () => {
    const m = await seedHeldMerge();
    await insertHoldRaw({ partnerId: m.seeded.partnerId, loserOrgId: m.loser, survivorOrgId: m.survivor, mergeEventId: m.eventId });
    const bystander = await createOrganization({ partnerId: m.seeded.partnerId });
    for (const table of LINEAGE_TABLES) {
      expect(await visibleRows(bystander.id, table, m.loser), table).toBe(0);
    }
  });

  it('a merge event without a hold grants nothing', async () => {
    const m = await seedHeldMerge();
    for (const table of LINEAGE_TABLES) {
      expect(await visibleRows(m.survivor, table, m.loser), table).toBe(0);
    }
  });

  it('a forged cross-partner merge event and hold grant nothing', async () => {
    const m = await seedHeldMerge();
    const other = await createPartner();
    const foreign = await createOrganization({ partnerId: other.id });
    // The forger's own partner on the rows, the victim's loser org.
    const forgedEvent = randomUUID();
    await getTestDb().execute(sql`
      INSERT INTO org_merge_events (id, partner_id, loser_org_id, loser_org_name, survivor_org_id, summary)
      VALUES (${forgedEvent}::uuid, ${other.id}::uuid, ${m.loser}::uuid, 'forged', ${foreign.id}::uuid, '{}'::jsonb)`);
    await insertHoldRaw({ partnerId: other.id, loserOrgId: m.loser, survivorOrgId: foreign.id, mergeEventId: forgedEvent });
    for (const table of LINEAGE_TABLES) {
      expect(await visibleRows(foreign.id, table, m.loser), `${table} (forger partner)`).toBe(0);
    }
  });

  it('a forged hold whose survivor sits in another partner grants nothing', async () => {
    const m = await seedHeldMerge();
    const other = await createPartner();
    const foreign = await createOrganization({ partnerId: other.id });
    const forgedEvent = randomUUID();
    // Victim partner on the rows, but the survivor belongs to the forger.
    await getTestDb().execute(sql`
      INSERT INTO org_merge_events (id, partner_id, loser_org_id, loser_org_name, survivor_org_id, summary)
      VALUES (${forgedEvent}::uuid, ${m.seeded.partnerId}::uuid, ${m.loser}::uuid, 'forged', ${foreign.id}::uuid, '{}'::jsonb)`);
    await getTestDb().execute(sql`DELETE FROM org_merge_events WHERE id = ${m.eventId}::uuid`);
    await insertHoldRaw({ partnerId: m.seeded.partnerId, loserOrgId: m.loser, survivorOrgId: foreign.id, mergeEventId: forgedEvent });
    for (const table of LINEAGE_TABLES) {
      expect(await visibleRows(foreign.id, table, m.loser), `${table} (foreign survivor)`).toBe(0);
    }
  });

  it('a hold that disagrees with its merge event grants nothing', async () => {
    const m = await seedHeldMerge();
    const elsewhere = await createOrganization({ partnerId: m.seeded.partnerId });
    // The event says L -> S; the hold claims L -> elsewhere.
    await insertHoldRaw({ partnerId: m.seeded.partnerId, loserOrgId: m.loser, survivorOrgId: elsewhere.id, mergeEventId: m.eventId });
    for (const table of LINEAGE_TABLES) {
      expect(await visibleRows(elsewhere.id, table, m.loser), table).toBe(0);
    }
  });

  it('lineage is capped at five hops', async () => {
    const m = await seedHeldMerge();
    await insertHoldRaw({ partnerId: m.seeded.partnerId, loserOrgId: m.loser, survivorOrgId: m.survivor, mergeEventId: m.eventId });
    // L -> S (1 hop) then S -> o2 -> ... -> o5 (4 more): L is five hops from o5.
    const five = await seedHeldLineage(m.seeded.partnerId, 4, m.survivor);
    const fiveHopSurvivor = five[five.length - 1]!;
    expect(await visibleRows(fiveHopSurvivor, 'pam_actuations', m.loser)).toBe(1);

    // One more hop: L is now six hops from o6 and out of reach.
    const six = await seedHeldLineage(m.seeded.partnerId, 1, fiveHopSurvivor);
    const sixHopSurvivor = six[six.length - 1]!;
    expect(await visibleRows(sixHopSurvivor, 'pam_actuations', m.loser)).toBe(0);
    // The nearer hops are still readable from the far end.
    expect(await visibleRows(sixHopSurvivor, 'device_ownership_epochs', m.survivor)).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Device move A -> B: the destination never sees the source's history.
// ---------------------------------------------------------------------------

const createdTokens: string[] = [];
afterAll(() => { createdTokens.length = 0; });

async function orgUserToken(partnerId: string, orgId: string): Promise<string> {
  const role = await createRole({ scope: 'organization', orgId });
  await grantRolePermissions(role.id, [PERMISSIONS.DEVICES_READ]);
  const user = await createUser({ partnerId, orgId: null, email: `pam-history-${randomUUID()}@lineage.test` });
  await assignUserToOrganization(user.id, orgId, role.id);
  const payload: Omit<TokenPayload, 'type'> = {
    sub: user.id,
    email: user.email,
    roleId: role.id,
    orgId,
    partnerId,
    scope: 'organization',
    mfa: true,
    aep: 1,
    mep: 1,
    sid: randomUUID(),
  };
  const token = await createAccessToken(payload);
  createdTokens.push(token);
  return token;
}

function app(): Hono {
  const a = new Hono();
  a.route('/pam', pamRoutes);
  return a;
}

async function getJson(token: string, path: string): Promise<{ status: number; body: any }> {
  const res = await app().request(path, { headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, body: await res.json() };
}

describe('target never sees source history', () => {
  it('org B gets zero epoch-1 rows and no closure snapshot after a device move A -> B', async () => {
    const seeded = await seedMovedDeviceWithHistory({ path: ['A', 'B'] });
    const a = seeded.orgs.A!.id;
    const b = seeded.orgs.B!.id;
    await seedElevationAudit(seeded, a);
    // Put the epoch-1 request back in an "active" status so the /active read is a real probe.
    const activated = rowsOf(await getTestDb().execute(sql`
      UPDATE elevation_requests SET status = 'approved', expires_at = now() + interval '1 hour'
       WHERE id = ${seeded.epoch1.requestId}::uuid RETURNING id`));
    expect(activated, 'the /active probe row was never activated').toHaveLength(1);
    // Control: the source org does see it on /active, so the B-side absence below is not vacuous.
    const tokenA = await orgUserToken(seeded.partnerId, a);
    const activeA = await getJson(tokenA, '/pam/active');
    expect((activeA.body.active as Array<{ id: string }>).map((r) => r.id)).toContain(seeded.epoch1.requestId);

    const tokenB = await orgUserToken(seeded.partnerId, b);
    const list = await getJson(tokenB, `/pam/elevation-requests?deviceId=${seeded.deviceId}`);
    expect(list.status).toBe(200);
    expect(list.body.requests).toEqual([]);
    expect(list.body.pagination.total).toBe(0);

    const active = await getJson(tokenB, '/pam/active');
    expect(active.status).toBe(200);
    expect((active.body.active as Array<{ id: string }>).map((r) => r.id)).not.toContain(seeded.epoch1.requestId);

    const window = { from: new Date(Date.now() - 30 * 86_400_000), to: new Date(Date.now() - 60_000) };
    for (const orgId of [a, b]) {
      const page = await withDbAccessContext(orgCtx(b), () => fetchElevationAuditExportPage({
        orgCondition: eq(elevationAudit.orgId, b),
        allowedSiteIds: undefined,
        filters: { ...window, orgId, deviceId: seeded.deviceId },
        after: null,
        limit: 100,
        settleSeconds: 0,
      }));
      expect(page.records, `export as org B for org ${orgId === a ? 'A' : 'B'}`).toEqual([]);
    }

    for (const table of ['device_ownership_epoch_closures', 'device_ownership_epochs', 'pam_actuations', 'pam_actuation_results']) {
      expect(await visibleRows(b, table, a), table).toBe(0);
    }
  });

  it("the source org's history renders the hostname from the epoch closure snapshot", async () => {
    const seeded = await seedMovedDeviceWithHistory({ path: ['A', 'B'] });
    const a = seeded.orgs.A!.id;
    const [closure] = rowsOf<{ hostname_snapshot: string }>(await getTestDb().execute(sql`
      SELECT hostname_snapshot FROM device_ownership_epoch_closures
       WHERE device_id = ${seeded.deviceId}::uuid AND epoch = 1`));
    // The live device has been renamed in org B since; org A must not see the new name.
    await getTestDb().execute(sql`
      UPDATE devices SET hostname = 'renamed-in-destination' WHERE id = ${seeded.deviceId}::uuid`);

    const tokenA = await orgUserToken(seeded.partnerId, a);
    const list = await getJson(tokenA, `/pam/elevation-requests?deviceId=${seeded.deviceId}`);
    expect(list.status).toBe(200);
    expect(list.body.requests).toHaveLength(1);
    expect(list.body.requests[0].id).toBe(seeded.epoch1.requestId);
    expect(list.body.requests[0].deviceHostname).toBe(closure!.hostname_snapshot);
  });

  it('A -> B -> A: an epoch-1 row renders the closure snapshot, not the device now back in A (list and /active)', async () => {
    const seeded = await seedMovedDeviceWithHistory({ path: ['A', 'B', 'A'] });
    const a = seeded.orgs.A!.id;
    const [closure] = rowsOf<{ hostname_snapshot: string }>(await getTestDb().execute(sql`
      SELECT hostname_snapshot FROM device_ownership_epoch_closures
       WHERE device_id = ${seeded.deviceId}::uuid AND epoch = 1`));
    // Same org again, so only the epoch match keeps the live row out.
    await getTestDb().execute(sql`
      UPDATE devices SET hostname = 'renamed-after-return' WHERE id = ${seeded.deviceId}::uuid`);
    const activated = rowsOf(await getTestDb().execute(sql`
      UPDATE elevation_requests SET status = 'approved', expires_at = now() + interval '1 hour'
       WHERE id = ${seeded.epoch1.requestId}::uuid RETURNING id`));
    expect(activated).toHaveLength(1);

    const tokenA = await orgUserToken(seeded.partnerId, a);
    const list = await getJson(tokenA, `/pam/elevation-requests?deviceId=${seeded.deviceId}`);
    expect(list.body.requests).toHaveLength(1);
    expect(list.body.requests[0].deviceHostname).toBe(closure!.hostname_snapshot);
    const active = await getJson(tokenA, '/pam/active');
    const row = (active.body.active as Array<{ id: string; deviceHostname: string | null }>)
      .find((r) => r.id === seeded.epoch1.requestId);
    expect(row?.deviceHostname).toBe(closure!.hostname_snapshot);
  });
});
