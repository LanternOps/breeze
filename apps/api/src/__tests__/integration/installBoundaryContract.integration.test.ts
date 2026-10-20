/**
 * #8318 §5.8 — the install incarnation boundary's classification contract,
 * against the live schema.
 *
 * Every table that references `devices(id)` by FOREIGN KEY (discovered from the
 * catalog, partitions folded into their root), plus every curated FK-less
 * device reference, must be classified in
 * services/deviceInstallBoundary/classification.ts as `handler`,
 * `configuration` or `history`. Discovery is by FK, not by a column named
 * `device_id`, which is what finds `topology_telemetry_arms.collector_device_id`.
 * It reads pg_catalog rather than information_schema: the latter shows
 * neither partition roots nor constraints the reading role does not own.
 *
 * A sweep of `*device_id`, `*device_ids` and `*device_ref` columns WITHOUT a FK
 * keeps the curated list honest: each must be a curated Breeze device
 * reference or be declared as naming some other kind of device.
 */
import './setup';

import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import {
  EXTENSION_TABLES,
  FK_LESS_DEVICE_REFERENCES,
  INSTALL_BOUNDARY_CLASSIFICATION,
  NOT_A_BREEZE_DEVICE_REFERENCE,
} from '../../services/deviceInstallBoundary/classification';
import { getTestDb } from './setup';

async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await getTestDb().execute(query)) as unknown as T[];
}

async function fkReferencingTables(): Promise<Set<string>> {
  const found = await rows<{ table_name: string }>(sql`
    SELECT DISTINCT root.relname AS table_name
      FROM pg_constraint c
      JOIN pg_class child ON child.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = child.relnamespace
      JOIN pg_class root ON root.oid = COALESCE(pg_partition_root(child.oid), child.oid)
     WHERE c.contype = 'f'
       AND c.confrelid = 'public.devices'::regclass
       AND n.nspname = 'public'`);
  return new Set(found.map((r) => r.table_name));
}

async function existingTables(): Promise<Set<string>> {
  const found = await rows<{ relname: string }>(sql`
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')`);
  return new Set(found.map((r) => r.relname));
}

/** The diff the contract enforces, factored so a self-test can prove it bites. */
function classificationGaps(
  referencing: Set<string>,
  existing: Set<string>,
  classification: Record<string, unknown>,
): { unclassified: string[]; stale: string[] } {
  const unclassified = [...referencing].filter((t) => !(t in classification)).sort();
  const stale = Object.keys(classification)
    .filter((t) => !existing.has(t) && !EXTENSION_TABLES.has(t))
    .sort();
  return { unclassified, stale };
}

describe('install boundary classification contract (#8318 §5.8)', () => {
  it('discovers device references by FK, including non-device_id columns', async () => {
    const referencing = await fkReferencingTables();
    expect(referencing.has('device_commands')).toBe(true);
    expect(referencing.has('topology_telemetry_arms')).toBe(true); // collector_device_id
    expect(referencing.has('metric_rollups')).toBe(true); // a partitioned root
    expect([...referencing].some((t) => t.startsWith('metric_rollups_'))).toBe(false);
  });

  it('every table that references a device is classified, and no entry is stale', async () => {
    const referencing = await fkReferencingTables();
    for (const ref of FK_LESS_DEVICE_REFERENCES) referencing.add(ref.table);
    const gaps = classificationGaps(referencing, await existingTables(), INSTALL_BOUNDARY_CLASSIFICATION);
    expect(gaps.unclassified, 'classify in services/deviceInstallBoundary/classification.ts').toEqual([]);
    expect(gaps.stale, 'remove from services/deviceInstallBoundary/classification.ts').toEqual([]);
  });

  it('the contract bites: an unclassified referencing table is reported', async () => {
    const referencing = await fkReferencingTables();
    const { device_commands: _dropped, ...withoutOne } = INSTALL_BOUNDARY_CLASSIFICATION;
    const gaps = classificationGaps(referencing, await existingTables(), withoutOne);
    expect(gaps.unclassified).toEqual(['device_commands']);
  });

  it('every curated FK-less reference exists and really has no FK', async () => {
    const fkColumns = await rows<{ table_name: string; column_name: string }>(sql`
      SELECT cl.relname AS table_name, a.attname AS column_name
        FROM pg_constraint c
        JOIN pg_class cl ON cl.oid = c.conrelid
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
       WHERE c.contype = 'f' AND c.confrelid = 'public.devices'::regclass`);
    const withFk = new Set(fkColumns.map((r) => `${r.table_name}.${r.column_name}`));
    const columns = await rows<{ table_name: string; column_name: string }>(sql`
      SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`);
    const existing = new Set(columns.map((r) => `${r.table_name}.${r.column_name}`));
    for (const ref of FK_LESS_DEVICE_REFERENCES) {
      const key = `${ref.table}.${ref.column}`;
      expect(existing.has(key), `${key} no longer exists`).toBe(true);
      expect(withFk.has(key), `${key} now has a FK; drop it from the curated list`).toBe(false);
    }
  });

  it('every FK-less device-looking column is curated or declared as another kind of device', async () => {
    const candidates = await rows<{ table_name: string; column_name: string }>(sql`
      WITH fk AS (
        SELECT c.conrelid, a.attname
          FROM pg_constraint c
          JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
         WHERE c.contype = 'f' AND c.confrelid = 'public.devices'::regclass
      )
      SELECT cl.relname AS table_name, a.attname AS column_name
        FROM pg_attribute a
        JOIN pg_class cl ON cl.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = cl.relnamespace
       WHERE n.nspname = 'public' AND cl.relkind IN ('r', 'p') AND NOT cl.relispartition
         AND a.attnum > 0 AND NOT a.attisdropped
         AND a.attname ~ '(device_id|device_ids|device_ref)$'
         AND NOT EXISTS (SELECT 1 FROM fk WHERE fk.conrelid = cl.oid AND fk.attname = a.attname)`);
    const known = new Set([
      ...FK_LESS_DEVICE_REFERENCES.map((r) => `${r.table}.${r.column}`),
      ...NOT_A_BREEZE_DEVICE_REFERENCE.map((r) => `${r.table}.${r.column}`),
    ]);
    const unknown = candidates.map((r) => `${r.table_name}.${r.column_name}`).filter((k) => !known.has(k)).sort();
    expect(unknown, 'add to FK_LESS_DEVICE_REFERENCES (and classify) or NOT_A_BREEZE_DEVICE_REFERENCE').toEqual([]);
  });
});
