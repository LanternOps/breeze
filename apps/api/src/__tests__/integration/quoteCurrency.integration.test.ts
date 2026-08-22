import './setup';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { quotes } from '../../db/schema/quotes';
import { organizations } from '../../db/schema/orgs';
import { createPartner, createOrganization } from './db-utils';
import { createQuote, cloneQuote, updateQuote } from '../../services/quoteService';

// Integration-gated (real Postgres): createQuote resolves the org currency with
// a live query, and the retarget guards compare against the target org row, so
// none of this can be exercised by the service-mocked unit suite.
const runDb = it.runIf(!!process.env.DATABASE_URL);

/**
 * USD partner with an EUR org — the case that separates wave-2 ORG stamping
 * from the old partner inheritance (#3200): under partner stamping these
 * quotes minted USD; under org stamping (spec §5, B3) they must mint EUR.
 * db-utils fixtures stamp both partner and org USD, so the org is flipped.
 */
async function usdPartnerWithEurOrg() {
  return withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    await db.update(organizations).set({ currencyCode: 'EUR' }).where(eq(organizations.id, org.id));
    return { partnerId: partner.id, orgId: org.id };
  });
}

async function quoteCurrency(id: string) {
  const [q] = await withSystemDbAccessContext(() =>
    db.select({ currencyCode: quotes.currencyCode }).from(quotes).where(eq(quotes.id, id)),
  );
  return q?.currencyCode;
}

describe('createQuote currency stamping (B3)', () => {
  runDb('stamps a new quote with the ORG currency, not the partner default', async () => {
    const { partnerId, orgId } = await usdPartnerWithEurOrg();
    const actor = { userId: null, partnerId, accessibleOrgIds: [orgId] };

    const created = await withSystemDbAccessContext(() => createQuote({ orgId }, actor));
    expect(await quoteCurrency(created.id)).toBe('EUR');
  });

  runDb('honors an explicit currencyCode over the org default', async () => {
    const { partnerId, orgId } = await usdPartnerWithEurOrg();
    const actor = { userId: null, partnerId, accessibleOrgIds: [orgId] };

    const created = await withSystemDbAccessContext(() =>
      createQuote({ orgId, currencyCode: 'GBP' }, actor),
    );
    expect(await quoteCurrency(created.id)).toBe('GBP');
  });
});

describe('cross-currency retarget guards (spec §5/§7 — block, never restamp or convert)', () => {
  runDb('cloneQuote rejects a cross-org retarget onto an org billed in another currency', async () => {
    const { partnerId, orgId } = await usdPartnerWithEurOrg();
    const usdOrg = await withSystemDbAccessContext(() => createOrganization({ partnerId }));
    const actor = { userId: null, partnerId, accessibleOrgIds: [orgId, usdOrg.id] };

    const source = await withSystemDbAccessContext(() => createQuote({ orgId }, actor)); // EUR
    await expect(
      withSystemDbAccessContext(() => cloneQuote(source.id, actor, { orgId: usdOrg.id })),
    ).rejects.toMatchObject({ code: 'CURRENCY_MISMATCH', status: 400 });
  });

  runDb('cloneQuote still allows a retarget onto a same-currency org (carrying the stamp)', async () => {
    const { partnerId, orgId } = await usdPartnerWithEurOrg();
    const eurOrg = await withSystemDbAccessContext(async () => {
      const org = await createOrganization({ partnerId });
      await db.update(organizations).set({ currencyCode: 'EUR' }).where(eq(organizations.id, org.id));
      return org;
    });
    const actor = { userId: null, partnerId, accessibleOrgIds: [orgId, eurOrg.id] };

    const source = await withSystemDbAccessContext(() => createQuote({ orgId }, actor)); // EUR
    const cloned = await withSystemDbAccessContext(() =>
      cloneQuote(source.id, actor, { orgId: eurOrg.id }),
    );
    expect(cloned.orgId).toBe(eurOrg.id);
    expect(await quoteCurrency(cloned.id)).toBe('EUR');
  });

  runDb('updateQuote rejects an org move onto an org billed in another currency, leaving the draft untouched', async () => {
    const { partnerId, orgId } = await usdPartnerWithEurOrg();
    const usdOrg = await withSystemDbAccessContext(() => createOrganization({ partnerId }));
    const actor = { userId: null, partnerId, accessibleOrgIds: [orgId, usdOrg.id] };

    const draft = await withSystemDbAccessContext(() => createQuote({ orgId }, actor)); // EUR
    await expect(
      withSystemDbAccessContext(() => updateQuote(draft.id, { orgId: usdOrg.id }, actor)),
    ).rejects.toMatchObject({ code: 'CURRENCY_MISMATCH', status: 400 });

    const [after] = await withSystemDbAccessContext(() =>
      db.select({ orgId: quotes.orgId, currencyCode: quotes.currencyCode })
        .from(quotes).where(eq(quotes.id, draft.id)),
    );
    expect(after).toEqual({ orgId, currencyCode: 'EUR' });
  });
});
