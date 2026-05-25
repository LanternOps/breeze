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
    auditId = (rows as unknown as Array<{ id: string }>)[0].id;
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
    // `cause.message`. Either the trigger fires ("audit log is append-only")
    // OR PG's permission check fires first ("permission denied for table"),
    // depending on which layer the REVOKE/trigger pair resolves first. Both
    // are valid append-only enforcement.
    const cause = (caught as { cause?: { message?: string } } | undefined)?.cause;
    expect(cause?.message).toMatch(/audit log is append-only|permission denied/i);

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
    const cause = (caught as { cause?: { message?: string } } | undefined)?.cause;
    expect(cause?.message).toMatch(/audit log is append-only|permission denied/i);

    // Defense-in-depth: confirm the row's action was not mutated.
    const rows = (await getTestDb().execute(
      sql`SELECT action FROM audit_logs WHERE id = ${auditId}`
    )) as unknown as Array<{ action: string }>;
    expect(rows[0]?.action).toBe('test.action');
  });
});
