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
  it.each(['automation_action_results', 'device_software_inventory_state'])(
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
