import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getTableName } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import * as schema from '../../db/schema';
import { aiAgentRuns } from '../../db/schema';
import {
  CUSTOM_ORG_REWRITE_TABLES,
  getDeviceCascadeDeleteTables,
  DEVICE_DETACH_DEVICE_ID_TABLES,
  getDeviceOrgDenormalizedTables,
  DEVICE_ORG_DENORMALIZED_TABLES,
  DEVICE_ORG_FK_CASCADE_TABLES,
  DEVICE_SITE_DENORMALIZED_TABLES,
} from './core';

/**
 * Mirrors cascadeDelete.test.ts but for the `org_id` denormalization list.
 *
 * `POST /devices/:id/move-org` works by rewriting the denormalized `org_id`
 * column on every device-scoped table inside the same transaction that
 * flips `devices.org_id`. If a new device-scoped table is added with an
 * `org_id` column but NOT returned by getDeviceOrgDenormalizedTables(), the move
 * will strand its rows under the OLD org's RLS — invisible to the new org.
 *
 * This test catches that drift at CI time.
 *
 * Tables that intentionally don't denormalize `org_id` (e.g. `device_commands`
 * which is system-scoped per RLS policy) are listed in INTENTIONALLY_NO_ORG_ID
 * here and must match the comment in core.ts.
 */
const INTENTIONALLY_NO_ORG_ID: ReadonlySet<string> = new Set([
  // Has org_id, but it is intentionally NOT re-stamped on move: agent-run
  // history stays with the source org (owner decision 2026-08-23) — see the
  // CORE_DEVICE_ORG_DENORMALIZED_TABLES comment in core.ts.
  'ai_agent_runs',
  // Has org_id, but it is intentionally NOT re-stamped on move: exposure
  // history stays with the org the unattended action ran in (same
  // ai_agent_runs decision above), and a bare org_id repoint would violate
  // the (org_id, partner_id) composite FK across partners — see the
  // CORE_DEVICE_ORG_DENORMALIZED_TABLES comment in core.ts.
  'ai_unattended_exposure',
  // Has org_id AND device_id, but org_id is intentionally NOT re-stamped on
  // move: a fix-held watch's org attribution stays with the run it watches,
  // which itself never follows a device move (ai_agent_runs above) — see
  // the CORE_DEVICE_ORG_DENORMALIZED_TABLES comment in core.ts.
  'ai_agent_fix_watches',
  // Durable PAM ownership history is frozen in its source org. A device with
  // any actuation is non-transferable, so neither table participates in an
  // organization-move rewrite.
  'pam_actuations',
  'pam_actuation_results',
  'automation_policy_compliance',
  'deployment_devices',
  'deployment_results',
  'device_commands',
  'device_software',
  'patch_job_results',
  'patch_rollbacks',
  'psa_ticket_mappings',
  'software_compliance_status',
]);

const deviceCascadeDeleteTables = getDeviceCascadeDeleteTables();
const deviceOrgDenormalizedTables = getDeviceOrgDenormalizedTables();

function getColumns(table: PgTable<any>): any[] {
  return Object.values(
    (table as any)[Symbol.for('drizzle:Columns')] ?? {},
  );
}

