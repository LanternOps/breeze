import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';

/**
 * Schema contract for `partners.service_management_mode` (#5075 W04).
 *
 * Migration: `2026-10-12-000200-partners-service-management-mode.sql`.
 *
 * These assertions are the reason the pairing is a CHECK and not app-layer
 * validation: `PATCH /partners/me` forces the connection id to null for
 * `native`/`off` and requires one for `external`, but a background job, a
 * psql session, or a future route that forgets the rule must fail at the
 * database, not write a partner into a shape the UI cannot render.
 *
 * `partners` has no `org_id`, so no tenantCascade / export-policy registration
 * applies and none is asserted here.
 */

class Rollback extends Error {}

/** Postgres SQLSTATEs the constraints must raise. */
const CHECK_VIOLATION = '23514';
const FK_VIOLATION = '23503';

function sqlState(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string') return code;
  return sqlState((err as { cause?: unknown }).cause);
}

/**
 * Run `body` against a throwaway partner (+ optional partner-wide PSA
 * connection), then roll the whole thing back — the integration shard shares one
 * database, so nothing may be left behind.
 */
async function withFixture(
  body: (ids: { partnerId: string; connectionId: string }) => Promise<void>,
): Promise<void> {
  const partnerId = randomUUID();
  const connectionId = randomUUID();
  const suffix = partnerId.slice(0, 8);

  try {
    await withSystemDbAccessContext(async () => {
      await db.execute(sql`
        INSERT INTO partners (id, name, slug)
        VALUES (${partnerId}::uuid, ${'SM Mode MSP'}, ${`sm-mode-${suffix}`})`);
      // Partner-wide (org_id IS NULL) — the only shape PATCH /partners/me accepts.
      await db.execute(sql`
        INSERT INTO psa_connections (id, org_id, partner_id, provider, name, credentials)
        VALUES (${connectionId}::uuid, NULL, ${partnerId}::uuid, 'halo', ${'Halo PSA'}, '{}'::jsonb)`);

      await body({ partnerId, connectionId });

      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
}

describe('partners.service_management_mode contract (#5075 W04)', () => {
  it('defaults to native and NOT NULL, with a nullable connection id', async () => {
    const rows = (await db.execute(sql`
      SELECT column_name, is_nullable, column_default, data_type
      FROM information_schema.columns
      WHERE table_name = 'partners'
        AND column_name IN ('service_management_mode', 'service_management_psa_connection_id')
    `)) as unknown as Array<{
      column_name: string;
      is_nullable: string;
      column_default: string | null;
      data_type: string;
    }>;

    const byName = new Map(rows.map((r) => [r.column_name, r]));
    expect([...byName.keys()].sort()).toEqual([
      'service_management_mode',
      'service_management_psa_connection_id',
    ]);

    const mode = byName.get('service_management_mode')!;
    expect(mode.is_nullable).toBe('NO');
    expect(mode.column_default).toContain("'native'");

    const conn = byName.get('service_management_psa_connection_id')!;
    expect(conn.is_nullable).toBe('YES');
    expect(conn.data_type).toBe('uuid');
  });

  it('a new partner starts in native with no connection bound', async () => {
    await withFixture(async ({ partnerId }) => {
      const rows = (await db.execute(sql`
        SELECT service_management_mode AS mode, service_management_psa_connection_id AS conn
        FROM partners WHERE id = ${partnerId}::uuid
      `)) as unknown as Array<{ mode: string; conn: string | null }>;

      expect(rows).toHaveLength(1);
      expect(rows[0]!.mode).toBe('native');
      expect(rows[0]!.conn).toBeNull();
    });
  });

  it('accepts every mode the API can send, with the matching connection binding', async () => {
    await withFixture(async ({ partnerId, connectionId }) => {
      for (const mode of ['off', 'native'] as const) {
        await db.execute(sql`
          UPDATE partners
          SET service_management_mode = ${mode}, service_management_psa_connection_id = NULL
          WHERE id = ${partnerId}::uuid`);
      }

      await db.execute(sql`
        UPDATE partners
        SET service_management_mode = 'external', service_management_psa_connection_id = ${connectionId}::uuid
        WHERE id = ${partnerId}::uuid`);

      const rows = (await db.execute(sql`
        SELECT service_management_mode AS mode, service_management_psa_connection_id AS conn
        FROM partners WHERE id = ${partnerId}::uuid
      `)) as unknown as Array<{ mode: string; conn: string | null }>;
      expect(rows[0]!.mode).toBe('external');
      expect(rows[0]!.conn).toBe(connectionId);
    });
  });

  it('rejects a mode outside the CHECK with 23514', async () => {
    await withFixture(async ({ partnerId }) => {
      const err = await db
        .execute(sql`
          UPDATE partners SET service_management_mode = 'bogus' WHERE id = ${partnerId}::uuid`)
        .then(() => null)
        .catch((e: unknown) => e);

      expect(err, 'an unknown mode must not be storable').not.toBeNull();
      expect(sqlState(err)).toBe(CHECK_VIOLATION);
    });
  });

  it("rejects 'external' with no connection bound (23514)", async () => {
    await withFixture(async ({ partnerId }) => {
      const err = await db
        .execute(sql`
          UPDATE partners
          SET service_management_mode = 'external', service_management_psa_connection_id = NULL
          WHERE id = ${partnerId}::uuid`)
        .then(() => null)
        .catch((e: unknown) => e);

      expect(err, 'external without a PSA connection must not be storable').not.toBeNull();
      expect(sqlState(err)).toBe(CHECK_VIOLATION);
    });
  });

  it("rejects 'native' that still carries a connection id (23514)", async () => {
    // The biconditional half that stops a stale binding surviving a flip back to
    // native and silently re-attaching on the next flip to external.
    await withFixture(async ({ partnerId, connectionId }) => {
      const err = await db
        .execute(sql`
          UPDATE partners
          SET service_management_mode = 'native', service_management_psa_connection_id = ${connectionId}::uuid
          WHERE id = ${partnerId}::uuid`)
        .then(() => null)
        .catch((e: unknown) => e);

      expect(err, 'native must not retain a PSA connection').not.toBeNull();
      expect(sqlState(err)).toBe(CHECK_VIOLATION);
    });
  });

  it("rejects 'off' that still carries a connection id (23514)", async () => {
    await withFixture(async ({ partnerId, connectionId }) => {
      const err = await db
        .execute(sql`
          UPDATE partners
          SET service_management_mode = 'off', service_management_psa_connection_id = ${connectionId}::uuid
          WHERE id = ${partnerId}::uuid`)
        .then(() => null)
        .catch((e: unknown) => e);

      expect(err, 'off must not retain a PSA connection').not.toBeNull();
      expect(sqlState(err)).toBe(CHECK_VIOLATION);
    });
  });

  it('RESTRICTs deleting a PSA connection a partner is bound to (23503)', async () => {
    await withFixture(async ({ partnerId, connectionId }) => {
      await db.execute(sql`
        UPDATE partners
        SET service_management_mode = 'external', service_management_psa_connection_id = ${connectionId}::uuid
        WHERE id = ${partnerId}::uuid`);

      const err = await db
        .execute(sql`DELETE FROM psa_connections WHERE id = ${connectionId}::uuid`)
        .then(() => null)
        .catch((e: unknown) => e);

      // ON DELETE RESTRICT, deliberately: SET NULL or CASCADE would leave the
      // partner as external-with-no-connection, which the pairing CHECK forbids.
      expect(err, 'deleting a bound connection must be refused').not.toBeNull();
      expect(sqlState(err)).toBe(FK_VIOLATION);
    });
  });

  it('allows deleting a PSA connection no partner is bound to', async () => {
    // Proves the RESTRICT above is about the BINDING, not about psa_connections
    // being undeletable in general.
    await withFixture(async ({ connectionId }) => {
      await expect(
        db.execute(sql`DELETE FROM psa_connections WHERE id = ${connectionId}::uuid`),
      ).resolves.toBeDefined();
    });
  });

  it('names both CHECK constraints so migrations can drop and re-add them idempotently', async () => {
    const rows = (await db.execute(sql`
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'partners'::regclass
        AND conname IN (
          'partners_service_management_mode_chk',
          'partners_service_management_connection_chk'
        )
    `)) as unknown as Array<{ conname: string }>;

    expect(rows.map((r) => r.conname).sort()).toEqual([
      'partners_service_management_connection_chk',
      'partners_service_management_mode_chk',
    ]);
  });
});
