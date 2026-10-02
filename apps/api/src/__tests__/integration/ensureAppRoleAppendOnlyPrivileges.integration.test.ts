/**
 * Integration test for #4371: ensureAppRole()'s blanket per-boot GRANT
 * (`GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON ALL TABLES IN SCHEMA
 * public TO breeze_app`, step 4 of `src/db/ensureAppRole.ts`) silently
 * re-permits whatever an append-only table's migration REVOKEd from
 * breeze_app, unless step 5 re-applies that REVOKE after the blanket GRANT.
 *
 * `pam_actuation_results` shipped without a re-revoke block, so its
 * `BEFORE UPDATE/DELETE` trigger was the *sole* enforcement in production —
 * the privilege layer of the intended belt-and-suspenders pair never
 * actually held. The sweep that fixed #4371 found five more tables with the
 * same gap: ml_feedback_events, peripheral_policy_delivery_events,
 * agent_rollback_events, automation_action_results, and
 * device_software_inventory_state.
 *
 * `ensureAppRole.appendOnlyCoverage.test.ts` (unit, static analysis) proves
 * the *source* stays in sync going forward. This test proves the actual
 * *runtime effect*: that breeze_app really lacks these privileges against a
 * real Postgres server, after the test setup's autoMigrate -> ensureAppRole
 * boot sequence has run — mirroring the existing audit_logs privilege check
 * in `audit-append-only.integration.test.ts`.
 */
import './setup';
import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '../../db';
import { ensureAppRole } from '../../db/ensureAppRole';
import { getAppDb, getTestDb } from './setup';

interface PrivilegeRow {
  can_select: boolean;
  can_insert: boolean;
  can_update: boolean;
  can_delete: boolean;
  can_truncate: boolean;
}

async function tablePrivileges(table: string): Promise<PrivilegeRow> {
  // `table` is always one of this file's own hardcoded test parameters
  // (never external input) — passed as an ordinary bound `text` parameter
  // to has_table_privilege(), not spliced into the SQL syntax, so no
  // sql.raw() / identifier-quoting is needed here.
  const rows = (await db.execute(sql`
    SELECT
      has_table_privilege('breeze_app', ${table}, 'SELECT') AS can_select,
      has_table_privilege('breeze_app', ${table}, 'INSERT') AS can_insert,
      has_table_privilege('breeze_app', ${table}, 'UPDATE') AS can_update,
      has_table_privilege('breeze_app', ${table}, 'DELETE') AS can_delete,
      has_table_privilege('breeze_app', ${table}, 'TRUNCATE') AS can_truncate
  `)) as unknown as Array<PrivilegeRow>;
  return rows[0]!;
}

describe('ensureAppRole append-only re-revoke — runtime privilege check (#4371)', () => {
  // Tables where the migration revokes the FULL append-only set
  // (UPDATE, DELETE, TRUNCATE) and breeze_app keeps only SELECT/INSERT.
  it.each([
    'pam_actuation_results',
    'agent_rollback_events',
    'peripheral_policy_delivery_events',
    // Table-level UPDATE is revoked; the column-level UPDATE (org_id) grant for
    // the org-merge repoint is asserted in aiInvocationsAppendOnly.integration.
    'ai_invocations',
  ])('breeze_app has no UPDATE, DELETE, or TRUNCATE on %s after ensureAppRole runs', async (table) => {
    const p = await tablePrivileges(table);
    expect(p.can_update).toBe(false);
    expect(p.can_delete).toBe(false);
    expect(p.can_truncate).toBe(false);
    expect(p.can_insert).toBe(true);
    expect(p.can_select).toBe(true);
  });

  // ml_feedback_events: migration only revokes UPDATE, DELETE (no INSERT
  // of TRUNCATE to begin with), but ensureAppRole.ts also re-revokes
  // TRUNCATE as defense-in-depth, consistent with the file's established
  // pattern elsewhere (audit_logs, agent_health_observations).
  it('breeze_app has no UPDATE, DELETE, or TRUNCATE on ml_feedback_events after ensureAppRole runs', async () => {
    const p = await tablePrivileges('ml_feedback_events');
    expect(p.can_update).toBe(false);
    expect(p.can_delete).toBe(false);
    expect(p.can_truncate).toBe(false);
    expect(p.can_insert).toBe(true);
    expect(p.can_select).toBe(true);
  });

  // automation_action_results and device_software_inventory_state
  // intentionally KEEP UPDATE and DELETE granted (ordinary mutable state) —
  // only TRUNCATE is revoked.
  it.each([
    'automation_action_results',
    'device_software_inventory_state',
    // SEC-142/143: ordinary mutable accounting state (settle/expire both
    // UPDATE it, org erasure DELETEs it), so only TRUNCATE is revoked —
    // ensureAppRole.ts revokes it from breeze_app AND PUBLIC.
    'ai_budget_reservations',
  ])(
    'breeze_app keeps UPDATE/DELETE but has no TRUNCATE on %s',
    async (table) => {
      const p = await tablePrivileges(table);
      expect(p.can_update).toBe(true);
      expect(p.can_delete).toBe(true);
      expect(p.can_truncate).toBe(false);
      expect(p.can_insert).toBe(true);
      expect(p.can_select).toBe(true);
    },
  );
});

