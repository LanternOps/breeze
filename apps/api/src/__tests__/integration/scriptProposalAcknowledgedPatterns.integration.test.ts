import './setup';

import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '../../db';
import { CORE_TENANT_EXPORT_POLICY } from '../../services/tenantExportPolicyRegistry';

const runDb = it.runIf(!!process.env.DATABASE_URL);

describe('script_proposals.acknowledged_patterns', () => {
  runDb('exists as a NOT NULL text[] defaulting to empty', async () => {
    const rows = await db.execute(sql`
      SELECT data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name = 'script_proposals' AND column_name = 'acknowledged_patterns'
    `);
    expect(rows.length).toBe(1);
    expect(rows[0]!.is_nullable).toBe('NO');
    expect(rows[0]!.data_type).toBe('ARRAY');
    expect(String(rows[0]!.column_default)).toContain('{}');
  });

  it('is classified in the tenant export policy as an open grant list', () => {
    const decision = CORE_TENANT_EXPORT_POLICY['script_proposals']!.columns['acknowledged_patterns'];
    expect(decision).toBeDefined();
    expect(decision!.decision).toBe('exclude');
    expect(decision!.openContainerReviewed).toBe(true);
  });
});
