/**
 * Breadth + failure-semantics coverage for `cascadeDeleteOrg` (#3880).
 *
 * ## Why this file exists alongside `tenantCascadeExecution.integration.test.ts`
 *
 * `tenantCascadeExecution.integration.test.ts` already drives the real
 * erasure end-to-end, but it is a *regression* suite: its fixture is shaped
 * around the specific bugs it was written for (#4100 webhook_deliveries, the
 * QuickBooks polymorphic mapping pre-clear, the #3258 composite portal_users
 * FK). It seeds a handful of tables and asserts those tables by name.
 *
 * That leaves the property #3880 actually asks for unproven: that an erasure
 * of a *broad* org removes **every** row keyed on it across the whole cascade
 * list, and that the erasure's documented failure behaviour is what the code
 * really does. This file covers the shape classes the regression fixture does
 * not reach, and — critically — asserts residual rows generically over all
 * ~300 entries of `getOrgCascadeDeleteOrder()` rather than over a hand-listed
 * few, so a table added to the list later is swept without editing this test.
 *
 * Shape classes seeded here, one per `it`:
 *
 * - **Append-only / audit-admin escalation beyond `audit_logs`.**
 *   `ml_feedback_events` is in `AUDIT_ADMIN_REQUIRED_TABLES`; `breeze_app` has
 *   no DELETE grant on it AND a BEFORE DELETE trigger blocks the row. Only the
 *   `SET LOCAL ROLE breeze_audit_admin` + `SET LOCAL breeze.allow_audit_retention`
 *   pair inside `cascadeDeleteOrg` can remove it. The test includes a negative
 *   control proving the app role genuinely cannot, so the escalation branch is
 *   load-bearing rather than incidental.
 * - **Self-referencing chain.** `quotes.revision_of_quote_id` is a composite
 *   `(revision_of_quote_id, org_id) -> quotes(id, org_id)` FK with NO ACTION.
 *   A 3-deep revision lineage must come out in the single
 *   `DELETE FROM quotes WHERE org_id = $1` statement. This is the exact shape
 *   that produced #3880 in the first place (found while writing the #3879 W06
 *   revision-lineage tests).
 * - **Device-scoped table with a denormalized `org_id`.** `device_hardware`
 *   and `alerts` carry both `device_id` and `org_id`; their `device_id` FK has
 *   NO ACTION, so they must be deleted before `devices` or the walk raises
 *   23503. The regression suite seeds no devices at all.
 * - **Partner-wide config row (`org_id` NULL XOR `partner_id`).** A
 *   partner-wide `maintenance_windows` row belongs to no org and MUST survive
 *   the erasure of one of that partner's orgs — deleting it would silently
 *   destroy config for every sibling org.
 *
 * ## Failure semantics (the second half of #3880)
 *
 * The last `describe` pins what a mid-walk failure actually does, because the
 * source comment ("partial deletion is worse than no deletion") reads as if
 * the cascade were atomic and it is not. Each table's DELETE runs in its own
 * `withSystemDbAccessContext`, which opens its own `baseDb.transaction(...)`
 * (`apps/api/src/db/index.ts`) — so every table that succeeded is ALREADY
 * COMMITTED when a later one fails. The real contract is:
 *
 *   fail fast → leave the partial erasure in place → record
 *   `tenant.erasure.failed` (org_id NULL, so it survives) with per-table
 *   progress → stay re-runnable, because the walk is idempotent.
 *
 * The test induces the failure the same way production hit it in #4100: an FK
 * child with no ON DELETE action pointing into a cascade-list table.
 *
 * ## Deliberately NOT seeded
 *
 * PR #4863 (issue #4519) proved live erasure failures; these two remain
 * open bugs. Seeding them here would make this suite red for a defect it is
 * not fixing, so they are skipped on purpose and named instead:
 *   - `restore_jobs.command_id` (#4871)
 *   - `script_categories.parent_id` with a NULL `org_id` (#4873)
 */
