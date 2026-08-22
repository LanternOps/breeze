import './setup';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { invoices, invoiceLines } from '../../db/schema/invoices';
import { quotes } from '../../db/schema/quotes';
import { createPartner, createOrganization } from './db-utils';
import { invoiceDerivedTitleSql } from '../../routes/portal/invoices';

// The portal invoice list derives a human title from a raw correlated subselect.
// Its unit test pins the SOURCE (`invoices.id` written by hand); this pins the
// BEHAVIOUR against real Postgres, where the bare-`"id"` rendering the unit test
// guards against would correlate the subquery with itself and return NULL for
// every row — exactly the all-null regression that shipped once.
const runDb = it.runIf(!!process.env.DATABASE_URL);

async function titleOf(invoiceId: string): Promise<string | null> {
  const [row] = await withSystemDbAccessContext(() =>
    db.select({ title: invoiceDerivedTitleSql }).from(invoices).where(eq(invoices.id, invoiceId))
  );
  return row?.title ?? null;
}

describe('portal invoice derived title', () => {
  runDb('newest converted proposal wins, else first customer-visible line, else NULL', async () => {
    const fx = await withSystemDbAccessContext(async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const base = { partnerId: partner.id, orgId: org.id, currencyCode: 'USD' as const };

      const [fromQuote] = await db.insert(invoices).values({ ...base, status: 'sent' }).returning({ id: invoices.id });
      const [fromLine] = await db.insert(invoices).values({ ...base, status: 'sent' }).returning({ id: invoices.id });
      const [bare] = await db.insert(invoices).values({ ...base, status: 'sent' }).returning({ id: invoices.id });

      // Two proposals converted into the same invoice: the newer title must win.
      await db.insert(quotes).values({ ...base, status: 'converted', title: 'Older proposal', convertedInvoiceId: fromQuote!.id, createdAt: new Date('2026-01-01') });
      await db.insert(quotes).values({ ...base, status: 'converted', title: 'Managed IT — August', convertedInvoiceId: fromQuote!.id, createdAt: new Date('2026-02-01') });
      // A hidden line must not name the invoice; the first VISIBLE line by sort order does.
      await db.insert(invoiceLines).values([
        { invoiceId: fromLine!.id, orgId: org.id, sourceType: 'manual', name: 'Internal adjustment', quantity: '1', unitPrice: '0', customerVisible: false, sortOrder: 0 },
        { invoiceId: fromLine!.id, orgId: org.id, sourceType: 'manual', name: 'Support retainer', quantity: '1', unitPrice: '100', customerVisible: true, sortOrder: 1 },
        { invoiceId: fromLine!.id, orgId: org.id, sourceType: 'manual', name: 'Onboarding', quantity: '1', unitPrice: '50', customerVisible: true, sortOrder: 2 },
      ]);
      return { fromQuote: fromQuote!.id, fromLine: fromLine!.id, bare: bare!.id };
    });

    expect(await titleOf(fx.fromQuote)).toBe('Managed IT — August');
    expect(await titleOf(fx.fromLine)).toBe('Support retainer');
    expect(await titleOf(fx.bare)).toBeNull();
  });
});
