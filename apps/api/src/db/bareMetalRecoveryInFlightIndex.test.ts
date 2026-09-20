// #6322: the "one non-terminal recovery per device" guard is a PARTIAL unique
// index whose predicate hard-codes the terminal statuses in two places that
// TypeScript cannot relate — the migration SQL and the Drizzle schema's
// `.where(sql\`...\`)`. Nothing else cross-checks either against
// BARE_METAL_RECOVERY_TERMINAL, so adding a terminal status would silently
// leave the index predicate behind: the new status would still occupy the
// device's in-flight slot forever. This test is that cross-check.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BARE_METAL_RECOVERY_TERMINAL } from './schema/bareMetalRecoveries';

const MIGRATION = join(
  __dirname,
  '../../migrations/2026-10-25-120000-bare-metal-recoveries-in-flight-unique.sql',
);
const INDEX_NAME = 'bare_metal_recoveries_device_in_flight_idx';

/** The statuses named inside a `status NOT IN ('a', 'b', ...)` clause. */
function statusesInNotInClause(sql: string): string[][] {
  return [...sql.matchAll(/status\s+not\s+in\s*\(([^)]*)\)/gi)].map((match) =>
    [...match[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!).sort(),
  );
}

describe('bare-metal one-in-flight partial unique index (#6322)', () => {
  const expected = [...BARE_METAL_RECOVERY_TERMINAL].sort();
  const migrationSql = readFileSync(MIGRATION, 'utf8');

  it('is declared under the same index name in the schema, the migration, and the service', () => {
    const schemaSource = readFileSync(join(__dirname, 'schema/bareMetalRecoveries.ts'), 'utf8');
    const serviceSource = readFileSync(join(__dirname, '../services/bareMetalRecoveryService.ts'), 'utf8');
    expect(schemaSource).toContain(`uniqueIndex('${INDEX_NAME}')`);
    expect(migrationSql).toContain(INDEX_NAME);
    // The service maps 23505 on this exact name to the recovery_in_progress
    // 409; a rename anywhere would turn that into an unhandled 500.
    expect(serviceSource).toContain(`'${INDEX_NAME}'`);
  });

  it('migration predicate names exactly BARE_METAL_RECOVERY_TERMINAL', () => {
    const clauses = statusesInNotInClause(migrationSql);
    expect(clauses.length).toBeGreaterThan(0);
    for (const clause of clauses) {
      expect(clause).toEqual(expected);
    }
  });

  it('Drizzle schema predicate names exactly BARE_METAL_RECOVERY_TERMINAL', () => {
    const schemaSource = readFileSync(join(__dirname, 'schema/bareMetalRecoveries.ts'), 'utf8');
    const predicate = schemaSource.slice(schemaSource.indexOf('deviceInFlightIdx'));
    const clauses = statusesInNotInClause(predicate);
    expect(clauses.length).toBe(1);
    expect(clauses[0]).toEqual(expected);
  });

  it('the migration creates the index unconditionally (idempotently), not behind a flag', () => {
    expect(migrationSql).toMatch(
      /create\s+unique\s+index\s+if\s+not\s+exists\s+bare_metal_recoveries_device_in_flight_idx/i,
    );
  });
});
