import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Static-analysis contract test for #4371: ensureAppRole()'s blanket
// `GRANT ... UPDATE, DELETE, REFERENCES ON ALL TABLES` (step 4) re-permits
// whatever an append-only table's migration REVOKEd from breeze_app, on
// every boot — the migration-time REVOKE is real at apply time but is
// silently undone the moment the API restarts. Step 5 of ensureAppRole.ts
// exists specifically to re-apply those per-table REVOKEs after the blanket
// GRANT, but nothing enforced that every table which revokes a privilege
// from breeze_app in a migration actually has a matching re-revoke block —
// pam_actuation_results shipped without one (#4371), and this test found
// five more tables with the same gap.
//
// This reads both sources of truth statically (no DB needed, runs in the
// unit job): every `REVOKE <privs> ON [TABLE] <table> FROM breeze_app`
// statement across apps/api/migrations/*.sql, and every per-table re-revoke
// block in ensureAppRole.ts (keyed off `table_name='<table>'`). For every
// table+privilege a migration revoked from breeze_app, ensureAppRole.ts must
// revoke at least that privilege back on every boot.

const migrationsDir = path.resolve(__dirname, '../../migrations');
const ensureAppRolePath = path.resolve(__dirname, './ensureAppRole.ts');

// Table-level REVOKE ... FROM breeze_app in a migration. Deliberately
// excludes REVOKE ... ON FUNCTION / SEQUENCE / DATABASE / SCHEMA / ALL —
// those aren't the blanket-GRANT-on-ALL-TABLES hazard this test guards.
//
// Two deliberate tolerances (both exercised by regression cases below):
// - `[A-Z,\s]+?` (not `[A-Z, ]+?`) so a privilege list wrapped across lines
//   still matches.
// - `['"]?` before the terminating `;` so a REVOKE embedded verbatim inside
//   a `DO $$ ... EXECUTE 'REVOKE ... FROM breeze_app;' ... END $$` dynamic-SQL
//   string (whose closing quote sits between `breeze_app` and `;`) still
//   matches. This does NOT resolve a *templated* table name built via
//   `format('... %I ...', tbl)` — that requires reading the migration by
//   eye; there is no such case in the migrations directory today.
const MIGRATION_REVOKE_RE =
  /REVOKE\s+([A-Z,\s]+?)\s+ON\s+(?:TABLE\s+)?(?!FUNCTION\b|SEQUENCE\b|DATABASE\b|SCHEMA\b|ALL\b)(?:public\.)?([a-z][a-z0-9_]*)\s+FROM\s+breeze_app\s*['"]?\s*;/gi;

function parsePrivs(rawPrivList: string): Set<string> {
  return new Set(
    rawPrivList
      .split(',')
      .map((p) => p.trim().toUpperCase())
      .filter(Boolean),
  );
}

/** Every table+privilege set REVOKEd from breeze_app across all migrations. */
function collectMigrationRevokes(): Map<string, Set<string>> {
  const revokes = new Map<string, Set<string>>();
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'));

  for (const file of files) {
    const text = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    for (const match of text.matchAll(MIGRATION_REVOKE_RE)) {
      // Both groups are mandatory captures in MIGRATION_REVOKE_RE — a
      // successful match always populates them.
      const table = match[2]!.toLowerCase();
      const privs = parsePrivs(match[1]!);
      const existing = revokes.get(table) ?? new Set<string>();
      for (const p of privs) existing.add(p);
      revokes.set(table, existing);
    }
  }
  return revokes;
}

/**
 * Every table+privilege set ensureAppRole.ts re-revokes from breeze_app,
 * keyed off the `table_name='<table>'` existence-check idiom the file uses
 * for every per-table override block (see step 5's `DO $$ ... END $$`).
 */
function collectEnsureAppRoleRevokes(): Map<string, Set<string>> {
  const src = fs.readFileSync(ensureAppRolePath, 'utf8');
  const tableNameRe = /table_name='([a-z_][a-z0-9_]*)'/g;
  const anchors = [...src.matchAll(tableNameRe)];

  const revokes = new Map<string, Set<string>>();
  for (let i = 0; i < anchors.length; i++) {
    const anchor = anchors[i]!;
    // Group 1 is a mandatory capture in tableNameRe — a successful match
    // always populates it.
    const table = anchor[1]!;
    const blockStart = anchor.index ?? 0;
    const nextAnchor = anchors[i + 1];
    const blockEnd = nextAnchor ? (nextAnchor.index ?? src.length) : src.length;
    const block = src.slice(blockStart, blockEnd);

    const revokeRe = new RegExp(
      `REVOKE\\s+([A-Z,\\s]+?)\\s+ON\\s+TABLE\\s+${table}\\s+FROM\\s+breeze_app`,
      'gi',
    );
    const privs = revokes.get(table) ?? new Set<string>();
    for (const match of block.matchAll(revokeRe)) {
      for (const p of parsePrivs(match[1]!)) privs.add(p);
    }
    revokes.set(table, privs);
  }
  return revokes;
}

describe('ensureAppRole append-only re-revoke coverage (#4371)', () => {
  const migrationRevokes = collectMigrationRevokes();
  const ensureAppRoleRevokes = collectEnsureAppRoleRevokes();

  it('found at least one append-only REVOKE in migrations (sanity check that parsing works)', () => {
    expect(migrationRevokes.size).toBeGreaterThan(0);
    expect(migrationRevokes.has('audit_logs')).toBe(true);
  });

  it.each([...migrationRevokes.entries()].sort(([a], [b]) => a.localeCompare(b)))(
    'ensureAppRole.ts re-revokes every privilege %s revoked from breeze_app in a migration (found: %s)',
    (table, migrationPrivs) => {
      const ensurePrivs = ensureAppRoleRevokes.get(table) ?? new Set<string>();
      const missing = [...migrationPrivs].filter((p) => !ensurePrivs.has(p));
      expect(
        missing,
        `ensureAppRole.ts is missing a re-revoke of [${missing.join(', ')}] on ` +
          `'${table}' — the blanket GRANT in step 4 re-permits it on every boot. ` +
          `Add an "IF EXISTS (... table_name='${table}') THEN REVOKE ${[...migrationPrivs].join(', ')} ON TABLE ${table} FROM breeze_app; END IF;" ` +
          `block following the pattern at ensureAppRole.ts's step 5.`,
      ).toEqual([]);
    },
  );

  // #4371 writer-path matrix — the executable half of the doc comment above
  // ensureAppRole.ts's six #4371 re-revoke blocks. Closing the original
  // privilege gap wasn't enough on its own: every legitimate writer of these
  // tables (device permanent-delete, device org-move, org merge, org
  // erasure) had to keep working under the now-real privilege wall too —
  // see deviceDeletion.ts's DEVICE_CASCADE_AUDIT_ADMIN_TABLES,
  // routes/devices/core.ts's DEVICE_ORG_FK_CASCADE_TABLES, and
  // orgMergeRegistry.ts's per-table classification for how each was
  // reconciled. This asserts EXACT equality (not just "at least"), unlike
  // the superset check above, so a future PR can't silently OVER-tighten
  // one of these six and reopen a writer-path conflict the same way #4371's
  // own fix did for agent_rollback_events/pam_actuation_results — a
  // narrower re-revoke here should force a conscious update to this table,
  // not a silent green.
  //
  // 'kept' lists privileges intentionally left granted; the reason lives in
  // ensureAppRole.ts's matrix comment, not duplicated here. A table with an
  // empty 'kept' array is fully privilege-walled — no app path ever needs
  // breeze_app to hold UPDATE/DELETE/TRUNCATE on it.
  const WRITER_PATH_MATRIX: ReadonlyArray<{ table: string; revoked: string[]; kept: string[] }> = [
    { table: 'pam_actuation_results', revoked: ['UPDATE', 'DELETE', 'TRUNCATE'], kept: [] },
    { table: 'agent_rollback_events', revoked: ['UPDATE', 'DELETE', 'TRUNCATE'], kept: [] },
    { table: 'ml_feedback_events', revoked: ['UPDATE', 'DELETE', 'TRUNCATE'], kept: [] },
    // peripheral_policy_delivery_events keeps UPDATE — residual gap tracked
    // as issue #4806 (moveOrg.ts's restamp loop still needs it).
    { table: 'peripheral_policy_delivery_events', revoked: ['DELETE', 'TRUNCATE'], kept: ['UPDATE'] },
    { table: 'automation_action_results', revoked: ['TRUNCATE'], kept: ['UPDATE', 'DELETE'] },
    { table: 'device_software_inventory_state', revoked: ['TRUNCATE'], kept: ['UPDATE', 'DELETE'] },
  ];

  it.each(WRITER_PATH_MATRIX)(
    'ensureAppRole.ts revokes EXACTLY [$revoked] (not more, not less) on $table',
    ({ table, revoked }) => {
      const ensurePrivs = [...(ensureAppRoleRevokes.get(table) ?? new Set<string>())].sort();
      expect(
        ensurePrivs,
        `ensureAppRole.ts's re-revoke for '${table}' no longer matches the documented writer-path ` +
          `matrix (ensureAppRole.ts's #4371 comment block and this file's WRITER_PATH_MATRIX). If this ` +
          `is a deliberate change, update BOTH the matrix here and the doc comment there — a narrower ` +
          `revoke can silently reopen a writer-path conflict (see DEVICE_CASCADE_AUDIT_ADMIN_TABLES / ` +
          `DEVICE_ORG_FK_CASCADE_TABLES / orgMergeRegistry.ts), and a broader one needs the same writer-path ` +
          `audit #4371 did before it ships.`,
      ).toEqual([...revoked].sort());
    },
  );

  it('WRITER_PATH_MATRIX accounts for exactly the tables ensureAppRole.ts revokes something from breeze_app for beyond the pre-#4371 baseline', () => {
    // Sanity check that the matrix itself hasn't drifted from ensureAppRole.ts:
    // every table the matrix names must actually appear in the source with a
    // re-revoke block (guards against a stale/renamed table silently making
    // the it.each above a vacuous no-op).
    for (const { table } of WRITER_PATH_MATRIX) {
      expect(ensureAppRoleRevokes.has(table), `ensureAppRole.ts has no re-revoke block for '${table}'`).toBe(true);
    }
  });
});
