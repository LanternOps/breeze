import './setup';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { ensureDefaultProfile } from '../../services/billingProfileService';

const partnerId = randomUUID();
const context: DbAccessContext = {
  scope: 'partner', orgId: null, accessibleOrgIds: [],
  accessiblePartnerIds: [partnerId], currentPartnerId: partnerId, userId: null,
};

describe('default billing profile concurrent creation', () => {
  beforeEach(async () => {
    await withSystemDbAccessContext(() => db.execute(sql`
      INSERT INTO partners (id, name, slug, currency_code)
      VALUES (${partnerId}, 'Concurrent defaults', ${`defaults-${partnerId}`}, 'USD')
    `));
  });

  afterAll(async () => {
    await withSystemDbAccessContext(async () => {
      await db.execute(sql`DELETE FROM billing_profiles WHERE partner_id = ${partnerId}`);
      await db.execute(sql`DELETE FROM partners WHERE id = ${partnerId}`);
    });
  });

  it('two independent request transactions both succeed and return the same single default', async () => {
    // Separate request contexts hold separate PostgreSQL transactions: Promise.all
    // on a single transaction would merely serialize queries on one connection.
    const [first, second] = await Promise.all([
      withDbAccessContext(context, () => ensureDefaultProfile(partnerId, 'USD')),
      withDbAccessContext(context, () => ensureDefaultProfile(partnerId, 'USD')),
    ]);
    expect(first.id).toBe(second.id);
    const rows = await withDbAccessContext(context, () => db.execute(sql`
      SELECT id, base_coverage, base_hourly_rate FROM billing_profiles
      WHERE partner_id = ${partnerId} AND currency_code = 'USD' AND is_default AND is_active
    `));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: first.id, base_coverage: 'billable', base_hourly_rate: null });
  });
});
