/**
 * RMM-QA-176 D5 — the persisted manual maintenance lease on `devices`.
 *
 * `POST /devices/:id/maintenance` echoed `durationHours` into an audit detail
 * and threw it away, so there was no durable record of who suppressed
 * monitoring on a device, why, or until when — and "extend the window" was not
 * a distinguishable operation. `2026-10-05-100000-device-manual-maintenance-
 * lease.sql` adds that record: maintenance_started_at / maintenance_until /
 * maintenance_reason / maintenance_started_by, plus
 * `devices_maintenance_lease_chk`, which forbids a HALF-written lease.
 *
 * This suite pins the four things later tasks (6, 7, 8, 9, 12) build on, all
 * against the real migrated database rather than the Drizzle declaration:
 *
 *  - the column set, its types and its nullability (a `timestamptz` that
 *    shipped as `timestamp` would silently shift every window by the server's
 *    offset, and Drizzle's `withTimezone: true` is a claim about the DB, not a
 *    guarantee from it);
 *  - the CHECK actually REJECTS each half-written shape — an `until` with no
 *    start/reason, a reason with no window, a start with no end — because a
 *    constraint that is merely present proves nothing;
 *  - `ON DELETE SET NULL` on the actor: erasing a user must never be blocked by
 *    a device that happens to be in maintenance, and must not silently clear
 *    the window either (which is why the CHECK deliberately permits a null
 *    actor beside a live lease);
 *  - re-applying the migration is a no-op, and every new column is registered
 *    in the devices tenant-export policy (F12 — `devices` is an org-cascade
 *    table whose policy enumerates every column, so an unregistered one fails
 *    tenant-export-policy.integration.test.ts with `unclassified`; the local
 *    assertion here says WHY when that happens).
 *
 * Prerequisites (private per-worktree stack — never `test:docker:up`):
 *   pnpm test-stack up
 *
 * Run:
 *   pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/deviceMaintenanceLease.integration.test.ts
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { devices } from '../../db/schema/devices';
import { CORE_TENANT_EXPORT_POLICY } from '../../services/tenantExportPolicyRegistry';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';
import { getTestDb } from './setup';

const MIGRATION_FILENAME = '2026-10-05-100000-device-manual-maintenance-lease.sql';
const MIGRATION_FILE = join(__dirname, '../../../migrations', MIGRATION_FILENAME);
const LEASE_CONSTRAINT = 'devices_maintenance_lease_chk';

const LEASE_COLUMNS = [
  'maintenance_started_at',
  'maintenance_until',
  'maintenance_reason',
  'maintenance_started_by',
] as const;

type LiveColumn = {
  column_name: string;
  data_type: string;
  is_nullable: string;
  character_maximum_length: number | null;
};

/**
 * Asserts the statement fails with SQLSTATE 23514 (check_violation) raised by
 * the NAMED constraint. Both halves matter: 23514 alone would also be produced
 * by any other CHECK on `devices`, and before the migration the same statement
 * fails with 42703 (undefined_column), which is a different — and not
 * load-bearing — kind of rejection.
 */
async function expectCheckViolation(fn: () => Promise<unknown>, constraint: string): Promise<void> {
  let raised: unknown;
  try {
    await fn();
  } catch (error) {
    raised = error;
  }
  expect(raised, `expected ${constraint} to reject the statement, but it succeeded`).toBeDefined();
  const cause = (raised as { cause?: Record<string, unknown> } | undefined)?.cause;
  const code = (cause?.code as string | undefined) ?? (raised as { code?: string } | undefined)?.code;
  const constraintName =
    (cause?.constraint_name as string | undefined)
    ?? (raised as { constraint_name?: string } | undefined)?.constraint_name;
  expect(
    { code, constraintName },
    `expected 23514 from ${constraint}; got: ${(raised as Error)?.message}`,
  ).toEqual({ code: '23514', constraintName: constraint });
}