import './setup';
import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { getTestDb, getAppDb } from './setup';
import { cascadeDeleteOrg, getOrgCascadeDeleteOrder } from '../../services/tenantCascade';
import { pgErrorCode } from '../../utils/pgErrors';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDENT_RE = /^[a-z_][a-z0-9_]*$/;

interface SeedHandles {
  partnerId: string;
  actorUserId: string;
  orgErased: string;
  orgControl: string;
  siteErased: string;
  siteControl: string;
  deviceErased: string;
  deviceControl: string;
  quoteChainErased: [string, string, string];
  partnerWideWindowId: string;
  orgWindowErasedId: string;
}

/**
 * Every cascade-list table that actually exists in this database and is keyed
 * on `org_id`, plus `organizations` (which is keyed on its own `id`).
 *
 * Read from `information_schema` at run time and intersected with
 * `getOrgCascadeDeleteOrder()` so the sweep below needs no maintenance when a
 * table joins the list.
 */
async function orgKeyedCascadeTables(): Promise<string[]> {
  const testDb = getTestDb();
  const rows = (await testDb.execute(sql`
    SELECT table_name
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND column_name = 'org_id'
  `)) as unknown as Array<{ table_name: string }>;
  const withOrgId = new Set(rows.map((r) => r.table_name));
  const names = getOrgCascadeDeleteOrder().filter(
    (t) => t !== 'organizations' && withOrgId.has(t),
  );
  for (const name of names) {
    // Defense in depth: these names are interpolated into raw SQL below.
    if (!IDENT_RE.test(name)) throw new Error(`refusing to sweep unsafe identifier: ${name}`);
  }
  return names;
}

/**
 * Per-table count of rows still keyed on `orgId`, across the WHOLE cascade
 * list. Returns only non-zero entries, so a clean erasure is `{}` and a
 * failure names exactly which tables were stranded.
 *
 * One UNION ALL statement rather than ~300 round trips.
 */
async function residualRowCounts(orgId: string): Promise<Record<string, number>> {
  if (!UUID_RE.test(orgId)) throw new Error(`residualRowCounts: not a uuid: ${orgId}`);
  const testDb = getTestDb();
  const tables = await orgKeyedCascadeTables();
  const parts = tables.map(
    (t) => `SELECT '${t}' AS tbl, count(*)::int AS n FROM "${t}" WHERE org_id = '${orgId}'::uuid`,
  );
  parts.push(
    `SELECT 'organizations' AS tbl, count(*)::int AS n FROM organizations WHERE id = '${orgId}'::uuid`,
  );
  const rows = (await testDb.execute(
    sql.raw(`SELECT tbl, n FROM (${parts.join(' UNION ALL ')}) s WHERE n > 0 ORDER BY tbl`),
  )) as unknown as Array<{ tbl: string; n: number }>;
  return Object.fromEntries(rows.map((r) => [r.tbl, Number(r.n)]));
}

