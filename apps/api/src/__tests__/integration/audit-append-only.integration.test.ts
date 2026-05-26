/**
 * Integration test for audit_logs append-only enforcement.
 *
 * Threat model: a malicious org admin (or partner-scope MSP staff) could
 * issue a DELETE/UPDATE against audit_logs to erase the trail of their own
 * actions. RLS policies on audit_logs grant SELECT/INSERT under the same
 * tenant-access predicates the rest of the schema uses, and historically
 * permitted DELETE/UPDATE implicitly as a side effect of those grants.
 *
 * This task closes that hole at the table-grant layer: `breeze_app` is
 * stripped of UPDATE/DELETE on audit_logs, and a BEFORE UPDATE/DELETE
 * trigger raises a clear "audit log is append-only" error as a
 * belt-and-suspenders defense against any future GRANT typo.
 *
 * These tests run against real Postgres as the unprivileged `breeze_app`
 * role (via the `db` pool wired up in `src/db/index.ts`) so both the
 * GRANT revocation and the trigger fire end-to-end. Inserting the seed
 * row uses the superuser test client to side-step the org_id FK / RLS
 * setup that the rest of the audit suite already covers.
 */
import './setup';
import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { getTestDb } from './setup';

describe('audit_logs append-only enforcement', () => {
  let auditId: string;

  // Seed in beforeEach because setup.ts's global beforeEach TRUNCATEs
  // audit_logs before every test — a beforeAll-seeded row would be wiped
  // and the DELETE/UPDATE under test would match zero rows, never firing
  // the trigger. Vitest runs hooks in registration order, so this seed
  // runs AFTER the global cleanup.
  beforeEach(async () => {
    // Seed via the superuser test client so we don't depend on org FKs.
    // audit_logs.org_id is nullable; a system-actor row with no org_id is
    // a valid shape (used by background jobs / platform-level events).
    const rows = await getTestDb().execute(sql`
      INSERT INTO audit_logs (actor_type, actor_id, action, resource_type, result)
      VALUES ('system', gen_random_uuid(), 'test.action', 'test', 'success')
      RETURNING id
    `);
    auditId = (rows as unknown as Array<{ id: string }>)[0]!.id;
  });

  it('rejects DELETE from breeze_app under any RLS context', async () => {
    let caught: unknown;
    try {
      await withSystemDbAccessContext(() =>
        db.execute(sql`DELETE FROM audit_logs WHERE id = ${auditId}`)
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    // Drizzle wraps PG errors as `Failed query: ...` with the real message on
    // `cause.message`. Postgres checks table privileges BEFORE evaluating
    // BEFORE-row triggers, so with `ensureAppRole`'s re-REVOKE in place the
    // privilege layer fires first ("permission denied for table audit_logs")
    // and the trigger never runs. The trigger is still the last line of
    // defense if a future engineer adds a new GRANT path that misses
    // audit_logs — verified end-to-end by the privilege test below.
    const cause = (caught as { cause?: { message?: string } } | undefined)?.cause;
    expect(cause?.message).toMatch(/permission denied/i);

    // Defense-in-depth: confirm the row still exists (was not deleted).
    const remaining = await getTestDb().execute(
      sql`SELECT id FROM audit_logs WHERE id = ${auditId}`
    );
    expect((remaining as unknown as unknown[]).length).toBe(1);
  });

  it('rejects UPDATE from breeze_app under any RLS context', async () => {
    let caught: unknown;
    try {
      await withSystemDbAccessContext(() =>
        db.execute(sql`UPDATE audit_logs SET action = 'tampered' WHERE id = ${auditId}`)
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    // See note above on DELETE: privilege check fires before BEFORE-row trigger.
    const cause = (caught as { cause?: { message?: string } } | undefined)?.cause;
    expect(cause?.message).toMatch(/permission denied/i);

    // Defense-in-depth: confirm the row's action was not mutated.
    const rows = (await getTestDb().execute(
      sql`SELECT action FROM audit_logs WHERE id = ${auditId}`
    )) as unknown as Array<{ action: string }>;
    expect(rows[0]?.action).toBe('test.action');
  });

  // Regression test for the gap closed in `ensureAppRole.ts` — the blanket
  // GRANT in step 4 silently re-permitted UPDATE/DELETE on audit_logs, undoing
  // the migration's REVOKE. The trigger still blocked mutations, but the
  // privilege-layer half of the belt-and-suspenders pair was decorative.
  // This test asserts the privilege is actually absent after ensureAppRole
  // runs (which the test setup does via autoMigrate -> ensureAppRole).
  it('breeze_app has no UPDATE, DELETE, or TRUNCATE privilege on audit_logs after ensureAppRole runs', async () => {
    const rows = (await db.execute(sql`
      SELECT
        has_table_privilege('breeze_app', 'audit_logs', 'UPDATE') AS can_update,
        has_table_privilege('breeze_app', 'audit_logs', 'DELETE') AS can_delete,
        has_table_privilege('breeze_app', 'audit_logs', 'TRUNCATE') AS can_truncate,
        has_table_privilege('breeze_app', 'audit_logs', 'INSERT') AS can_insert,
        has_table_privilege('breeze_app', 'audit_logs', 'SELECT') AS can_select
    `)) as unknown as Array<{
      can_update: boolean;
      can_delete: boolean;
      can_truncate: boolean;
      can_insert: boolean;
      can_select: boolean;
    }>;
    const r = rows[0]!;
    expect(r.can_update).toBe(false);
    expect(r.can_delete).toBe(false);
    expect(r.can_truncate).toBe(false);
    expect(r.can_insert).toBe(true);
    expect(r.can_select).toBe(true);
  });

  it('rejects TRUNCATE on audit_logs even if the privilege check were bypassed', async () => {
    // Seed a row so a successful TRUNCATE would visibly destroy state.
    await getTestDb().execute(sql`
      INSERT INTO audit_logs (org_id, actor_type, actor_id, action, resource_type, result)
      VALUES (NULL, 'system', gen_random_uuid(), 'truncate.regression', 'test', 'success')
    `);

    // Use the superuser test client (which would normally have TRUNCATE
    // privilege) so we exercise the trigger, not the GRANT. The trigger
    // must raise regardless of caller authority.
    let caught: unknown;
    try {
      await getTestDb().execute(sql`TRUNCATE TABLE audit_logs`);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeDefined();
    const cause = (caught as { cause?: { message?: string } } | undefined)?.cause
      ?? (caught as { message?: string } | undefined);
    expect(String(cause?.message)).toMatch(/audit log is append-only/i);

    // Defense-in-depth: confirm the row survived.
    const rows = (await getTestDb().execute(
      sql`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'truncate.regression'`
    )) as unknown as Array<{ n: number }>;
    expect(rows[0]?.n).toBeGreaterThanOrEqual(1);
  });
});