// AI chargeback (#7608). These drive ensureAppRole() itself (as the superuser
// test connection, like boot does) after deliberately drifting a privilege, so
// they prove the per-boot re-application, not just the post-setup state.
describe('ensureAppRole re-applies the AI chargeback privileges on every boot (#7608)', () => {
  async function one<T>(query: ReturnType<typeof sql>): Promise<T> {
    const rows = (await getTestDb().execute(query)) as unknown as T[];
    return rows[0]!;
  }
  const quotedDb = async () => {
    const { name } = await one<{ name: string }>(sql`SELECT current_database() AS name`);
    return '"' + name.replace(/"/g, '""') + '"';
  };
  const appHasTemp = async () =>
    (await one<{ ok: boolean }>(sql`SELECT has_database_privilege('breeze_app', current_database(), 'TEMP') AS ok`)).ok;
  const appCanUpdateClaimColumn = async (column: string) =>
    (await one<{ ok: boolean }>(sql`SELECT has_column_privilege('breeze_app', 'ai_usage_charge_claims', ${column}, 'UPDATE') AS ok`)).ok;

  it('grants breeze_app TEMP explicitly, so the monthly close\'s temp table never rests on PUBLIC\'s default grant', async () => {
    const database = await quotedDb();
    try {
      await getTestDb().execute(sql.raw(`REVOKE TEMPORARY ON DATABASE ${database} FROM PUBLIC`));
      await getTestDb().execute(sql.raw(`REVOKE TEMPORARY ON DATABASE ${database} FROM breeze_app`));
      expect(await appHasTemp()).toBe(false); // control: the drift landed
      await ensureAppRole();
      expect(await appHasTemp()).toBe(true);
    } finally {
      await getTestDb().execute(sql.raw(`GRANT TEMPORARY ON DATABASE ${database} TO PUBLIC`));
    }
  });

  it('a drifted full UPDATE grant on ai_usage_charge_claims is revoked again: rewriting a claim is 42501, the org_id repoint stays', async () => {
    try {
      await getTestDb().execute(sql`GRANT UPDATE ON TABLE ai_usage_charge_claims TO breeze_app`);
      expect(await appCanUpdateClaimColumn('charge_id')).toBe(true); // control: the drift landed
      await ensureAppRole();
      expect(await appCanUpdateClaimColumn('charge_id')).toBe(false);
      expect(await appCanUpdateClaimColumn('run_id')).toBe(false);
      expect(await appCanUpdateClaimColumn('org_id')).toBe(true);
      // The privilege check runs before any row is read, so WHERE false still proves it.
      const err = await getAppDb().execute(sql`UPDATE ai_usage_charge_claims SET charge_id = charge_id WHERE false`)
        .then(() => null, (e: unknown) => e as { code?: string; cause?: { code?: string } });
      expect(err?.cause?.code ?? err?.code).toBe('42501');
    } finally {
      await ensureAppRole();
    }
  });
});
