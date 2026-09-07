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
 * ## Partner-wide self-reference (`script_categories`, #4873)
 *
 * The third `describe` covers the shape PR #4863 (issue #4519) proved was a
 * live erasure failure: a partner-wide category (`org_id` NULL) whose
 * `parent_id` points at an org-owned one SURVIVES `DELETE ... WHERE org_id =
 * $1` and used to raise 23503. It is fixed in two layers, and both are pinned
 * here — the constraint trigger that makes the row unconstructible, and the
 * `ON DELETE SET NULL` that makes erasure survive it anyway (proven by forging
 * the row with the trigger disabled, so the FK action is the only thing left
 * doing the work).
 *
 * ## Deliberately NOT seeded
 *
 * `restore_jobs.command_id` (#4871) remains an open bug. Seeding it here would
 * make this suite red for a defect it is not fixing, so it is skipped on
 * purpose and named instead.
 */
import './setup';
import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { getTestDb, getAppDb } from './setup';
import { cascadeDeleteOrg, getOrgCascadeDeleteOrder } from '../../services/tenantCascade';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pgErrorCode, pgErrorConstraint } from '../../utils/pgErrors';

/**
 * The #4873 migration, replayed verbatim in one test below so its cleanup DML
 * is exercised against real drift rather than trusted. It is idempotent, so a
 * second application is a no-op apart from the cleanup itself.
 */
