import { beforeEach, describe, expect, it, vi } from 'vitest';

const ctx = vi.hoisted(() => ({ scope: 'system' as string | undefined }));
const cards = vi.hoisted(() => ({ assigned: null as unknown, fallback: null as unknown }));
// When set, the terms read returns exactly these rows (else it mirrors the chosen card).
const terms = vi.hoisted(() => ({ rows: undefined as unknown[] | undefined }));

const executed = vi.hoisted(() => ({ count: 0 }));
vi.mock('../../db', () => ({
  getCurrentDbAccessContext: () => (ctx.scope ? { scope: ctx.scope } : undefined),
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ partnerId: 'p-1', currencyCode: 'USD' }] }) }) }),
    // The single-statement terms read (finding 2): returns the chosen card's terms + rates.
    execute: async () => {
      executed.count += 1;
      if (terms.rows) return terms.rows;
      const c = (cards.assigned ?? cards.fallback) as { currencyCode: string; aiCoverage: string; aiMarkupPercent: string | null } | null;
      return c ? [{ currency_code: c.currencyCode, ai_coverage: c.aiCoverage, ai_markup_percent: c.aiMarkupPercent, rates: [] }] : [];
    },
  },
}));
vi.mock('../billingProfileService', () => ({
  loadCardsForOrg: vi.fn(async () => ({ assignedCard: cards.assigned, partnerDefaultCard: cards.fallback })),
}));

import { stampChargeback } from './stampChargeback';
import type { NewInvocation } from '../aiModels/invocationLedgerWrite';

const row = (over: Partial<NewInvocation> = {}): NewInvocation => ({
  orgId: 'org-1', surface: 'chat', fundingSource: 'platform', requestedModel: 'w10-test-m', servedModel: 'w10-test-m',
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, rateSnapshot: null, costCents: 400,
  ledgerMode: 'authoritative', ...over,
});
const card = { id: 'card-1', currencyCode: 'USD', aiCoverage: 'billable', aiMarkupPercent: '25.00', aiRates: [] };

beforeEach(() => { ctx.scope = 'system'; cards.assigned = null; cards.fallback = card; executed.count = 0; terms.rows = undefined; });

describe('stampChargeback (#7608)', () => {
  it('stamps every authoritative row from the org\'s resolved card', async () => {
    const [stamped] = await stampChargeback('org-1', [row()]);
    expect(stamped!.charge).toEqual({ chargeable: true, billingProfileId: 'card-1', coverage: 'billable',
      basis: 'markup', currency: 'USD', amount: '5.000000' });
  });
  it('stamps a no-card snapshot when the org has no card in its currency', async () => {
    cards.fallback = { ...card, currencyCode: 'EUR' };
    const [stamped] = await stampChargeback('org-1', [row()]);
    expect(stamped!.charge).toMatchObject({ chargeable: false, billingProfileId: null });
  });
  it('reads the card terms and price list in exactly one statement (one snapshot)', async () => {
    await stampChargeback('org-1', [row(), row()]);
    expect(executed.count).toBe(1);
  });
  it('prices from the price list returned by that one read, keyed on the served model', async () => {
    terms.rows = [{ currency_code: 'USD', ai_coverage: 'billable', ai_markup_percent: '25.00', rates: [{
      modelId: 'w10-test-m', inputPricePerM: '2.000000', outputPricePerM: '0.000000',
      cacheReadPricePerM: '0.000000', cacheWritePricePerM: '0.000000',
    }] }];
    const [listed, other] = await stampChargeback('org-1', [
      row({ tokens: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 } }),
      row({ servedModel: 'w10-test-unlisted' }),
    ]);
    expect(listed!.charge).toMatchObject({ chargeable: true, basis: 'price_list', amount: '2.000000' });
    expect(other!.charge).toMatchObject({ chargeable: true, basis: 'markup', amount: '5.000000' });
  });
  it('a card archived between selection and the terms read stamps no card', async () => {
    terms.rows = [];
    const [stamped] = await stampChargeback('org-1', [row()]);
    expect(stamped!.charge).toMatchObject({ chargeable: false, billingProfileId: null });
  });
  it('leaves shadow rows unstamped', async () => {
    const [stamped] = await stampChargeback('org-1', [row({ ledgerMode: 'shadow' })]);
    expect(stamped!.charge).toBeUndefined();
  });
  it('refuses to run outside a system context (never a second pooled connection)', async () => {
    ctx.scope = 'partner';
    await expect(stampChargeback('org-1', [row()])).rejects.toThrow(/system DB context/);
  });
  it('refuses a row of another org', async () => {
    await expect(stampChargeback('org-1', [row({ orgId: 'org-2' })])).rejects.toThrow(/settling org/);
  });
});
