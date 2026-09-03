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
const MIGRATION_REVOKE_RE =
  /REVOKE\s+([A-Z, ]+?)\s+ON\s+(?:TABLE\s+)?(?!FUNCTION\b|SEQUENCE\b|DATABASE\b|SCHEMA\b|ALL\b)(?:public\.)?([a-z][a-z0-9_]*)\s+FROM\s+breeze_app\s*;/gi;

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
      `REVOKE\\s+([A-Z, ]+?)\\s+ON\\s+TABLE\\s+${table}\\s+FROM\\s+breeze_app`,
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
});
