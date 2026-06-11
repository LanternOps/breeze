import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { M365_TENANT_ID_REGEX } from '../services/c2cM365';

/**
 * Migration ↔ regex parity.
 *
 * The DB-side defense-in-depth CHECK in
 * `migrations/2026-05-31-c2c-tenant-id-guid-check.sql` embeds a GUID pattern
 * that MUST stay in lock-step with the app-layer `M365_TENANT_ID_REGEX`
 * (apps/api/src/services/c2cM365.ts). If one drifts, the database and the
 * application would silently disagree about what a valid tenant id is.
 *
 * The SQL uses the case-insensitive `~*` operator, so its `[0-9a-f]` classes
 * are equivalent to the TS regex's `[0-9a-fA-F]` classes — the two patterns are
 * the same set. This test fails the moment either side drifts.
 */
describe('c2c tenant-id GUID CHECK migration parity', () => {
  const migrationPath = join(
    __dirname,
    '../../migrations/2026-05-31-c2c-tenant-id-guid-check.sql'
  );
  const sql = readFileSync(migrationPath, 'utf8');

  const SQL_PATTERN =
    "tenant_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'";

  it('embeds the case-insensitive GUID CHECK pattern verbatim', () => {
    expect(sql).toContain(SQL_PATTERN);
  });

  it('keeps M365_TENANT_ID_REGEX in sync with the SQL pattern', () => {
    expect(M365_TENANT_ID_REGEX.source).toBe(
      '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    );
  });
});