async function createFixtureDevice(): Promise<{ id: string; orgId: string; partnerId: string }> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const suffix = randomUUID();
  const [device] = await getTestDb()
    .insert(devices)
    .values({
      orgId: org.id,
      siteId: site.id,
      agentId: `maint-lease-${suffix}`,
      hostname: `maint-lease-${suffix.slice(0, 12)}`,
      displayName: 'Maintenance Lease Fixture',
      osType: 'windows',
      osVersion: '11',
      architecture: 'x64',
      agentVersion: 'test',
      status: 'online',
    })
    .returning({ id: devices.id });
  if (!device) throw new Error('maintenance-lease fixture device insert failed');
  return { id: device.id, orgId: org.id, partnerId: partner.id };
}

/** A device carrying a COMPLETE lease whose actor is a real, deletable user row. */
async function createFixtureDeviceWithLeaseActor(): Promise<{ deviceId: string; userId: string }> {
  const device = await createFixtureDevice();
  const actor = await createUser({ partnerId: device.partnerId, email: `lease-actor-${randomUUID()}@example.com` });
  await getTestDb().execute(sql`
    UPDATE devices
    SET maintenance_started_at = now(),
        maintenance_until = now() + interval '1 hour',
        maintenance_reason = 'scheduled patching',
        maintenance_started_by = ${actor.id}::uuid
    WHERE id = ${device.id}::uuid
  `);
  return { deviceId: device.id, userId: actor.id };
}

