import './setup';
import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { CURRENCY_CODES } from '@breeze/shared';
import {
  db,
  withDbAccessContext,
  withSystemDbAccessContext,
  runOutsideDbContext,
  type DbAccessContext,
} from '../../db';
import { supportedCurrencies } from '../../db/schema';
import { createOrganization, createPartner } from './db-utils';

function orgContext(orgId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
  };
}

describe('supported_currencies contract', () => {
  it('table contents equal the shared CURRENCY_CODES list (parity, spec §14)', async () => {
    const rows = await runOutsideDbContext(() =>
      withSystemDbAccessContext(() =>
        db.select({ code: supportedCurrencies.code }).from(supportedCurrencies),
      ),
    );

    expect(new Set(rows.map(r => r.code)).size).toBe(rows.length);
    expect(rows.map(r => r.code).sort()).toEqual([...CURRENCY_CODES].sort());
  });

  it('tenant context can SELECT', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });

    const rows = await withDbAccessContext(orgContext(org.id), () =>
      db.select({ code: supportedCurrencies.code }).from(supportedCurrencies),
    );

    expect(rows).toHaveLength(34);
  });

  it('tenant context cannot INSERT (RLS 42501)', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });

    await expect(
      withDbAccessContext(orgContext(org.id), () =>
        db.insert(supportedCurrencies).values({ code: 'XTS' }),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('system context can INSERT and DELETE (cleanup)', async () => {
    await runOutsideDbContext(() =>
      withSystemDbAccessContext(async () => {
        const inserted = await db
          .insert(supportedCurrencies)
          .values({ code: 'XTS' })
          .returning({ code: supportedCurrencies.code });
        expect(inserted).toEqual([{ code: 'XTS' }]);

        const deleted = await db
          .delete(supportedCurrencies)
          .where(eq(supportedCurrencies.code, 'XTS'))
          .returning({ code: supportedCurrencies.code });
        expect(deleted).toEqual([{ code: 'XTS' }]);
      }),
    );
  });
});