async function seed(): Promise<SeedHandles> {
  const testDb = getTestDb();
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

  const [partner] = (await testDb.execute(sql`
    INSERT INTO partners (name, slug, status, created_at, updated_at)
    VALUES ('Breadth Partner', ${`breadth-${suffix}`}, 'active', now(), now())
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const partnerId = partner!.id;

  const [actor] = (await testDb.execute(sql`
    INSERT INTO users (partner_id, email, name, status, created_at, updated_at)
    VALUES (${partnerId}, ${`breadth-actor-${suffix}@example.test`}, 'Breadth Actor', 'active', now(), now())
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const actorUserId = actor!.id;

  const orgIds: string[] = [];
  for (const [name, slug] of [
    ['Org To Erase', `breadth-erase-${suffix}`],
    ['Sibling Org', `breadth-control-${suffix}`],
  ] as const) {
    const [org] = (await testDb.execute(sql`
      INSERT INTO organizations (partner_id, name, slug, status, currency_code, created_at, updated_at)
      VALUES (${partnerId}, ${name}, ${slug}, 'active', 'USD', now(), now())
      RETURNING id
    `)) as unknown as Array<{ id: string }>;
    orgIds.push(org!.id);
  }
  const [orgErased, orgControl] = orgIds as [string, string];

  const siteIds: string[] = [];
  for (const orgId of [orgErased, orgControl]) {
    const [site] = (await testDb.execute(sql`
      INSERT INTO sites (org_id, name, created_at, updated_at)
      VALUES (${orgId}, 'Breadth Site', now(), now())
      RETURNING id
    `)) as unknown as Array<{ id: string }>;
    siteIds.push(site!.id);
  }
  const [siteErased, siteControl] = siteIds as [string, string];

  // Devices + two device-scoped tables that denormalize org_id. Both
  // device_id FKs are NO ACTION, so these MUST be deleted before `devices`.
  const deviceIds: string[] = [];
  for (const [orgId, siteId, tag] of [
    [orgErased, siteErased, 'erase'],
    [orgControl, siteControl, 'control'],
  ] as const) {
    const [device] = (await testDb.execute(sql`
      INSERT INTO devices (org_id, site_id, agent_id, hostname, os_type, os_version, architecture, agent_version, created_at, updated_at)
      VALUES (${orgId}, ${siteId}, ${`breadth-${tag}-${suffix}`}, ${`host-${tag}`}, 'linux', '1.0', 'x86_64', '0.0.0-test', now(), now())
      RETURNING id
    `)) as unknown as Array<{ id: string }>;
    deviceIds.push(device!.id);
  }
  const [deviceErased, deviceControl] = deviceIds as [string, string];

  for (const [orgId, deviceId] of [
    [orgErased, deviceErased],
    [orgControl, deviceControl],
  ] as const) {
    await testDb.execute(sql`
      INSERT INTO device_hardware (device_id, org_id) VALUES (${deviceId}, ${orgId})
    `);
    await testDb.execute(sql`
      INSERT INTO alerts (device_id, org_id, severity, title)
      VALUES (${deviceId}, ${orgId}, 'high', 'Breadth alert')
    `);
    await testDb.execute(sql`
      INSERT INTO tickets (org_id, ticket_number, subject, created_at, updated_at)
      VALUES (${orgId}, ${`BR-${suffix}-${orgId.slice(0, 8)}`}, 'Breadth ticket', now(), now())
    `);
    await testDb.execute(sql`
      INSERT INTO audit_logs (org_id, actor_type, actor_id, action, resource_type, result, timestamp)
      VALUES (${orgId}, 'user', ${actorUserId}, 'test.breadth', 'test', 'success', now())
    `);
    // Append-only, audit-admin-only DELETE (role grant + BEFORE DELETE trigger).
    await testDb.execute(sql`
      INSERT INTO ml_feedback_events (org_id, source_type, source_id, event_type, outcome, occurred_at)
      VALUES (${orgId}, 'alert', ${`src-${suffix}`}, 'triage', 'true_positive', now())
    `);
    // Org-owned half of the dual-ownership pair.
    await testDb.execute(sql`
      INSERT INTO maintenance_windows (org_id, name, start_time, end_time, target_type, created_at, updated_at)
      VALUES (${orgId}, 'Org window', now(), now() + interval '1 hour', 'all', now(), now())
    `);
  }

  const [orgWindowErased] = (await testDb.execute(sql`
    SELECT id FROM maintenance_windows WHERE org_id = ${orgErased} LIMIT 1
  `)) as unknown as Array<{ id: string }>;

  // Partner-wide config row: org_id NULL XOR partner_id set. It belongs to no
  // org and must survive the erasure of one of the partner's orgs.
  const [partnerWindow] = (await testDb.execute(sql`
    INSERT INTO maintenance_windows (partner_id, name, start_time, end_time, target_type, created_at, updated_at)
    VALUES (${partnerId}, 'Partner-wide window', now(), now() + interval '1 hour', 'all', now(), now())
    RETURNING id
  `)) as unknown as Array<{ id: string }>;

  // Self-referencing chain: q1 <- q2 <- q3 via the composite
  // (revision_of_quote_id, org_id) -> quotes(id, org_id) NO ACTION FK.
  // `quotes_revision_number_chk` ties revision_number to the lineage column:
  // the root is 1 with a NULL parent, every revision is >= 2 with a parent.
  const chain: string[] = [];
  let previous: string | null = null;
  for (let revisionNumber = 1; revisionNumber <= 3; revisionNumber += 1) {
    const [quote] = (await testDb.execute(sql`
      INSERT INTO quotes (partner_id, org_id, currency_code, status, revision_of_quote_id, revision_number, created_at, updated_at)
      VALUES (${partnerId}, ${orgErased}, 'USD', 'draft', ${previous}, ${revisionNumber}, now(), now())
      RETURNING id
    `)) as unknown as Array<{ id: string }>;
    chain.push(quote!.id);
    previous = quote!.id;
  }
  // Sibling org gets its own quote so the control snapshot covers this table too.
  await testDb.execute(sql`
    INSERT INTO quotes (partner_id, org_id, currency_code, status, created_at, updated_at)
    VALUES (${partnerId}, ${orgControl}, 'USD', 'draft', now(), now())
  `);

  return {
    partnerId,
    actorUserId,
    orgErased,
    orgControl,
    siteErased,
    siteControl,
    deviceErased,
    deviceControl,
    quoteChainErased: chain as [string, string, string],
    partnerWideWindowId: partnerWindow!.id,
    orgWindowErasedId: orgWindowErased!.id,
  };
}

describe('cascadeDeleteOrg — erasure breadth', () => {
  let handles: SeedHandles;

  beforeEach(async () => {
    handles = await seed();
  });

  it('leaves ZERO rows for the erased org across the entire cascade list, and the sibling org untouched', async () => {
    // Sanity: the fixture actually landed rows in several shape classes, so a
    // green "0 residual rows" below cannot be vacuous.
    const before = await residualRowCounts(handles.orgErased);
    expect(before).toMatchObject({
      alerts: 1,
      audit_logs: 1,
      device_hardware: 1,
      devices: 1,
      maintenance_windows: 1,
      ml_feedback_events: 1,
      organizations: 1,
      quotes: 3,
      sites: 1,
      tickets: 1,
    });

    const controlBefore = await residualRowCounts(handles.orgControl);
    expect(Object.keys(controlBefore).length).toBeGreaterThan(5);

    const stats = await cascadeDeleteOrg(handles.orgErased, handles.actorUserId);
    expect(stats.orgId).toBe(handles.orgErased);
    expect(stats.tablesDeleted.organizations).toBe(1);
    expect(stats.tablesDeleted.quotes).toBe(3);

    // The property #3880 asks for: nothing keyed on the erased org survives
    // ANYWHERE in the cascade list — not just in the tables we happened to seed.
    const after = await residualRowCounts(handles.orgErased);
    expect(after).toEqual({});

    // ...and the erasure did not reach across the tenant boundary.
    const controlAfter = await residualRowCounts(handles.orgControl);
    expect(controlAfter).toEqual(controlBefore);
  });

  it('deletes append-only ml_feedback_events rows that the app role provably cannot', async () => {
    const testDb = getTestDb();

    // Negative control: without the audit-admin escalation the DELETE is
    // rejected outright (breeze_app holds no DELETE grant), so the escalation
    // branch inside cascadeDeleteOrg is doing real work here.
    let deniedCode: string | undefined;
    try {
      await getAppDb().execute(
        sql`DELETE FROM ml_feedback_events WHERE org_id = ${handles.orgErased}`,
      );
    } catch (err) {
      deniedCode = pgErrorCode(err);
    }
    expect(deniedCode).toBe('42501');

    const stats = await cascadeDeleteOrg(handles.orgErased, handles.actorUserId);
    expect(stats.tablesDeleted.ml_feedback_events).toBe(1);

    const remaining = (await testDb.execute(
      sql`SELECT id FROM ml_feedback_events WHERE org_id = ${handles.orgErased}`,
    )) as unknown as unknown[];
    expect(remaining.length).toBe(0);

    // The sibling org's append-only row is untouched.
    const sibling = (await testDb.execute(
      sql`SELECT id FROM ml_feedback_events WHERE org_id = ${handles.orgControl}`,
    )) as unknown as unknown[];
    expect(sibling.length).toBe(1);
  });

  it('erases a self-referencing quote revision chain in a single statement', async () => {
    const testDb = getTestDb();

    // The lineage really is 3 deep before the erasure.
    const lineage = (await testDb.execute(sql`
      SELECT id, revision_of_quote_id FROM quotes WHERE org_id = ${handles.orgErased} ORDER BY created_at
    `)) as unknown as Array<{ id: string; revision_of_quote_id: string | null }>;
    expect(lineage.map((r) => r.revision_of_quote_id)).toEqual([
      null,
      handles.quoteChainErased[0],
      handles.quoteChainErased[1],
    ]);

    // The assertion that matters: a NO ACTION self-FK does not make the single
    // `DELETE FROM quotes WHERE org_id = $1` raise 23503.
    const stats = await cascadeDeleteOrg(handles.orgErased, handles.actorUserId);
    expect(stats.tablesDeleted.quotes).toBe(3);

    const survivors = (await testDb.execute(
      sql`SELECT id FROM quotes WHERE org_id = ${handles.orgErased}`,
    )) as unknown as unknown[];
    expect(survivors.length).toBe(0);
  });

  it('erases device-scoped rows that denormalize org_id before their parent device', async () => {
    const testDb = getTestDb();

    const stats = await cascadeDeleteOrg(handles.orgErased, handles.actorUserId);
    expect(stats.tablesDeleted.device_hardware).toBe(1);
    expect(stats.tablesDeleted.alerts).toBe(1);
    expect(stats.tablesDeleted.devices).toBe(1);

    const orphans = (await testDb.execute(sql`
      SELECT 'device_hardware' AS t FROM device_hardware WHERE device_id = ${handles.deviceErased}
      UNION ALL
      SELECT 'alerts' FROM alerts WHERE device_id = ${handles.deviceErased}
      UNION ALL
      SELECT 'devices' FROM devices WHERE id = ${handles.deviceErased}
    `)) as unknown as unknown[];
    expect(orphans.length).toBe(0);

    // The sibling org's device and its denormalized children survive.
    const siblingRows = (await testDb.execute(sql`
      SELECT 'device_hardware' AS t FROM device_hardware WHERE device_id = ${handles.deviceControl}
      UNION ALL
      SELECT 'alerts' FROM alerts WHERE device_id = ${handles.deviceControl}
      UNION ALL
      SELECT 'devices' FROM devices WHERE id = ${handles.deviceControl}
    `)) as unknown as unknown[];
    expect(siblingRows.length).toBe(3);
  });

  it('keeps a partner-wide (org_id IS NULL) config row while erasing the org-owned sibling', async () => {
    const testDb = getTestDb();

    await cascadeDeleteOrg(handles.orgErased, handles.actorUserId);

    const orgWindow = (await testDb.execute(
      sql`SELECT id FROM maintenance_windows WHERE id = ${handles.orgWindowErasedId}`,
    )) as unknown as unknown[];
    expect(orgWindow.length).toBe(0);

    // Deleting this would destroy a policy every sibling org of the partner
    // still depends on.
    const partnerWide = (await testDb.execute(sql`
      SELECT org_id, partner_id FROM maintenance_windows WHERE id = ${handles.partnerWideWindowId}
    `)) as unknown as Array<{ org_id: string | null; partner_id: string | null }>;
    expect(partnerWide.length).toBe(1);
    expect(partnerWide[0]!.org_id).toBeNull();
    expect(partnerWide[0]!.partner_id).toBe(handles.partnerId);
  });
});

describe('cascadeDeleteOrg — failure semantics', () => {
  let handles: SeedHandles;

  beforeEach(async () => {
    handles = await seed();
  });

  /**
   * Pins the ACTUAL behaviour of a mid-walk failure, which is fail-fast +
   * partial + re-runnable, NOT atomic: each table's DELETE commits in its own
   * transaction (`withSystemDbAccessContext` -> `baseDb.transaction`), so
   * everything already processed stays deleted when a later table raises.
   *
   * The fault is injected the way #4100 occurred in production: an FK child
   * with no ON DELETE action pointing at a cascade-list table. The probe table
   * is created and dropped inside the test — `topologicalCascadeOrder()` only
   * considers members of `getOrgCascadeDeleteOrder()`, so the probe is
   * invisible to the ordering and its FK simply fires.
   */
  it('aborts on the first table failure, leaves the partial erasure committed, records it, and completes on re-run', async () => {
    const testDb = getTestDb();

    await testDb.execute(
      sql.raw(
        `CREATE TABLE cascade_abort_probe (
           id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
           site_id uuid NOT NULL REFERENCES sites(id)
         )`,
      ),
    );

    try {
      await testDb.execute(
        sql`INSERT INTO cascade_abort_probe (site_id) VALUES (${handles.siteErased})`,
      );

      // `sites` is a parent of `devices` and a child of `organizations`, so it
      // is walked late but before the org row itself.
      await expect(cascadeDeleteOrg(handles.orgErased, handles.actorUserId)).rejects.toThrow(
        /DELETE from "sites" failed/,
      );

      // Partial, by design: tables walked before `sites` are already committed.
      const residual = await residualRowCounts(handles.orgErased);
      expect(residual.devices ?? 0).toBe(0);
      expect(residual.device_hardware ?? 0).toBe(0);
      expect(residual.quotes ?? 0).toBe(0);
      // ...and the walk really did stop: the org row (last in the order) and
      // the blocked table are both still there.
      expect(residual.organizations).toBe(1);
      expect(residual.sites).toBe(1);

      // The forensic breadcrumb survives because it is written with org_id NULL.
      const failedRows = (await testDb.execute(sql`
        SELECT org_id, result, details
          FROM audit_logs
         WHERE action = 'tenant.erasure.failed'
           AND resource_id = ${handles.orgErased}
      `)) as unknown as Array<{
        org_id: string | null;
        result: string;
        details: { failedTable?: string; tablesDeleted?: Record<string, number> };
      }>;
      expect(failedRows.length).toBe(1);
      expect(failedRows[0]!.org_id).toBeNull();
      expect(failedRows[0]!.result).toBe('failure');
      expect(failedRows[0]!.details.failedTable).toBe('sites');
      expect(failedRows[0]!.details.tablesDeleted?.devices).toBe(1);

      // No tenant.erasure.completed was written for the aborted attempt.
      const completedRows = (await testDb.execute(sql`
        SELECT id FROM audit_logs
         WHERE action = 'tenant.erasure.completed' AND resource_id = ${handles.orgErased}
      `)) as unknown as unknown[];
      expect(completedRows.length).toBe(0);

      // Re-runnable: clear the fault and the SAME call finishes the job.
      await testDb.execute(sql`DELETE FROM cascade_abort_probe`);
      const stats = await cascadeDeleteOrg(handles.orgErased, handles.actorUserId);
      expect(stats.tablesDeleted.sites).toBe(1);
      expect(stats.tablesDeleted.organizations).toBe(1);
      expect(await residualRowCounts(handles.orgErased)).toEqual({});

      // The sibling org never lost a row to either attempt.
      const controlAfter = await residualRowCounts(handles.orgControl);
      expect(controlAfter.organizations).toBe(1);
      expect(controlAfter.devices).toBe(1);
    } finally {
      await testDb.execute(sql.raw('DROP TABLE IF EXISTS cascade_abort_probe'));
    }
  });
});
