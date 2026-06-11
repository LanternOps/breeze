import { describe, expect, it } from 'vitest';
import { getTableName } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import * as schema from '../../db/schema';
import {
  DEVICE_CASCADE_DELETE_TABLES,
  DEVICE_DETACH_DEVICE_ID_TABLES,
  DEVICE_ORG_DENORMALIZED_TABLES,
  DEVICE_SITE_DENORMALIZED_TABLES,
} from './core';

/**
 * Mirrors cascadeDelete.test.ts but for the `org_id` denormalization list.
 *
 * `POST /devices/:id/move-org` works by rewriting the denormalized `org_id`
 * column on every device-scoped table inside the same transaction that
 * flips `devices.org_id`. If a new device-scoped table is added with an
 * `org_id` column but NOT added to DEVICE_ORG_DENORMALIZED_TABLES, the move
 * will strand its rows under the OLD org's RLS — invisible to the new org.
 *
 * This test catches that drift at CI time.
 *
 * Tables that intentionally don't denormalize `org_id` (e.g. `device_commands`
 * which is system-scoped per RLS policy) are listed in INTENTIONALLY_NO_ORG_ID
 * here and must match the comment in core.ts.
 */
const INTENTIONALLY_NO_ORG_ID: ReadonlySet<string> = new Set([
  'automation_policy_compliance',
  'deployment_devices',
  'deployment_results',
  'device_commands',
  'device_software',
  'file_transfers',
  'patch_job_results',
  'patch_rollbacks',
  'psa_ticket_mappings',
  'software_compliance_status',
]);

function getColumns(table: PgTable<any>): any[] {
  return Object.values(
    (table as any)[Symbol.for('drizzle:Columns')] ?? {},
  );
}

describe('DEVICE_ORG_DENORMALIZED_TABLES coverage', () => {
  const denormSet = new Set<string>(DEVICE_ORG_DENORMALIZED_TABLES);
  // Device-managed tables = cascade-deleted ∪ detached (device_id SET NULL,
  // e.g. tickets). Both kinds must keep org_id in sync on cross-org moves.
  const managedSet = new Set<string>([
    ...DEVICE_CASCADE_DELETE_TABLES,
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
      `These tables are in DEVICE_CASCADE_DELETE_TABLES or DEVICE_DETACH_DEVICE_ID_TABLES and have an org_id column ` +
        `but are missing from DEVICE_ORG_DENORMALIZED_TABLES in core.ts. ` +
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
      `These tables are listed in DEVICE_ORG_DENORMALIZED_TABLES but no longer exist in the schema. Remove them.`,
    ).toEqual([]);
  });

  it('only lists tables that actually have an org_id column', () => {
    const tablesWithoutOrgId: string[] = [];
    const tableByName = new Map(allTables.map((t) => [getTableName(t), t] as const));

    for (const name of DEVICE_ORG_DENORMALIZED_TABLES) {
      const table = tableByName.get(name);
      if (!table) continue; // covered by the stale-name test above
      const hasOrgId = getColumns(table).some((c) => c.name === 'org_id');
      if (!hasOrgId) tablesWithoutOrgId.push(name);
    }

    expect(
      tablesWithoutOrgId,
      `These tables are listed in DEVICE_ORG_DENORMALIZED_TABLES but do not have an org_id column. ` +
        `Move them to INTENTIONALLY_NO_ORG_ID, or remove from the denormalized list.`,
    ).toEqual([]);
  });

  it('all listed tables are also device-managed (cascade-deleted or detached)', () => {
    // Sanity: a denormalized device table that is neither cascade-deleted
    // nor detached on permanent delete is a bug elsewhere; flag it here so
    // we don't ship a half-managed table.
    const orphans = DEVICE_ORG_DENORMALIZED_TABLES.filter((t) => !managedSet.has(t));
    expect(
      orphans,
      `These tables are in DEVICE_ORG_DENORMALIZED_TABLES but missing from both ` +
        `DEVICE_CASCADE_DELETE_TABLES and DEVICE_DETACH_DEVICE_ID_TABLES.`,
    ).toEqual([]);
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