const SCRIPT_CATEGORIES_GUARD_SQL = readFileSync(
  join(__dirname, '../../../migrations/2026-10-13-120000-script-categories-parent-ownership-guard.sql'),
  'utf8',
);

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
  /** A second partner, for the cross-partner cases. */
  partnerOtherId: string;
  /** Partner-wide category owned by `partnerOtherId`. */
  partnerOtherWideCategoryId: string;
  /** Org-owned parent category belonging to `orgErased`. */
  orgCategoryErasedId: string;
  /** Org-owned child of `orgCategoryErasedId`, same org. */
  orgCategoryChildErasedId: string;
  /** Partner-wide category, child of `partnerWideCategoryParentId`. */
  partnerWideCategoryChildId: string;
  /** Partner-wide category, parent of the row above. */
  partnerWideCategoryParentId: string;
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

  // script_categories: the dual-axis self-reference from #4873. An org-owned
  // parent for the erased org (org rows carry BOTH org_id and their org's
  // partner_id — see the 2026-06-13 partner-axis backfill), plus a LEGAL
  // partner-wide family (partner-wide child under a partner-wide parent) that
  // must survive the erasure untouched.
  const [orgCategory] = (await testDb.execute(sql`
    INSERT INTO script_categories (org_id, partner_id, name)
    VALUES (${orgErased}, ${partnerId}, ${`Org category ${suffix}`})
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const [orgCategoryChild] = (await testDb.execute(sql`
    INSERT INTO script_categories (org_id, partner_id, name, parent_id)
    VALUES (${orgErased}, ${partnerId}, ${`Org child category ${suffix}`}, ${orgCategory!.id})
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const [partnerWideCategoryParent] = (await testDb.execute(sql`
    INSERT INTO script_categories (partner_id, name)
    VALUES (${partnerId}, ${`Partner-wide parent ${suffix}`})
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const [partnerWideCategoryChild] = (await testDb.execute(sql`
    INSERT INTO script_categories (partner_id, name, parent_id)
    VALUES (${partnerId}, ${`Partner-wide child ${suffix}`}, ${partnerWideCategoryParent!.id})
    RETURNING id
  `)) as unknown as Array<{ id: string }>;

  // A SECOND partner, so the cross-partner arm of the ownership rule is
  // exercised against a genuinely different tenant rather than a same-partner
  // near-miss.
  const [partnerOther] = (await testDb.execute(sql`
    INSERT INTO partners (name, slug, status, created_at, updated_at)
    VALUES ('Breadth Other Partner', ${`breadth-other-${suffix}`}, 'active', now(), now())
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const [partnerOtherWideCategory] = (await testDb.execute(sql`
    INSERT INTO script_categories (partner_id, name)
    VALUES (${partnerOther!.id}, ${`Other partner-wide ${suffix}`})
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
    partnerOtherId: partnerOther!.id,
    partnerOtherWideCategoryId: partnerOtherWideCategory!.id,
    orgCategoryErasedId: orgCategory!.id,
    orgCategoryChildErasedId: orgCategoryChild!.id,
    partnerWideCategoryChildId: partnerWideCategoryChild!.id,
    partnerWideCategoryParentId: partnerWideCategoryParent!.id,
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
      script_categories: 2,
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

describe('cascadeDeleteOrg — partner-wide self-reference (script_categories, #4873)', () => {
  let handles: SeedHandles;

  beforeEach(async () => {
    handles = await seed();
  });

  /**
   * The GUARD layer: the offending row cannot be built. Asserted from the
   * TEST connection, which is the most privileged one available here — if the
   * guard held only for `breeze_app` it would be trivially bypassable by every
   * background/system path, which is where an org merge or a seed script runs.
   */
  it('refuses a partner-wide child under an org-owned parent', async () => {
    const testDb = getTestDb();
    let code: string | undefined;
    let constraint: string | undefined;
    try {
      await testDb.execute(sql`
        INSERT INTO script_categories (partner_id, name, parent_id)
        VALUES (${handles.partnerId}, 'forged partner-wide child', ${handles.orgCategoryErasedId})
      `);
    } catch (err) {
      code = pgErrorCode(err);
      constraint = pgErrorConstraint(err);
    }
    expect(code).toBe('23514');
    expect(constraint).toBe('script_categories_parent_guard');
  });

  it("refuses a child of ANOTHER org's parent", async () => {
    const testDb = getTestDb();
    let code: string | undefined;
    let constraint: string | undefined;
    try {
      await testDb.execute(sql`
        INSERT INTO script_categories (org_id, partner_id, name, parent_id)
        VALUES (${handles.orgControl}, ${handles.partnerId}, 'forged cross-org child', ${handles.orgCategoryErasedId})
      `);
    } catch (err) {
      code = pgErrorCode(err);
      constraint = pgErrorConstraint(err);
    }
    expect(code).toBe('23514');
    expect(constraint).toBe('script_categories_parent_guard');
  });

  it("refuses a partner-wide child under ANOTHER partner's partner-wide parent", async () => {
    const testDb = getTestDb();
    let code: string | undefined;
    let constraint: string | undefined;
    try {
      await testDb.execute(sql`
        INSERT INTO script_categories (partner_id, name, parent_id)
        VALUES (${handles.partnerId}, 'forged cross-partner child', ${handles.partnerOtherWideCategoryId})
      `);
    } catch (err) {
      code = pgErrorCode(err);
      constraint = pgErrorConstraint(err);
    }
    expect(code).toBe('23514');
    expect(constraint).toBe('script_categories_parent_guard');
  });

  it("refuses an org-owned child under ANOTHER partner's partner-wide parent", async () => {
    const testDb = getTestDb();
    let code: string | undefined;
    let constraint: string | undefined;
    try {
      await testDb.execute(sql`
        INSERT INTO script_categories (org_id, partner_id, name, parent_id)
        VALUES (${handles.orgErased}, ${handles.partnerId}, 'forged cross-partner org child', ${handles.partnerOtherWideCategoryId})
      `);
    } catch (err) {
      code = pgErrorCode(err);
      constraint = pgErrorConstraint(err);
    }
    expect(code).toBe('23514');
    expect(constraint).toBe('script_categories_parent_guard');
  });

  it('allows an org-owned child under a partner-wide parent of its own partner', async () => {
    const testDb = getTestDb();
    const [row] = (await testDb.execute(sql`
      INSERT INTO script_categories (org_id, partner_id, name, parent_id)
      VALUES (${handles.orgErased}, ${handles.partnerId}, 'legal org child', ${handles.partnerWideCategoryParentId})
      RETURNING id
    `)) as unknown as Array<{ id: string }>;
    expect(row?.id).toMatch(UUID_RE);
  });

  /**
   * The FK-ACTION layer, and the actual erasure regression. The guard is
   * DISABLED for the duration so the illegal edge — the one #4863 reproduced against
   * Postgres 16 — really exists in the table. That leaves `ON DELETE SET NULL`
   * as the ONLY thing standing between the cascade and 23503, so a green here
   * is evidence about the FK action and nothing else.
   */
  it('erases the org even when a partner-wide child already points at an org-owned parent', async () => {
    const testDb = getTestDb();

    let forgedChildId: string;
    await testDb.execute(
      sql.raw('ALTER TABLE script_categories DISABLE TRIGGER script_categories_parent_guard'),
    );
    try {
      const [forged] = (await testDb.execute(sql`
        INSERT INTO script_categories (partner_id, name, parent_id)
        VALUES (${handles.partnerId}, 'forged partner-wide child', ${handles.orgCategoryErasedId})
        RETURNING id
      `)) as unknown as Array<{ id: string }>;
      forgedChildId = forged!.id;
    } finally {
      await testDb.execute(
        sql.raw('ALTER TABLE script_categories ENABLE TRIGGER script_categories_parent_guard'),
      );
    }

    // Control: the forged edge is really in place, so the erasure below is
    // exercising it rather than passing vacuously.
    const forgedBefore = (await testDb.execute(sql`
      SELECT org_id, parent_id FROM script_categories WHERE id = ${forgedChildId}
    `)) as unknown as Array<{ org_id: string | null; parent_id: string | null }>;
    expect(forgedBefore[0]!.org_id).toBeNull();
    expect(forgedBefore[0]!.parent_id).toBe(handles.orgCategoryErasedId);

    const stats = await cascadeDeleteOrg(handles.orgErased, handles.actorUserId);
    expect(stats.tablesDeleted.script_categories).toBe(2);
    expect(await residualRowCounts(handles.orgErased)).toEqual({});

    // The partner-wide row is not the erased org's data: it survives, detached.
    const forgedAfter = (await testDb.execute(sql`
      SELECT parent_id FROM script_categories WHERE id = ${forgedChildId}
    `)) as unknown as Array<{ parent_id: string | null }>;
    expect(forgedAfter.length).toBe(1);
    expect(forgedAfter[0]!.parent_id).toBeNull();

    // ...and the legal partner-wide family is untouched.
    const family = (await testDb.execute(sql`
      SELECT id, parent_id FROM script_categories WHERE id = ${handles.partnerWideCategoryChildId}
    `)) as unknown as Array<{ id: string; parent_id: string | null }>;
    expect(family.length).toBe(1);
    expect(family[0]!.parent_id).toBe(handles.partnerWideCategoryParentId);
  });

  /**
   * The reason the guard is a DEFERRABLE CONSTRAINT trigger rather than a plain
   * one: org merge runs `SET CONSTRAINTS ALL DEFERRED` and re-points parent and
   * child `org_id` in SEPARATE statements. An immediate trigger would reject the
   * first of those, so this proves the whole family can move inside one
   * transaction and is only validated at COMMIT.
   */
  it('lets an org move re-point a whole parent+child family under SET CONSTRAINTS ALL DEFERRED', async () => {
    const testDb = getTestDb();

    await testDb.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('breeze.scope', 'system', true)`);
      await tx.execute(sql.raw('SET CONSTRAINTS ALL DEFERRED'));
      // Parent first: mid-transaction this leaves the child pointing across
      // orgs, which an INITIALLY IMMEDIATE trigger would reject here.
      await tx.execute(sql`
        UPDATE script_categories SET org_id = ${handles.orgControl} WHERE id = ${handles.orgCategoryErasedId}
      `);
      await tx.execute(sql`
        UPDATE script_categories SET org_id = ${handles.orgControl} WHERE id = ${handles.orgCategoryChildErasedId}
      `);
    });

    const moved = (await testDb.execute(sql`
      SELECT id, org_id FROM script_categories
       WHERE id IN (${handles.orgCategoryErasedId}, ${handles.orgCategoryChildErasedId})
    `)) as unknown as Array<{ id: string; org_id: string | null }>;
    expect(moved.length).toBe(2);
    expect(moved.every((r) => r.org_id === handles.orgControl)).toBe(true);
  });

  it('rejects at COMMIT an org move that re-points only the parent', async () => {
    const testDb = getTestDb();

    let code: string | undefined;
    let constraint: string | undefined;
    try {
      await testDb.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('breeze.scope', 'system', true)`);
        await tx.execute(sql.raw('SET CONSTRAINTS ALL DEFERRED'));
        await tx.execute(sql`
          UPDATE script_categories SET org_id = ${handles.orgControl} WHERE id = ${handles.orgCategoryErasedId}
        `);
      });
    } catch (err) {
      code = pgErrorCode(err);
      constraint = pgErrorConstraint(err);
    }
    expect(code).toBe('23514');
    expect(constraint).toBe('script_categories_parent_guard');

    // Rolled back, so the family is intact.
    const stillErased = (await testDb.execute(sql`
      SELECT org_id FROM script_categories WHERE id = ${handles.orgCategoryErasedId}
    `)) as unknown as Array<{ org_id: string | null }>;
    expect(stillErased[0]!.org_id).toBe(handles.orgErased);
  });

  /**
   * Ownership moves are system-only. The incoming-edge scan below that gate is
   * an `EXISTS` over other tenants' rows, which fails OPEN when RLS hides them
   * — refusing the non-system move outright is what keeps the guard symmetric
   * with the outgoing-edge check (which fails closed via NOT FOUND).
   */
  it('refuses an ownership move outside system scope', async () => {
    const testDb = getTestDb();

    let code: string | undefined;
    let constraint: string | undefined;
    try {
      await testDb.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('breeze.scope', 'partner', true)`);
        await tx.execute(sql`
          UPDATE script_categories SET org_id = ${handles.orgControl} WHERE id = ${handles.orgCategoryChildErasedId}
        `);
      });
    } catch (err) {
      code = pgErrorCode(err);
      constraint = pgErrorConstraint(err);
    }
    expect(code).toBe('23514');
    expect(constraint).toBe('script_categories_owner_immutable');
  });

  /**
   * The migration's cleanup DML, replayed against real drift. Without this the
   * `UPDATE ... WHERE ... IS NOT TRUE` is never executed against a row it is
   * supposed to fix, and a reversed predicate or a wrong join column would look
   * exactly like a clean database.
   */
  it('the migration cleanup detaches a pre-existing cross-axis parent and leaves legal ones alone', async () => {
    const testDb = getTestDb();

    // Forge the drift the cleanup targets, with the guard out of the way.
    let forgedId: string;
    await testDb.execute(
      sql.raw('ALTER TABLE script_categories DISABLE TRIGGER script_categories_parent_guard'),
    );
    try {
      const [forged] = (await testDb.execute(sql`
        INSERT INTO script_categories (partner_id, name, parent_id)
        VALUES (${handles.partnerId}, 'pre-existing cross-axis child', ${handles.orgCategoryErasedId})
        RETURNING id
      `)) as unknown as Array<{ id: string }>;
      forgedId = forged!.id;
    } finally {
      await testDb.execute(
        sql.raw('ALTER TABLE script_categories ENABLE TRIGGER script_categories_parent_guard'),
      );
    }

    await testDb.execute(sql.raw(SCRIPT_CATEGORIES_GUARD_SQL));

    const cleaned = (await testDb.execute(sql`
      SELECT parent_id FROM script_categories WHERE id = ${forgedId}
    `)) as unknown as Array<{ parent_id: string | null }>;
    expect(cleaned[0]!.parent_id).toBeNull();

    // The legal edges are untouched — the cleanup is not a blanket detach.
    const legal = (await testDb.execute(sql`
      SELECT id, parent_id FROM script_categories
       WHERE id IN (${handles.partnerWideCategoryChildId}, ${handles.orgCategoryChildErasedId})
       ORDER BY id
    `)) as unknown as Array<{ id: string; parent_id: string | null }>;
    expect(legal.length).toBe(2);
    expect(legal.every((r) => r.parent_id !== null)).toBe(true);
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
