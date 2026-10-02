import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ctx = vi.hoisted(() => ({ scope: 'system' as string | undefined }));
// The candidate heads selection returns: `queue` entries first (one per call), then the current `assigned`/`fallback`.
const cards = vi.hoisted(() => ({ assigned: null as unknown, fallback: null as unknown, queue: [] as Array<{ assigned: unknown; fallback: unknown }> }));
// The terms read returns: `queue` entries first (one per call), else `rows` when set, else it mirrors the chosen card.
const terms = vi.hoisted(() => ({ rows: undefined as unknown[] | undefined, queue: [] as unknown[][] }));

const executed = vi.hoisted(() => ({ count: 0 }));
const loaders = vi.hoisted(() => ({ heads: vi.fn(), full: vi.fn() }));
vi.mock('../../db', () => ({
  getCurrentDbAccessContext: () => (ctx.scope ? { scope: ctx.scope } : undefined),
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ partnerId: 'p-1', currencyCode: 'USD' }] }) }) }),
    // The single-statement terms read (one snapshot): returns the chosen card's terms + rates.
    execute: async () => {
      executed.count += 1;
      if (terms.queue.length) return terms.queue.shift();
      if (terms.rows) return terms.rows;
      const c = (cards.assigned ?? cards.fallback) as { currencyCode: string; aiCoverage: string; aiMarkupPercent: string | null } | null;
      return c ? [{ currency_code: c.currencyCode, ai_coverage: c.aiCoverage, ai_markup_percent: c.aiMarkupPercent, rates: [] }] : [];
    },
  },
}));
vi.mock('../billingProfileService', () => ({
  loadCardHeadsForOrg: loaders.heads,
  loadCardsForOrg: loaders.full,
}));

import { stampChargeback } from './stampChargeback';
import type { NewInvocation } from '../aiModels/invocationLedgerWrite';

const row = (over: Partial<NewInvocation> = {}): NewInvocation => ({
  orgId: 'org-1', surface: 'chat', fundingSource: 'platform', requestedModel: 'w10-test-m', servedModel: 'w10-test-m',
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, rateSnapshot: null, costCents: 400,
  ledgerMode: 'authoritative', ...over,
});
const card = { id: 'card-1', currencyCode: 'USD', aiCoverage: 'billable', aiMarkupPercent: '25.00' };

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  ctx.scope = 'system'; cards.assigned = null; cards.fallback = card; cards.queue = [];
  executed.count = 0; terms.rows = undefined; terms.queue = [];
  loaders.heads.mockReset().mockImplementation(async () => {
    const next = cards.queue.shift() ?? { assigned: cards.assigned, fallback: cards.fallback };
    return { assignedCard: next.assigned, partnerDefaultCard: next.fallback };
  });
  loaders.full.mockReset().mockImplementation(async () => ({ assignedCard: cards.assigned, partnerDefaultCard: cards.fallback }));
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { warn.mockRestore(); });

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
    expect(executed.count).toBe(0); // no card selected: no terms read
  });
  it('reads the card terms and price list in exactly one statement (one snapshot)', async () => {
    await stampChargeback('org-1', [row(), row()]);
    expect(executed.count).toBe(1);
  });
  it('selects with the lightweight card heads, never the rules-and-rates loader (one settlement, few statements)', async () => {
    await stampChargeback('org-1', [row()]);
    expect(loaders.heads).toHaveBeenCalledTimes(1);
    expect(loaders.heads).toHaveBeenCalledWith('org-1', 'p-1', 'USD');
    expect(loaders.full).not.toHaveBeenCalled();
  });
  it('the assigned card in the org currency wins over the partner default (one resolver: selectCard)', async () => {
    cards.assigned = { ...card, id: 'card-assigned', aiMarkupPercent: '50.00' };
    const [stamped] = await stampChargeback('org-1', [row()]);
    expect(stamped!.charge).toMatchObject({ billingProfileId: 'card-assigned', amount: '6.000000' });
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
  it('a card archived between selection and the terms read: selection re-runs once and stamps the card now in force', async () => {
    // First selection picks card-1; it is archived before the terms read. The
    // partner default is now card-2, which the second selection picks.
    cards.queue = [{ assigned: null, fallback: card }];
    cards.fallback = { ...card, id: 'card-2', aiMarkupPercent: '50.00' };
    terms.queue = [[]];
    const [stamped] = await stampChargeback('org-1', [row()]);
    expect(stamped!.charge).toMatchObject({ chargeable: true, billingProfileId: 'card-2', amount: '6.000000' });
    expect(loaders.heads).toHaveBeenCalledTimes(2);
    expect(executed.count).toBe(2);
    expect(warn).not.toHaveBeenCalled();
  });
  it('a card whose currency changed between selection and the terms read is re-selected too', async () => {
    terms.queue = [[{ currency_code: 'EUR', ai_coverage: 'billable', ai_markup_percent: '25.00', rates: [] }]];
    const [stamped] = await stampChargeback('org-1', [row()]);
    expect(stamped!.charge).toMatchObject({ chargeable: true, billingProfileId: 'card-1', currency: 'USD' });
    expect(loaders.heads).toHaveBeenCalledTimes(2);
  });
  it('re-selection finds no card at all: stamps no card without a warning (an ordinary state)', async () => {
    cards.queue = [{ assigned: null, fallback: card }];
    cards.fallback = null;
    terms.queue = [[]];
    const [stamped] = await stampChargeback('org-1', [row()]);
    expect(stamped!.charge).toMatchObject({ chargeable: false, billingProfileId: null });
    expect(executed.count).toBe(1);
    expect(warn).not.toHaveBeenCalled();
  });
  it('still no terms after the one re-selection: warns and stamps no card (never loops)', async () => {
    terms.rows = [];
    const [stamped] = await stampChargeback('org-1', [row()]);
    expect(stamped!.charge).toMatchObject({ chargeable: false, billingProfileId: null });
    expect(loaders.heads).toHaveBeenCalledTimes(2);
    expect(executed.count).toBe(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/\[AiChargeback\].*org-1.*card-1/));
  });
  it('leaves shadow rows unstamped', async () => {
    const [stamped] = await stampChargeback('org-1', [row({ ledgerMode: 'shadow' })]);
    expect(stamped!.charge).toBeUndefined();
    expect(loaders.heads).not.toHaveBeenCalled();
  });
  it('refuses to run outside a system context (never a second pooled connection)', async () => {
    ctx.scope = 'partner';
    await expect(stampChargeback('org-1', [row()])).rejects.toThrow(/system DB context/);
  });
  it('refuses a row of another org', async () => {
    await expect(stampChargeback('org-1', [row({ orgId: 'org-2' })])).rejects.toThrow(/settling org/);
  });
});