describe('getDeviceOrgDenormalizedTables() coverage', () => {
  const denormSet = new Set<string>(deviceOrgDenormalizedTables);
  // Device-managed tables = cascade-deleted ∪ detached (device_id SET NULL,
  // e.g. tickets). Both kinds must keep org_id in sync on cross-org moves.
  const managedSet = new Set<string>([
    ...deviceCascadeDeleteTables,
    ...DEVICE_DETACH_DEVICE_ID_TABLES,
  ]);

  const allTables = Object.values(schema).filter(
    (v) => v instanceof PgTable,
  ) as PgTable<any>[];

  it('includes every device-managed table that also has an org_id column', () => {
    const missing: string[] = [];

    for (const table of allTables) {
      const name = getTableName(table);
      if (!managedSet.has(name)) continue;
      if (INTENTIONALLY_NO_ORG_ID.has(name)) continue;

      const cols = getColumns(table);
      const hasOrgId = cols.some((c) => c.name === 'org_id');
      if (hasOrgId && !denormSet.has(name)) {
        missing.push(name);
      }
    }

    expect(
      missing,
      `These tables are in getDeviceCascadeDeleteTables() or DEVICE_DETACH_DEVICE_ID_TABLES and have an org_id column ` +
        `but are missing from getDeviceOrgDenormalizedTables() in core.ts. ` +
        `Add them, or — if their org_id is intentionally not denormalized for ` +
        `move purposes — add them to INTENTIONALLY_NO_ORG_ID in this test ` +
        `AND to the comment block in core.ts.\n\nMissing: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('only lists tables that exist in the schema', () => {
    const allNames = new Set(allTables.map((t) => getTableName(t)));
    const stale = DEVICE_ORG_DENORMALIZED_TABLES.filter((t) => !allNames.has(t));
    expect(
      stale,
      `These core tables are in DEVICE_ORG_DENORMALIZED_TABLES but no longer exist in the schema. Remove them.`,
    ).toEqual([]);
  });

  it('only lists tables that actually have an org_id column', () => {
    const tablesWithoutOrgId: string[] = [];
    const tableByName = new Map(allTables.map((t) => [getTableName(t), t] as const));

    for (const name of deviceOrgDenormalizedTables) {
      const table = tableByName.get(name);
      if (!table) continue; // covered by the stale-name test above
      const hasOrgId = getColumns(table).some((c) => c.name === 'org_id');
      if (!hasOrgId) tablesWithoutOrgId.push(name);
    }

    expect(
      tablesWithoutOrgId,
      `These tables are returned by getDeviceOrgDenormalizedTables() but do not have an org_id column. ` +
        `Move them to INTENTIONALLY_NO_ORG_ID, or remove from the denormalized list.`,
    ).toEqual([]);
  });

  it('all listed tables are also device-managed (cascade-deleted or detached)', () => {
    // Sanity: a denormalized device table that is neither cascade-deleted
    // nor detached on permanent delete is a bug elsewhere; flag it here so
    // we don't ship a half-managed table.
    // Core tables only: extension-declared tables prove device management in
    // their own migrations (DB-level FK actions, e.g. ON DELETE SET NULL) and
    // integration tests — the app-level cascade/detach lists don't see them.
    const coreSet = new Set<string>(DEVICE_ORG_DENORMALIZED_TABLES);
    const orphans = deviceOrgDenormalizedTables.filter(
      (t) => coreSet.has(t) && !managedSet.has(t)
    );
    expect(
      orphans,
      `These tables are in getDeviceOrgDenormalizedTables() but missing from both ` +
        `getDeviceCascadeDeleteTables() and DEVICE_DETACH_DEVICE_ID_TABLES.`,
    ).toEqual([]);
  });

  it('includes ML output tables so device moves do not strand old-org rows', () => {
    expect(deviceOrgDenormalizedTables).toContain('metric_anomalies');
    expect(deviceOrgDenormalizedTables).toContain('remediation_suggestions');
  });

  it('keeps database-cascade restamps registered in the complete org-denormalized contract', () => {
    // agent_rollback_events (#4371 fixup): breeze_app has UPDATE revoked
    // entirely, so its restamp runs via the SECURITY DEFINER
    // breeze_cascade_device_org_id() trigger instead of an ON UPDATE CASCADE
    // FK — see the DEVICE_ORG_FK_CASCADE_TABLES doc comment in core.ts.
    expect(DEVICE_ORG_FK_CASCADE_TABLES).toEqual([
      'agent_health_observations',
      'software_inventory_observations',
      'agent_rollback_events',
    ]);
    expect(deviceOrgDenormalizedTables).toEqual(
      expect.arrayContaining([...DEVICE_ORG_FK_CASCADE_TABLES]),
    );
  });
});

/**
 * CUSTOM_ORG_REWRITE_TABLES — documented exemption from the generic loop.
 *
 * These tables denormalize `org_id` for RLS but have NO `device_id` column,
 * so the generic getDeviceOrgDenormalizedTables() loop in moveOrg.ts (which
 * keys on `WHERE device_id = ...`) cannot reach them. Each gets a dedicated,
 * hand-written UPDATE inside the move-org transaction — e.g.
 * `ticket_alert_links` is rewritten via its alert_id join to alerts.device_id.
 *
 * The dedicated statements are covered by behavior tests in moveOrg.test.ts.
 * This block only guards the list shape, so a future table can't silently
 * skip BOTH the generic loop and the custom-rewrite path:
 *   - it must be disjoint from the generic / device-managed lists (a table
 *     with a device_id column belongs in the generic loop instead), and
 *   - every entry must exist in the schema with org_id but without device_id.
 */
describe('CUSTOM_ORG_REWRITE_TABLES coverage', () => {
  const customSet = new Set<string>(CUSTOM_ORG_REWRITE_TABLES);

  const allTables = Object.values(schema).filter(
    (v) => v instanceof PgTable,
  ) as PgTable<any>[];
  const tableByName = new Map(allTables.map((t) => [getTableName(t), t] as const));

  it('contains ticket_alert_links (the known no-device_id org-denormalized table)', () => {
    expect(CUSTOM_ORG_REWRITE_TABLES).toContain('ticket_alert_links');
  });

  it('contains time_entries and ticket_parts (Phase 3 billing rows, no device_id column)', () => {
    expect(CUSTOM_ORG_REWRITE_TABLES).toContain('time_entries');
    expect(CUSTOM_ORG_REWRITE_TABLES).toContain('ticket_parts');
  });

  it('contains ticket_attachments (W08: org_id denormalized from tickets, no device_id)', () => {
    expect(CUSTOM_ORG_REWRITE_TABLES).toContain('ticket_attachments');
  });

  it('contains ticket_outbox (#4743: org_id denormalized from tickets, no device_id)', () => {
    expect(CUSTOM_ORG_REWRITE_TABLES).toContain('ticket_outbox');
  });

  it('contains ticket_email_links (#4643: org_id denormalized from tickets, no device_id)', () => {
    expect(CUSTOM_ORG_REWRITE_TABLES).toContain('ticket_email_links');
  });

  it('is disjoint from the generic denorm, device-managed, and intentional-exclusion lists', () => {
    const overlapping = [
      ...deviceOrgDenormalizedTables.filter((t) => customSet.has(t)).map(
        (t) => `${t} (also in getDeviceOrgDenormalizedTables())`,
      ),
      ...deviceCascadeDeleteTables.filter((t) => customSet.has(t)).map(
        (t) => `${t} (also in getDeviceCascadeDeleteTables())`,
      ),
      ...DEVICE_DETACH_DEVICE_ID_TABLES.filter((t) => customSet.has(t)).map(
        (t) => `${t} (also in DEVICE_DETACH_DEVICE_ID_TABLES)`,
      ),
      ...[...INTENTIONALLY_NO_ORG_ID].filter((t) => customSet.has(t)).map(
        (t) => `${t} (also in INTENTIONALLY_NO_ORG_ID)`,
      ),
    ];
    expect(
      overlapping,
      `CUSTOM_ORG_REWRITE_TABLES must be disjoint from the generic move-org ` +
        `lists — a table is rewritten by exactly one path. If the table has a ` +
        `device_id column it belongs in getDeviceOrgDenormalizedTables(), not here.`,
    ).toEqual([]);
  });

  it('only lists tables that exist with an org_id column and WITHOUT a device_id column', () => {
    const invalid: string[] = [];

    for (const name of CUSTOM_ORG_REWRITE_TABLES) {
      const table = tableByName.get(name);
      if (!table) {
        invalid.push(`${name} (table no longer exists in the schema)`);
        continue;
      }
      const cols = getColumns(table);
      if (!cols.some((c) => c.name === 'org_id')) {
        invalid.push(`${name} (has no org_id column — nothing to rewrite)`);
      }
      if (cols.some((c) => c.name === 'device_id')) {
        invalid.push(
          `${name} (has a device_id column — move it to getDeviceOrgDenormalizedTables(); ` +
            `the generic loop can reach it)`,
        );
      }
    }

    expect(invalid, `Stale or misplaced entries in CUSTOM_ORG_REWRITE_TABLES (core.ts).`).toEqual([]);
  });
});

/**
 * Mirror of the org_id coverage block, for `site_id`.
 *
 * Both write paths that change `devices.site_id` — `POST /devices/:id/move-org`
 * (cross-org move) and `PATCH /devices/:id` (same-org site change) — must
 * rewrite `site_id` on every table in DEVICE_SITE_DENORMALIZED_TABLES inside
 * the same transaction, otherwise child rows stay pinned to the OLD site
 * after the parent device has moved.
 *
 * The list currently contains `elevation_requests`. The drift detector below
 * ensures any future schema PR that adds a `site_id` column to another
 * device-id-scoped table fails CI until the table is added to
 * DEVICE_SITE_DENORMALIZED_TABLES in core.ts.
 *
 * NOTE this detector only guards the CONSTANT against the schema — it cannot
 * verify the route handlers actually consume the constant. Handler-level
 * propagation is covered by behavior tests: moveOrg.test.ts (move-org path)
 * and core.permissions.test.ts (PATCH path).
 */
describe('DEVICE_SITE_DENORMALIZED_TABLES coverage', () => {
  const siteDenormSet = new Set<string>(DEVICE_SITE_DENORMALIZED_TABLES);

  const allTables = Object.values(schema).filter(
    (v) => v instanceof PgTable,
  ) as PgTable<any>[];

  it('includes every table that has both a device_id and a site_id column', () => {
    const missing: string[] = [];

    for (const table of allTables) {
      const name = getTableName(table);
      // Skip the devices table itself — it owns site_id, doesn't denormalize it.
      if (name === 'devices') continue;

      const cols = getColumns(table);
      const hasDeviceId = cols.some((c) => c.name === 'device_id');
      const hasSiteId = cols.some((c) => c.name === 'site_id');
      if (hasDeviceId && hasSiteId && !siteDenormSet.has(name)) {
        missing.push(name);
      }
    }

    expect(
      missing,
      `These tables have BOTH a device_id and a site_id column but are missing ` +
        `from DEVICE_SITE_DENORMALIZED_TABLES in core.ts. Cross-site moves ` +
        `via POST /devices/:id/move-org will strand their rows under the OLD ` +
        `site_id. Add them to DEVICE_SITE_DENORMALIZED_TABLES.\n\nMissing: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('only lists tables that still exist in the schema with both columns', () => {
    const tableByName = new Map(allTables.map((t) => [getTableName(t), t] as const));
    const stale: string[] = [];

    for (const name of DEVICE_SITE_DENORMALIZED_TABLES) {
      const table = tableByName.get(name);
      if (!table) {
        stale.push(`${name} (table no longer exists)`);
        continue;
      }
      const cols = getColumns(table);
      const hasDeviceId = cols.some((c) => c.name === 'device_id');
      const hasSiteId = cols.some((c) => c.name === 'site_id');
      if (!hasDeviceId || !hasSiteId) {
        stale.push(`${name} (missing ${!hasDeviceId ? 'device_id' : ''}${!hasDeviceId && !hasSiteId ? ' and ' : ''}${!hasSiteId ? 'site_id' : ''})`);
      }
    }

    expect(
      stale,
      `These entries in DEVICE_SITE_DENORMALIZED_TABLES are stale — remove them ` +
        `or fix the schema.`,
    ).toEqual([]);
  });
});

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../migrations/', import.meta.url));

/**
 * Newest migration that (re)defines breeze_cascade_device_org_id(), resolved
 * the same way autoMigrate applies files — filename `localeCompare` order,
 * last definition wins — and sliced down to that function's body so an
 * unrelated `UPDATE public.ai_agent_runs` elsewhere in the same file (e.g. a
 * scripted backfill) cannot stand in for a statement the body dropped.
 *
 * Resolved dynamically rather than by hardcoded filename so a later migration
 * replacing the function again cannot leave this contract silently asserting
 * a superseded definition. `CREATE FUNCTION` is matched as well as
 * `CREATE OR REPLACE FUNCTION`: a DROP + plain CREATE redefinition counts.
 */
const DEFINES_CASCADE_FN = /CREATE (OR REPLACE )?FUNCTION (public\.)?breeze_cascade_device_org_id/;

let cachedCascadeFn: { name: string; body: string } | undefined;

function newestCascadeFunctionBody(): { name: string; body: string } {
  if (cachedCascadeFn) return cachedCascadeFn;
  const definitions = readdirSync(MIGRATIONS_DIR)
    .filter((name) => /^\d{4}-.*\.sql$/.test(name))
    .sort((a, b) => a.localeCompare(b))
    .filter((name) => DEFINES_CASCADE_FN.test(readFileSync(`${MIGRATIONS_DIR}${name}`, 'utf8')));
  const name = definitions.at(-1);
  expect(name, 'no migration defines breeze_cascade_device_org_id()').toBeTruthy();

  const src = readFileSync(`${MIGRATIONS_DIR}${name}`, 'utf8');
  const body = src.match(
    /CREATE (?:OR REPLACE )?FUNCTION (?:public\.)?breeze_cascade_device_org_id[\s\S]*?\n\$\$;/,
  );
  expect(
    body,
    `${name} matched the function-definition pattern but its "AS $$ ... $$;" body could not be sliced out`,
  ).toBeTruthy();

  cachedCascadeFn = { name: name!, body: body![0] };
  return cachedCascadeFn;
}

/**
 * ai_agent_runs run-lineage detach coverage (#3828 branch-review blocker 2).
 *
 * ai_agent_runs deliberately does NOT follow the device on a cross-org move
 * (owner decision 2026-08-23 — see CORE_DEVICE_ORG_DENORMALIZED_TABLES'
 * comment above): run history stays with the SOURCE org, and moveOrg.ts
 * instead severs every FK column that points at a row which DOES move with
 * the device (either the device row itself, or a table returned by
 * getDeviceOrgDenormalizedTables()). Left un-severed, such a column would
 * point across tenants the moment its target is re-stamped to the
 * destination org — exactly the bug this blocker fixes for
 * `anomaly_incident_id`.
 *
 * The detach is duplicated in two places that must stay in sync: moveOrg.ts's
 * UPDATEs and breeze_cascade_device_org_id()'s identical UPDATEs (the DB-side
 * trigger, for direct-SQL/non-route callers). Each site needs TWO statements,
 * not one: `WHERE device_id = <moved>` cannot reach `ticket_id`, because
 * ticket-triggered runs are device-less (trigger_kind 'ticket' stamps
 * ticket_id and leaves device_id NULL), so ticket_id is severed by its own
 * `WHERE ticket_id IN (SELECT id FROM tickets WHERE device_id = <moved>)`
 * statement — the same join shape the ticket_attachments / time_entries /
 * ticket_parts org rewrites already use (#4215).
 *
 * This block derives the expected column set from the ai_agent_runs schema's
 * own FK columns — not a hand-maintained list — and checks BOTH halves of each
 * `UPDATE ai_agent_runs` statement at each site: which columns it nulls AND
 * which predicate it nulls them under. Presence alone is not enough — folding
 * `ticket_id = NULL` back into the device-keyed statement re-introduces #4215
 * (it would null nothing on a device-less run) while still satisfying a plain
 * set-equality check. So the next FK added to this table can neither skip both
 * detach sites the way anomaly_incident_id (#3828) did, nor be severed under a
 * predicate that cannot reach it the way ticket_id (#4215) was.
 *
 * Scope limits worth knowing:
 *  - This guards the DEVICE-move axis only. `moveTicketOrg`
 *    (services/ticketService.ts) moves a TICKET between orgs of the same
 *    partner and does NOT sever ai_agent_runs.ticket_id — same
 *    cross-tenant-pointer class, different axis, and (unlike ticket_drafts /
 *    action_intents there) it does not self-announce via a composite tenant FK,
 *    since ai_agent_runs.ticket_id is a plain single-column FK. Still open.
 *  - Both detach statements are org-blind, by inheritance from the device-keyed
 *    one: a run that already lives in the TARGET org and names the moved ticket
 *    is severed too, even though the pointer would have become legitimate
 *    post-move. Accepted — severing run lineage is the point.
 */
describe('ai_agent_runs run-lineage detach coverage', () => {
  const runsCfg = getTableConfig(aiAgentRuns);
  const denormTableSet = new Set<string>(getDeviceOrgDenormalizedTables());

  // Columns that reference the run's OWN identity, not a row that moves WITH
  // the device — must stay untouched by device-lineage detach.
  const NOT_DEVICE_LINEAGE: ReadonlySet<string> = new Set(['agent_id', 'org_id']);

  // Columns a run can carry while its OWN device_id is NULL, so the device-keyed
  // predicate can never reach them: they must be severed by a statement that
  // joins through their own table instead. `ticket_id` is the known member —
  // trigger_kind 'ticket' runs are device-less (#4215).
  const UNREACHABLE_FROM_DEVICE_ID: ReadonlySet<string> = new Set(['ticket_id']);

  interface RunUpdate {
    setClause: string;
    whereClause: string;
  }

  function deriveExpectedDetachColumns(): string[] {
    const expected: string[] = [];
    for (const fk of runsCfg.foreignKeys) {
      const ref = fk.reference();
      const [column] = ref.columns;
      if (!column) continue;
      if (NOT_DEVICE_LINEAGE.has(column.name)) continue;
      const foreignTableName = getTableName(ref.foreignTable);
      const isDeviceLineage = foreignTableName === 'devices' || denormTableSet.has(foreignTableName);
      if (!isDeviceLineage) continue;
      expected.push(column.name);
    }
    return expected.sort();
  }

  /**
   * Every `UPDATE <tableRef> SET ... WHERE ...` statement in `src`, split into
   * its SET and WHERE halves. `notTerminator` is the character class that ends
   * a statement at this site: a closing backtick for a Drizzle sql`` template,
   * a semicolon for SQL.
   */
  function runUpdateStatements(src: string, tableRef: string, notTerminator: string): RunUpdate[] {
    const re = new RegExp(`UPDATE ${tableRef}\\s+SET ([\\s\\S]*?)\\s*WHERE (${notTerminator}*)`, 'g');
    return [...src.matchAll(re)].map((m) => ({ setClause: m[1]!, whereClause: m[2]!.trim() }));
  }

  function detachedColumns(updates: RunUpdate[]): string[] {
    // `<col> = NULL` inside a SET clause (bulk org_id rewrites use
    // `= <param>`, never `= NULL`, so they cannot be confused for a detach).
    const columns = new Set<string>();
    for (const { setClause } of updates) {
      for (const m of setClause.matchAll(/\b([a-z_]+)\s*=\s*NULL\b/g)) columns.add(m[1]!);
    }
    return [...columns].sort();
  }

  /**
   * Asserts every derived column is severed exactly once, under a predicate
   * that can actually reach the rows carrying it.
   */
  function expectDetachShape(
    updates: RunUpdate[],
    site: string,
    deviceKeyed: RegExp,
    ticketJoin: RegExp,
  ): void {
    for (const column of deriveExpectedDetachColumns()) {
      const carriers = updates.filter((u) =>
        new RegExp(`\\b${column}\\s*=\\s*NULL\\b`).test(u.setClause),
      );
      expect(
        carriers,
        `${site}: expected exactly one statement to null ${column}, found ${carriers.length}`,
      ).toHaveLength(1);
      const { whereClause } = carriers[0]!;
      if (UNREACHABLE_FROM_DEVICE_ID.has(column)) {
        expect(
          whereClause,
          `${site}: ${column} is severed under "${whereClause}". A run can carry ${column} with a NULL device_id, so a device-keyed predicate reaches none of those rows — sever it through its own table's join instead (#4215).`,
        ).toMatch(ticketJoin);
      } else {
        expect(
          whereClause,
          `${site}: ${column} must be severed by the device-keyed statement, not "${whereClause}"`,
        ).toMatch(deviceKeyed);
      }
    }
  }

  const moveOrgSource = () =>
    readFileSync(fileURLToPath(new URL('./moveOrg.ts', import.meta.url)), 'utf8');

  it('sanity: the derived expected set is non-empty and contains every device-lineage column', () => {
    const expected = deriveExpectedDetachColumns();
    expect(expected.length).toBeGreaterThan(0);
    expect(expected).toEqual(
      expect.arrayContaining([
        'device_id',
        'alert_id',
        'session_id',
        'anomaly_incident_id',
        'ticket_id',
      ]),
    );
  });

  it('moveOrg.ts detaches exactly the derived run-lineage columns', () => {
    const updates = runUpdateStatements(moveOrgSource(), 'ai_agent_runs', '[^`]');
    expect(
      updates.length,
      'moveOrg.ts no longer has any "UPDATE ai_agent_runs SET ... WHERE ..." statement — update this test if the statement shape changed intentionally',
    ).toBeGreaterThan(0);

    expect(detachedColumns(updates)).toEqual(deriveExpectedDetachColumns());
  });

  it('moveOrg.ts severs each column under a predicate that reaches it (#4215)', () => {
    expectDetachShape(
      runUpdateStatements(moveOrgSource(), 'ai_agent_runs', '[^`]'),
      'moveOrg.ts',
      /^device_id = \$\{deviceId\}::uuid$/,
      /^ticket_id IN \(SELECT id FROM tickets WHERE device_id = \$\{deviceId\}::uuid\)$/,
    );
  });

  it('breeze_cascade_device_org_id() detaches exactly the derived run-lineage columns', () => {
    const { name, body } = newestCascadeFunctionBody();
    const updates = runUpdateStatements(body, 'public\\.ai_agent_runs', '[^;]');
    expect(
      updates.length,
      `${name} redefines breeze_cascade_device_org_id() but its body has no ai_agent_runs detach statement`,
    ).toBeGreaterThan(0);

    expect(
      detachedColumns(updates),
      `${name} is the newest definition of breeze_cascade_device_org_id() and its ai_agent_runs detach has drifted from moveOrg.ts / the schema's FK columns`,
    ).toEqual(deriveExpectedDetachColumns());
  });

  it('breeze_cascade_device_org_id() severs each column under a predicate that reaches it (#4215)', () => {
    const { name, body } = newestCascadeFunctionBody();
    expectDetachShape(
      runUpdateStatements(body, 'public\\.ai_agent_runs', '[^;]'),
      name,
      /^device_id = NEW\.id$/,
      /^ticket_id IN \(SELECT id FROM public\.tickets WHERE device_id = NEW\.id\)$/,
    );
  });
});

/**
 * action_intents.scope_device_id detach coverage (P2-2 review round 1,
 * Important 2, #4189).
 *
 * Same cross-tenant-pointer class as the ai_agent_runs run-lineage detach
 * above: `action_intents.scope_device_id` is a typed target-scope pointer
 * (migrations/2026-09-23-ai-agents-scheduled-sweeps.sql) that must not keep
 * naming a device once that device moves to a different org. Unlike the
 * ai_agent_runs columns, this is a single column gated to LIVE statuses only
 * (see actionIntents.ts's schema comment for why terminal-status intents are
 * left alone) — a source-text regex assertion on the WHERE clause, not a
 * schema-FK-derived set, since there is only the one column to check.
 *
 * MIRRORED INTO breeze_cascade_device_org_id() SINCE #4454. P2-2 review round 1
 * scoped the original fix to the moveOrg route only, leaving the DB-side
 * trigger — the path every direct-SQL / non-route caller takes, orgMerge's
 * `devices` repoint included — able to move a device out from under a LIVE
 * intent while that intent kept naming it. That is the same documented hole the
 * ai_agent_runs `ticket_id` gap was carried as until #4215 closed it in both
 * sites, and it is closed the same way here. Both sites are asserted below, so
 * a future edit that fixes one and forgets the other goes red.
 *
 * The two cases below are STATIC source assertions and prove only that the
 * statement is present and correctly gated. That the statement actually matches
 * rows — through FORCE ROW LEVEL SECURITY on action_intents, past the
 * `action_intents_block_content_update()` immutability trigger, and past
 * `action_intents_scope_device_chk` — needs a real server and lives in
 * `src/__tests__/integration/deviceMoveOrgIntentScopeTombstone.integration.test.ts`.
 */
describe('action_intents.scope_device_id detach coverage', () => {
  it('moveOrg.ts tombstones scope_device_id for the moved device, scoped to live statuses', () => {
    const moveOrgPath = fileURLToPath(new URL('./moveOrg.ts', import.meta.url));
    const src = readFileSync(moveOrgPath, 'utf8');

    const match = src.match(
      /UPDATE action_intents SET scope_device_id = NULL\s+WHERE scope_device_id = \$\{deviceId\}::uuid\s+AND status IN \(([^)]+)\)/,
    );
    expect(
      match,
      'moveOrg.ts no longer has the expected "UPDATE action_intents SET scope_device_id = NULL ... WHERE scope_device_id = ... AND status IN (...)" statement — update this test if the statement shape changed intentionally',
    ).toBeTruthy();

    // Assert the WHERE's status filter, not just that some UPDATE ran — a
    // detach that fired unconditionally (e.g. dropping the status filter)
    // would tombstone a COMPLETED intent's historical target too, which the
    // schema comment explicitly says must not happen.
    const statuses = match![1]!
      .split(',')
      .map((s) => s.trim().replace(/^'|'$/g, ''));
    expect(statuses.sort()).toEqual(['approved', 'executing', 'pending_approval']);
  });

  it('breeze_cascade_device_org_id() mirrors the tombstone, scoped to the same live statuses (#4454)', () => {
    const { name, body } = newestCascadeFunctionBody();

    const match = body.match(
      /UPDATE public\.action_intents\s+SET scope_device_id = NULL\s+WHERE scope_device_id = NEW\.id\s+AND status IN \(([^)]+)\)/,
    );
    expect(
      match,
      `${name} is the newest definition of breeze_cascade_device_org_id() and its body has no "UPDATE public.action_intents SET scope_device_id = NULL WHERE scope_device_id = NEW.id AND status IN (...)" statement — a device org-move that bypasses the moveOrg route would leave a LIVE intent pointing at a device now in another tenant (#4454)`,
    ).toBeTruthy();

    // Same reasoning as the route assertion above: an unconditional detach
    // would rewrite a COMPLETED intent's historical target.
    const statuses = match![1]!
      .split(',')
      .map((s) => s.trim().replace(/^'|'$/g, ''));
    expect(
      statuses.sort(),
      `${name}'s action_intents tombstone has drifted from moveOrg.ts's status gate`,
    ).toEqual(['approved', 'executing', 'pending_approval']);
  });

  // A CONVENTION guard, not a behavioural one — worth being honest about.
  // `action_intents` is not returned by breeze_device_child_orgid_tables() (its
  // device pointer is `scope_device_id`, not `device_id`), so the generic loop
  // cannot reach these rows and moving the statement after it would not change
  // what the trigger does today. What this pins is that the trigger's internal
  // order keeps mirroring moveOrg.ts's, which is the property that made the
  // tickets requester detach — where placement IS load-bearing, because the
  // re-stamp is the statement that trips its constraint — easy to get right.
  it('places the tombstone BEFORE the generic device-child org re-stamp loop', () => {
    const { name, body } = newestCascadeFunctionBody();
    const tombstone = body.indexOf('UPDATE public.action_intents');
    const loop = body.indexOf('breeze_device_child_orgid_tables()');
    expect(tombstone, `${name}: no action_intents tombstone found`).toBeGreaterThan(-1);
    expect(loop, `${name}: no device-child re-stamp loop found`).toBeGreaterThan(-1);
    expect(
      tombstone,
      `${name}: the action_intents tombstone must run before the generic re-stamp loop, mirroring moveOrg.ts's internal order`,
    ).toBeLessThan(loop);
  });
});

/**
 * action_intents.scope_ticket_id detach coverage (#4792).
 *
 * Worse version of the scope_device_id gap above: `tickets` IS returned by
 * breeze_device_child_orgid_tables(), so the generic re-stamp loop rewrites
 * tickets.org_id for every ticket bound to the moved device.
 * `action_intents_scope_ticket_org_fk` (composite FK (scope_ticket_id, org_id)
 * -> tickets(id, org_id), DEFERRABLE INITIALLY IMMEDIATE, no ON UPDATE clause)
 * does not gate on status, so ANY remaining scope_ticket_id pointer — live or
 * terminal — 23503s the instant the loop's own tickets UPDATE runs, aborting
 * the whole move. Unlike scope_device_id this is unconditional: no status
 * filter, matching moveTicketOrg's identical ticket-axis detach
 * (services/ticketService.ts).
 *
 * Both sites are asserted below, same "a future edit that fixes one and
 * forgets the other goes red" contract as the scope_device_id block above.
 *
 * These are STATIC source assertions only. That the statement actually
 * matches rows and the move no longer 23503s needs a real server and lives in
 * `src/__tests__/integration/deviceMoveOrgTicketScopeTombstone.integration.test.ts`.
 */
describe('action_intents.scope_ticket_id detach coverage (#4792)', () => {
  it('moveOrg.ts tombstones scope_ticket_id for tickets bound to the moved device, all statuses', () => {
    const moveOrgPath = fileURLToPath(new URL('./moveOrg.ts', import.meta.url));
    const src = readFileSync(moveOrgPath, 'utf8');

    const match = src.match(
      /UPDATE action_intents SET scope_ticket_id = NULL\s+WHERE scope_ticket_id IN \(SELECT id FROM tickets WHERE device_id = \$\{deviceId\}::uuid\)/,
    );
    expect(
      match,
      'moveOrg.ts no longer has the expected "UPDATE action_intents SET scope_ticket_id = NULL ... WHERE scope_ticket_id IN (SELECT id FROM tickets WHERE device_id = ...)" statement — update this test if the statement shape changed intentionally',
    ).toBeTruthy();

    // Unlike scope_device_id, this FK does not gate on status — a status
    // filter here would leave a terminal-status intent's pointer in place to
    // 23503 on the very next unrelated UPDATE. Assert the absence explicitly
    // so a copy-paste of the scope_device_id statement (which DOES filter by
    // status) is caught.
    expect(
      match![0],
      'the scope_ticket_id tombstone must be unconditional (no status filter) — action_intents_scope_ticket_org_fk does not gate on status',
    ).not.toMatch(/status/i);
  });

  it('breeze_cascade_device_org_id() mirrors the tombstone, unconditionally (#4792)', () => {
    const { name, body } = newestCascadeFunctionBody();

    const match = body.match(
      /UPDATE public\.action_intents\s+SET scope_ticket_id = NULL\s+WHERE scope_ticket_id IN \(SELECT id FROM public\.tickets WHERE device_id = NEW\.id\)/,
    );
    expect(
      match,
      `${name} is the newest definition of breeze_cascade_device_org_id() and its body has no "UPDATE public.action_intents SET scope_ticket_id = NULL WHERE scope_ticket_id IN (SELECT id FROM public.tickets WHERE device_id = NEW.id)" statement — a device org-move that bypasses the moveOrg route (e.g. orgMerge's raw UPDATE devices) would 23503 on action_intents_scope_ticket_org_fk and abort the move whenever the device has a ticket-scoped intent (#4792)`,
    ).toBeTruthy();

    expect(
      match![0],
      `${name}'s action_intents scope_ticket_id tombstone must be unconditional (no status filter), matching moveOrg.ts`,
    ).not.toMatch(/status/i);
  });

  it('places the tombstone BEFORE the generic device-child org re-stamp loop (load-bearing: tickets IS in that loop)', () => {
    const { name, body } = newestCascadeFunctionBody();
    const tombstone = body.indexOf('SET scope_ticket_id = NULL');
    const loop = body.indexOf('breeze_device_child_orgid_tables()');
    expect(tombstone, `${name}: no scope_ticket_id tombstone found`).toBeGreaterThan(-1);
    expect(loop, `${name}: no device-child re-stamp loop found`).toBeGreaterThan(-1);
    expect(
      tombstone,
      `${name}: the scope_ticket_id tombstone must run before the generic re-stamp loop — unlike scope_device_id's placement (a convention guard only), THIS ordering is load-bearing: tickets IS in breeze_device_child_orgid_tables(), so the loop's own tickets UPDATE is the statement that trips action_intents_scope_ticket_org_fk if the tombstone hasn't run first`,
    ).toBeLessThan(loop);
  });
});
