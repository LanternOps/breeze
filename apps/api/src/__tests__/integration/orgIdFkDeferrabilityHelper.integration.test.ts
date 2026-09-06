/**
 * Contract for `reapplyOrgIdFkDeferrability` (db-utils.ts).
 *
 * That helper is the one piece of test code allowed to change FK deferrability
 * in the shared integration database, which makes it the one piece of test code
 * able to invalidate `orgLifecycleFoundations.integration.test.ts` — the org-merge
 * contract that reads live `pg_constraint` state. It already did exactly that:
 * as a whole-database sweep it silently repaired the three non-deferrable
 * composite org_id FKs shipped by 2026-10-01-100000-ai-agents-graduation-evidence.sql,
 * so the contract read green in CI while failing on every fresh database.
 *
 * The rules below were prose in a docstring; this file makes them executable.
 * Everything runs against purpose-built probe tables that are dropped in
 * `afterAll`, so no shipped constraint is mutated and nothing leaks into the
 * contract test's or rls-coverage's view of the schema.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { getTestDb } from './setup';
import { reapplyOrgIdFkDeferrability } from './db-utils';

const PARENT = 'fk_deferrability_probe_parent';
const CHILD = 'fk_deferrability_probe_child';
const TARGET_FK = 'fk_deferrability_probe_target_fk';
const BYSTANDER_FK = 'fk_deferrability_probe_bystander_fk';
const DEFERRED_FK = 'fk_deferrability_probe_deferred_fk';

async function dropProbeTables(): Promise<void> {
  await getTestDb().execute(sql.raw(`DROP TABLE IF EXISTS ${CHILD} CASCADE`));
  await getTestDb().execute(sql.raw(`DROP TABLE IF EXISTS ${PARENT} CASCADE`));
}

/** condeferrable / condeferred straight from the catalog, for one constraint. */
async function readMode(conname: string): Promise<{ deferrable: boolean; deferred: boolean }> {
  const rows = (await getTestDb().execute(sql`
    SELECT con.condeferrable, con.condeferred
    FROM pg_constraint con
    WHERE con.conname = ${conname} AND con.connamespace = 'public'::regnamespace
  `)) as unknown as Array<{ condeferrable: boolean; condeferred: boolean }>;
  expect(rows.length, `probe constraint ${conname} is missing`).toBe(1);
  return { deferrable: rows[0]!.condeferrable, deferred: rows[0]!.condeferred };
}

describe('reapplyOrgIdFkDeferrability contract', () => {
  beforeAll(async () => {
    // Defensive: a crashed earlier run could have leaked these.
    await dropProbeTables();
    // The referenced column is genuinely named org_id, so these probe FKs are
    // exactly what orgLifecycleFoundations' pg_constraint scan looks for.
    await getTestDb().execute(
      sql.raw(`
        CREATE TABLE ${PARENT} (
          id uuid NOT NULL,
          org_id uuid NOT NULL,
          PRIMARY KEY (id, org_id)
        )
      `),
    );
    await getTestDb().execute(
      sql.raw(`
        CREATE TABLE ${CHILD} (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          target_ref uuid,
          bystander_ref uuid,
          deferred_ref uuid,
          org_id uuid,
          CONSTRAINT ${TARGET_FK} FOREIGN KEY (target_ref, org_id)
            REFERENCES ${PARENT} (id, org_id),
          CONSTRAINT ${BYSTANDER_FK} FOREIGN KEY (bystander_ref, org_id)
            REFERENCES ${PARENT} (id, org_id),
          CONSTRAINT ${DEFERRED_FK} FOREIGN KEY (deferred_ref, org_id)
            REFERENCES ${PARENT} (id, org_id) DEFERRABLE INITIALLY DEFERRED
        )
      `),
    );
  });

  afterAll(async () => {
    // Must run even when a test above failed: a leaked probe table is a
    // non-deferrable composite org_id FK, which would redden the org-merge
    // contract test for reasons that have nothing to do with the schema.
    await dropProbeTables();
  });

  it('refuses an empty constraint list rather than sweeping the database', async () => {
    await expect(reapplyOrgIdFkDeferrability(getTestDb(), [])).rejects.toThrow(
      /name the constraint\(s\)/i,
    );
  });

  it('refuses a constraint name that does not exist', async () => {
    await expect(
      reapplyOrgIdFkDeferrability(getTestDb(), ['fk_deferrability_probe_nope_fkey']),
    ).rejects.toThrow(/no such foreign-key constraint/i);
  });

  it('repairs only the named constraint and leaves an unrelated offender non-deferrable', async () => {
    expect(await readMode(TARGET_FK)).toEqual({ deferrable: false, deferred: false });
    expect(await readMode(BYSTANDER_FK)).toEqual({ deferrable: false, deferred: false });

    await reapplyOrgIdFkDeferrability(getTestDb(), [TARGET_FK]);

    expect(await readMode(TARGET_FK)).toEqual({ deferrable: true, deferred: false });
    // The whole point: a non-deferrable composite org_id FK the caller did not
    // name stays broken, so orgLifecycleFoundations still catches it.
    expect(await readMode(BYSTANDER_FK)).toEqual({ deferrable: false, deferred: false });
  });

  it('preserves INITIALLY DEFERRED instead of downgrading it to IMMEDIATE', async () => {
    expect(await readMode(DEFERRED_FK)).toEqual({ deferrable: true, deferred: true });

    await reapplyOrgIdFkDeferrability(getTestDb(), [DEFERRED_FK]);

    // Several shipped FKs are DEFERRABLE INITIALLY DEFERRED on purpose
    // (2026-09-13-agent-rollback-lifecycle.sql,
    // 2026-09-28-100002-software-inventory-observations.sql). A helper that
    // hard-codes INITIALLY IMMEDIATE would silently downgrade one the moment a
    // caller named it.
    expect(await readMode(DEFERRED_FK)).toEqual({ deferrable: true, deferred: true });
  });
});
