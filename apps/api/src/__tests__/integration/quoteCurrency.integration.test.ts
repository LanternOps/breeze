import './setup';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { quotes } from '../../db/schema/quotes';
import { partners } from '../../db/schema/orgs';
import { createPartner, createOrganization } from './db-utils';
import { createQuote } from '../../services/quoteService';

// Integration-gated (real Postgres): createQuote resolves the partner currency
// with a live query, so this cannot be exercised by the service-mocked unit
// suite. Runs in CI's Test API against a real DB.
const runDb = it.runIf(!!process.env.DATABASE_URL);

async function eurPartnerWithOrg() {
  return withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    await db.update(partners).set({ currencyCode: 'EUR' }).where(eq(partners.id, partner.id));
    const org = await createOrganization({ partnerId: partner.id });
    return { partnerId: partner.id, orgId: org.id };
  });
}

describe('createQuote currency defaulting (#3200)', () => {
  runDb('defaults a new quote to the partner currency when currencyCode is omitted', async () => {
    const { partnerId, orgId } = await eurPartnerWithOrg();
    const actor = { userId: null, partnerId, accessibleOrgIds: [orgId] };

    const created = await withSystemDbAccessContext(() => createQuote({ orgId }, actor));
    const [q] = await withSystemDbAccessContext(() =>
      db.select({ currencyCode: quotes.currencyCode }).from(quotes).where(eq(quotes.id, created.id)),
    );
    expect(q?.currencyCode).toBe('EUR');
  });

  runDb('honors an explicit currencyCode over the partner default', async () => {
    const { partnerId, orgId } = await eurPartnerWithOrg();
    const actor = { userId: null, partnerId, accessibleOrgIds: [orgId] };

    const created = await withSystemDbAccessContext(() =>
      createQuote({ orgId, currencyCode: 'GBP' }, actor),
    );
    const [q] = await withSystemDbAccessContext(() =>
      db.select({ currencyCode: quotes.currencyCode }).from(quotes).where(eq(quotes.id, created.id)),
    );
    expect(q?.currencyCode).toBe('GBP');
  });
});
