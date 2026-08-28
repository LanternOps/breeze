import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '../../db';

describe('Org lifecycle foundations contract', () => {
  it('org_status enum carries the lifecycle values', async () => {
    const result = await db.execute(sql`
      SELECT e.enumlabel FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'org_status'
    `);
    const labels = (result as unknown as Array<{ enumlabel: string }>).map(r => r.enumlabel);
    for (const v of ['active', 'suspended', 'trial', 'churned', 'offboarding', 'merging', 'archived', 'purging']) {
      expect(labels, `org_status missing '${v}'`).toContain(v);
    }
  });

  it('organizations carries the lifecycle columns', async () => {
    const result = await db.execute(sql`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name = 'organizations'
        AND column_name IN ('archived_at', 'purge_at', 'offboarding_target')
    `);
    const rows = result as unknown as Array<{ column_name: string; is_nullable: string }>;
    expect(rows.map(r => r.column_name).sort()).toEqual(['archived_at', 'offboarding_target', 'purge_at']);
    expect(rows.find(r => r.column_name === 'offboarding_target')!.is_nullable).toBe('NO');
  });

  it('offboarding_target rejects unknown values', async () => {
    // CHECK constraint exists (name pinned so Wave 4 error handling can rely on it)
    const result = await db.execute(sql`
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'organizations'::regclass AND conname = 'organizations_offboarding_target_chk'
    `);
    expect((result as unknown as unknown[]).length).toBe(1);
  });

  it('every composite FK referencing an org_id column is deferrable (merge contract)', async () => {
    const result = await db.execute(sql`
      SELECT con.conname, con.conrelid::regclass::text AS child_table
      FROM pg_constraint con
      WHERE con.contype = 'f'
        AND con.condeferrable = false
        AND con.connamespace = 'public'::regnamespace
        AND EXISTS (
          SELECT 1 FROM unnest(con.confkey) AS ck(attnum)
          JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = ck.attnum
          WHERE a.attname = 'org_id'
        )
    `);
    const offenders = (result as unknown as Array<{ conname: string; child_table: string }>)
      .map(r => `${r.child_table}.${r.conname}`);
    // Merge (Wave 2) runs SET CONSTRAINTS ALL DEFERRED and re-points parent+child
    // org_id in separate statements. A non-deferrable composite FK here breaks it.
    // New composite (x, org_id) FKs MUST be declared DEFERRABLE INITIALLY IMMEDIATE.
    expect(offenders).toEqual([]);
  });
});