describe('devices manual maintenance lease columns (RMM-QA-176 D5)', () => {
  it('exposes all four lease columns with the intended types and nullability', async () => {
    const rows = (await getTestDb().execute(sql`
      SELECT column_name, data_type, is_nullable, character_maximum_length
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'devices'
        AND column_name = ANY(${sql.raw(`ARRAY['${LEASE_COLUMNS.join("','")}']`)}::text[])
      ORDER BY column_name
    `)) as unknown as LiveColumn[];

    expect(rows.map((row) => row.column_name).sort()).toEqual([...LEASE_COLUMNS].sort());

    const byName = Object.fromEntries(rows.map((row) => [row.column_name, row])) as Record<string, LiveColumn>;
    expect(byName.maintenance_started_at!.data_type).toBe('timestamp with time zone');
    expect(byName.maintenance_until!.data_type).toBe('timestamp with time zone');
    expect(byName.maintenance_reason!.data_type).toBe('character varying');
    expect(byName.maintenance_reason!.character_maximum_length).toBe(500);
    expect(byName.maintenance_started_by!.data_type).toBe('uuid');
    for (const column of LEASE_COLUMNS) {
      expect(byName[column]!.is_nullable, `${column} must stay nullable`).toBe('YES');
    }
  });

  it('rejects a partial lease: until without reason/started_at', async () => {
    const device = await createFixtureDevice();
    await expectCheckViolation(
      () =>
        getTestDb().execute(sql`
          UPDATE devices SET maintenance_until = now() + interval '1 hour' WHERE id = ${device.id}::uuid
        `),
      LEASE_CONSTRAINT,
    );
  });

  it('rejects a partial lease: reason without a window', async () => {
    const device = await createFixtureDevice();
    await expectCheckViolation(
      () =>
        getTestDb().execute(sql`
          UPDATE devices SET maintenance_reason = 'no window' WHERE id = ${device.id}::uuid
        `),
      LEASE_CONSTRAINT,
    );
  });

  it('rejects a partial lease: started_at with no end and no reason', async () => {
    const device = await createFixtureDevice();
    await expectCheckViolation(
      () =>
        getTestDb().execute(sql`
          UPDATE devices SET maintenance_started_at = now() WHERE id = ${device.id}::uuid
        `),
      LEASE_CONSTRAINT,
    );
  });

  it('rejects clearing only half of a complete lease', async () => {
    const { deviceId } = await createFixtureDeviceWithLeaseActor();
    await expectCheckViolation(
      () =>
        getTestDb().execute(sql`
          UPDATE devices SET maintenance_until = NULL WHERE id = ${deviceId}::uuid
        `),
      LEASE_CONSTRAINT,
    );
  });

  it('accepts an all-null lease and a fully populated lease', async () => {
    const device = await createFixtureDevice();
    const actor = await createUser({ partnerId: device.partnerId, email: `lease-ok-${randomUUID()}@example.com` });

    await getTestDb().execute(sql`
      UPDATE devices
      SET maintenance_started_at = now(),
          maintenance_until = now() + interval '1 hour',
          maintenance_reason = 'scheduled patching',
          maintenance_started_by = ${actor.id}::uuid
      WHERE id = ${device.id}::uuid
    `);

    // A live window with NO actor is legal — that is what makes user erasure
    // (ON DELETE SET NULL, below) possible without dropping the lease.
    await getTestDb().execute(sql`
      UPDATE devices SET maintenance_started_by = NULL WHERE id = ${device.id}::uuid
    `);

    await getTestDb().execute(sql`
      UPDATE devices
      SET maintenance_started_at = NULL,
          maintenance_until = NULL,
          maintenance_reason = NULL,
          maintenance_started_by = NULL
      WHERE id = ${device.id}::uuid
    `);

    const [row] = (await getTestDb().execute(sql`
      SELECT maintenance_started_at, maintenance_until, maintenance_reason, maintenance_started_by
      FROM devices WHERE id = ${device.id}::uuid
    `)) as unknown as Array<Record<string, unknown>>;
    expect(row).toEqual({
      maintenance_started_at: null,
      maintenance_until: null,
      maintenance_reason: null,
      maintenance_started_by: null,
    });
  });

  it('nulls maintenance_started_by when the actor user row is deleted (ON DELETE SET NULL)', async () => {
    const { deviceId, userId } = await createFixtureDeviceWithLeaseActor();

    await getTestDb().execute(sql`DELETE FROM users WHERE id = ${userId}::uuid`);

    const [row] = (await getTestDb().execute(sql`
      SELECT maintenance_started_by, maintenance_until FROM devices WHERE id = ${deviceId}::uuid
    `)) as unknown as Array<{ maintenance_started_by: string | null; maintenance_until: Date | null }>;
    expect(row!.maintenance_started_by).toBeNull();
    // The CHECK deliberately permits a null actor beside a live window: user
    // erasure must not be blocked by, and must not silently clear, the lease.
    expect(row!.maintenance_until).not.toBeNull();
  });

  it('re-applying the migration is a no-op (idempotency)', async () => {
    const sqlText = readFileSync(MIGRATION_FILE, 'utf8');
    await getTestDb().execute(sql.raw(sqlText));
    await getTestDb().execute(sql.raw(sqlText));

    const [row] = (await getTestDb().execute(sql`
      SELECT count(*)::int AS count FROM pg_constraint WHERE conname = ${LEASE_CONSTRAINT}
    `)) as unknown as Array<{ count: number }>;
    expect(row!.count).toBe(1);

    // …and the replay did not disturb the columns it re-adds.
    const [columns] = (await getTestDb().execute(sql`
      SELECT count(*)::int AS count
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'devices'
        AND column_name LIKE 'maintenance\\_%'
    `)) as unknown as Array<{ count: number }>;
    expect(columns!.count).toBe(LEASE_COLUMNS.length);
  });

  it('registers every lease column in the devices tenant-export policy', () => {
    // Guard for the "unclassified" failure in
    // __tests__/integration/tenant-export-policy.integration.test.ts: a column
    // added to an org-cascade table without a decision fails that suite, and
    // this local assertion says WHY when it does.
    for (const column of LEASE_COLUMNS) {
      expect(
        CORE_TENANT_EXPORT_POLICY.devices!.columns[column]?.decision,
        `${column} is unclassified in the devices tenant-export policy`,
      ).toBe('include');
    }
  });
});
