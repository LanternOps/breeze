/**
 * group_membership_log — lookup by (group_id, device_id) is served by an
 * index under RLS (#12666).
 *
 * The fleet-step group gate (#12418 W02) joins a static group's memberships to
 * this log on (group_id, device_id) and keeps log rows written since the
 * member was added. The table had only its primary key, so that read scanned
 * the whole log, every organisation's rows included, and on a large log could
 * exceed the 500 ms filter query time limit.
 *
 * This suite asserts, on a real Postgres:
 *   1. the index exists and is VALID (a failed CONCURRENTLY build leaves an
 *      INVALID index that `IF NOT EXISTS` would accept);
 *   2. as the unprivileged `breeze_app` role in an org-scoped context, both a
 *      direct (group_id, device_id) lookup and the gate's join shape plan
 *      through that index with group_id/device_id as index conditions.
 *
 * The EXPLAINs run through `explainAsBreezeApp`, i.e. with
 * `enable_seqscan = off`. That makes this a planner-capability check: any
 * usable index beats a seq scan by ~1e10 cost, so a `Seq Scan on
 * group_membership_log` left in the plan means no index can serve the lookup
 * under the RLS security qual. It does not claim the planner would pick the
 * index at every table size with seq scans enabled; the PR records measured
 * timings for that. A plan captured as a BYPASSRLS role would prove nothing.
 *
 * The join below is a hand-written copy of the gate's query shape
 * (fleetFilterGroupGate.ts `loadGatedGroups`, withdrawn-pin check), not an
 * import of it, so this suite does not depend on that code.
 */
import './setup';
import { getTestDb } from './setup';

import { beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDevice, createOrganization, createPartner, createSite } from './db-utils';
import { explainAsBreezeApp } from './explainAsBreezeApp';

const INDEX = 'group_membership_log_group_device_idx';

/** One bound `uuid[]` parameter (a bare JS array in `sql` expands to a list). */
const uuidArray = (ids: string[]) => sql`${`{${ids.join(',')}}`}::uuid[]`;

describe('group_membership_log (group_id, device_id) index (#12666)', () => {
  let orgId: string;
  let groupId: string;
  let deviceId: string;
  let groupIds: string[];

  // beforeEach: the shared harness TRUNCATEs core tenant tables on every test.
  beforeEach(async () => {
    const admin = getTestDb();
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const other = await createOrganization({ partnerId: partner.id });
    orgId = org.id;

    const deviceIdsByOrg = new Map<string, string[]>();
    for (const o of [org.id, other.id]) {
      const site = await createSite({ orgId: o });
      const ids: string[] = [];
      for (let i = 0; i < 20; i++) ids.push((await createDevice({ orgId: o, siteId: site!.id })).id);
      deviceIdsByOrg.set(o, ids);
    }

    const groupIdsByOrg = new Map<string, string[]>();
    for (const o of [org.id, other.id]) {
      const rows = await admin.execute<{ id: string }>(sql`
        INSERT INTO device_groups (org_id, name, type)
        SELECT ${o}, 'static ' || g, 'static' FROM generate_series(1, 10) g
        RETURNING id`);
      groupIdsByOrg.set(o, Array.from(rows).map((r) => r.id));
    }
    groupIds = groupIdsByOrg.get(org.id)!;
    groupId = groupIds[0]!;
    deviceId = deviceIdsByOrg.get(org.id)![0]!;

    // Members: every device of the org in every one of its groups.
    for (const o of [org.id, other.id]) {
      await admin.execute(sql`
        INSERT INTO device_group_memberships (device_id, group_id, org_id, is_pinned, added_at, added_by)
        SELECT d, g, ${o}, false, now() - interval '30 days', 'manual'
          FROM unnest(${uuidArray(deviceIdsByOrg.get(o)!)}) d,
               unnest(${uuidArray(groupIdsByOrg.get(o)!)}) g`);
    }

    // ~16k log rows over both orgs: 20 per (group, device), mostly dynamic
    // churn, a few pin/unpin events, spread over the last 60 days.
    await admin.execute(sql`
      INSERT INTO group_membership_log (group_id, device_id, org_id, action, reason, created_at)
      SELECT m.group_id, m.device_id, m.org_id,
             (CASE WHEN n % 2 = 0 THEN 'added' ELSE 'removed' END)::group_membership_log_action,
             (CASE WHEN n % 10 = 0 THEN 'pinned' WHEN n % 10 = 1 THEN 'unpinned'
                   WHEN n % 2 = 0 THEN 'filter_match' ELSE 'filter_unmatch' END)::group_membership_log_reason,
             now() - (n || ' days')::interval
        FROM device_group_memberships m, generate_series(1, 20) n`);
    await admin.execute(sql`ANALYZE group_membership_log`);
    await admin.execute(sql`ANALYZE device_group_memberships`);
  });

  it('exists, is valid, and is keyed (group_id, device_id) first', async () => {
    const rows = await getTestDb().execute<{ indisvalid: boolean; indexdef: string }>(sql`
      SELECT i.indisvalid, pg_get_indexdef(i.indexrelid) AS indexdef
        FROM pg_index i
        JOIN pg_class c ON c.oid = i.indexrelid
       WHERE i.indrelid = 'public.group_membership_log'::regclass
         AND c.relname = ${INDEX}`);
    const row = Array.from(rows)[0];
    expect(row, `${INDEX} is missing`).toBeDefined();
    expect(row!.indisvalid).toBe(true);
    expect(row!.indexdef).toMatch(/USING btree \(group_id, device_id[,)]/);
  });

  it('a direct (group_id, device_id) lookup uses the index as breeze_app', async () => {
    const result = await explainAsBreezeApp({
      orgId,
      sql: sql`SELECT id, action, reason, created_at
                 FROM group_membership_log
                WHERE group_id = ${groupId} AND device_id = ${deviceId}`,
    });
    expect(result.usesIndex(INDEX), result.plan).toBe(true);
    expect(result.plan).not.toContain('Seq Scan on group_membership_log');
  });

  it("the group gate's withdrawn-pin join reads the log through the index as breeze_app", async () => {
    // Same shape as the gate: memberships of the org's static groups, joined
    // to log rows for the same (group, device) written since the member was
    // added, reason 'pinned'. Planned both ways a pooled prepared statement
    // can be planned.
    const query = sql`
      SELECT DISTINCT m.group_id
        FROM device_group_memberships m
        JOIN group_membership_log l
          ON l.group_id = m.group_id
         AND l.device_id = m.device_id
         AND l.created_at >= m.added_at
       WHERE m.group_id = ANY(${uuidArray(groupIds)})
         AND m.org_id = ${orgId}
         AND m.is_pinned = false
         AND l.group_id = ANY(${uuidArray(groupIds)})
         AND l.org_id = ${orgId}
         AND l.reason = 'pinned'`;
    for (const forceGenericPlan of [false, true]) {
      const result = await explainAsBreezeApp({ orgId, sql: query, forceGenericPlan });
      expect(result.usesIndex(INDEX), result.plan).toBe(true);
      expect(result.plan, result.plan).not.toContain('Seq Scan on group_membership_log');
    }
  });
});
