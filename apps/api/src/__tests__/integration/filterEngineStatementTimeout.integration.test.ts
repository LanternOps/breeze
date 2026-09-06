import './setup';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { organizations, partners } from '../../db/schema';
import { evaluateFilter } from '../../services/filterEngine';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function firstRow<T>(result: unknown): T {
  return (Array.isArray(result) ? result[0] : (result as { rows: unknown[] }).rows[0]) as T;
}

describe('filter engine statement_timeout (real DB)', () => {
  runDb('restores the ambient transaction statement_timeout after evaluation', async () => {
    await withSystemDbAccessContext(async () => {
      const suffix = Math.random().toString(36).slice(2, 8);
      const [partner] = await db.insert(partners).values({
        name: `Filter timeout ${suffix}`,
        slug: `filter-timeout-${suffix}`,
        type: 'msp',
        plan: 'pro',
        status: 'active',
      }).returning({ id: partners.id });
      const [org] = await db.insert(organizations).values({
        partnerId: partner!.id,
        name: `Filter timeout org ${suffix}`,
        slug: `filter-timeout-org-${suffix}`,
        currencyCode: 'USD',
      }).returning({ id: organizations.id });

      const beforeResult = await db.execute(
        sql`select current_setting('statement_timeout', true) as value`,
      );
      const before = firstRow<{ value: string | null }>(beforeResult).value;

      await evaluateFilter(
        { operator: 'AND', conditions: [{ field: 'hostname', operator: 'equals', value: 'no-match' }] },
        { orgId: org!.id },
      );

      const afterResult = await db.execute(
        sql`select current_setting('statement_timeout', true) as value`,
      );
      const after = firstRow<{ value: string | null }>(afterResult).value;
      expect(after).toBe(before);
    });
  });
});
