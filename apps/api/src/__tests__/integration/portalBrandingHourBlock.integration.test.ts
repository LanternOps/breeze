import './setup';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { portalBranding } from '../../db/schema';
import { createOrganization, createPartner } from './db-utils';
import { getTestDb } from './setup';

describe('portal_branding.enable_hour_block (block hours W04)', () => {
  it('defaults to false on a fresh row — the fail-closed posture', async () => {
    const admin = getTestDb();
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });

    const [row] = await admin
      .insert(portalBranding)
      .values({ orgId: org.id })
      .returning({ enableHourBlock: portalBranding.enableHourBlock });

    expect(row?.enableHourBlock).toBe(false);
  });

  it('is NOT NULL with a false default in the catalog', async () => {
    const admin = getTestDb();
    const result = await admin.execute(sql`
      SELECT is_nullable, column_default
        FROM information_schema.columns
       WHERE table_name = 'portal_branding' AND column_name = 'enable_hour_block'
    `);
    const row = Array.from(result)[0] as { is_nullable: string; column_default: string } | undefined;
    expect(row?.is_nullable).toBe('NO');
    expect(row?.column_default).toBe('false');
  });
});
