import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const rows: unknown[][] = [];
  return {
    rows,
    select: vi.fn(() => {
      const result = rows.length > 0 ? rows.shift()! : [];
      const proxy: unknown = new Proxy({}, {
        get(_t, prop) {
          if (prop === 'then') return (resolve: (v: unknown) => unknown) => resolve(result);
          return () => proxy;
        },
      });
      return proxy;
    }),
    resolveLineQty: vi.fn(),
    resolvePrice: vi.fn(),
    resolveTax: vi.fn(),
  };
});

vi.mock('../db', () => ({ db: { select: h.select } }));
vi.mock('./contractService', () => ({ resolveLineQty: h.resolveLineQty }));
vi.mock('./catalogService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./catalogService')>()),
  resolvePrice: h.resolvePrice,
}));
vi.mock('./taxRateResolver', () => ({ resolveOrgTaxRateOn: h.resolveTax }));

import { CatalogServiceError } from './catalogService';
import {
  ContractInvoicePreviewNotFound, previewDigestMaterial, previewDueInvoice, type InvoicePreview,
} from './contractInvoicePreview';

const CONTRACT = 'c0000000-0000-4000-8000-000000000001';
const ASOF = new Date('2026-02-01T12:00:00Z');

const contract = (over: Record<string, unknown> = {}) => ({
  id: CONTRACT, orgId: 'org-1', partnerId: 'partner-1', createdBy: 'user-1', status: 'active',
  nextBillingAt: '2026-02-01', startDate: '2026-01-01', intervalMonths: 1, billingTiming: 'advance',
  endDate: null, autoRenew: false, renewalTermMonths: null, currencyCode: 'USD', autoIssue: false, ...over,
});
const line = (id: string, over: Record<string, unknown> = {}) => ({
  id, lineType: 'flat', unitPrice: '100.00', taxable: true, catalogItemId: null, hourBlockRetiredAt: null,
  overageUnitPrice: null, ...over,
});
const queue = (c: unknown, lines: unknown[], org?: unknown) => {
  h.rows.push(c ? [c] : []);
  if (c) h.rows.push(lines);
  if (org !== undefined) h.rows.push([org]);
};
const due = async () => (await previewDueInvoice(CONTRACT, ASOF)) as Extract<InvoicePreview, { due: true }>;

beforeEach(() => {
  vi.clearAllMocks();
  h.rows.length = 0;
  h.resolveLineQty.mockResolvedValue({ counted: 1, billed: 1, included: null, overage: 0, overageMode: null });
  h.resolveTax.mockResolvedValue('0.10000');
});

describe('previewDueInvoice', () => {
  it('throws ContractInvoicePreviewNotFound for an unknown contract', async () => {
    queue(null, []);
    await expect(previewDueInvoice(CONTRACT, ASOF)).rejects.toBeInstanceOf(ContractInvoicePreviewNotFound);
  });

  it('is not_due for a non-active contract and for a pointer in the future', async () => {
    h.rows.push([contract({ status: 'paused' })]);
    expect(await previewDueInvoice(CONTRACT, ASOF)).toMatchObject({ due: false, reason: 'not_due' });
    h.rows.push([contract({ nextBillingAt: '2026-03-01' })]);
    expect(await previewDueInvoice(CONTRACT, ASOF)).toMatchObject({ due: false, reason: 'not_due' });
    expect(h.select).toHaveBeenCalledTimes(2); // lines are never read
  });

  it('prices flat and per_device lines and taxes only the taxable ones', async () => {
    queue(contract(), [line('l1'), line('l2', { lineType: 'per_device', unitPrice: '10.00', taxable: false })]);
    h.resolveLineQty
      .mockResolvedValueOnce({ counted: 1, billed: 1, included: null, overage: 0, overageMode: null })
      .mockResolvedValueOnce({ counted: 3, billed: 3, included: null, overage: 0, overageMode: null });
    const p = await due();
    expect(p.lines.map((l) => [l.quantity, l.unitPrice, l.lineTotal, l.taxable, l.pricedFrom]))
      .toEqual([['1', '100.00', '100.00', true, 'contract_snapshot'], ['3', '10.00', '30.00', false, 'contract_snapshot']]);
    expect(p.subtotal).toBe('130.00');
    expect(p.taxRate).toBe('0.10000');
    expect(p.taxTotal).toBe('10.00'); // 10% of the taxable 100.00 only
    expect(p.total).toBe('140.00');
    expect(p.period).toEqual({ start: '2026-02-01', end: expect.any(String) });
    expect(p.blocked).toBeNull();
  });

  it('prices a catalog line from resolvePrice, including the resolved taxable flag', async () => {
    queue(contract(), [line('l1', { catalogItemId: 'cat-1', taxable: true })]);
    h.resolvePrice.mockResolvedValue({ unitPrice: '80.00', taxable: false, source: 'price_book' });
    const p = await due();
    expect(h.resolvePrice).toHaveBeenCalledWith('cat-1', 'USD', 'org-1', expect.objectContaining({ partnerId: 'partner-1' }));
    expect(p.lines[0]).toMatchObject({ unitPrice: '80.00', taxable: false, pricedFrom: 'price_book' });
    expect(p.taxTotal).toBe('0.00');
  });

  it('falls back to the contract snapshot on NO_PRICE_FOR_CURRENCY; any other catalog error propagates', async () => {
    queue(contract(), [line('l1', { catalogItemId: 'cat-1' })]);
    h.resolvePrice.mockRejectedValue(new CatalogServiceError('no price', 409, 'NO_PRICE_FOR_CURRENCY' as never));
    expect((await due()).lines[0]).toMatchObject({ unitPrice: '100.00', pricedFrom: 'contract_snapshot' });

    queue(contract(), [line('l1', { catalogItemId: 'cat-1' })]);
    h.resolvePrice.mockRejectedValue(new CatalogServiceError('gone', 404));
    await expect(previewDueInvoice(CONTRACT, ASOF)).rejects.toMatchObject({ name: 'CatalogServiceError', message: 'gone' });
  });

  it('blocks a live hour_block line, but not a retired one', async () => {
    queue(contract(), [line('hb', { lineType: 'hour_block' })]);
    expect((await due()).blocked).toEqual({ code: 'HOUR_BLOCK_NOT_SUPPORTED', contractLineId: 'hb' });

    queue(contract(), [line('hb', { lineType: 'hour_block', hourBlockRetiredAt: new Date() }), line('l2')]);
    expect((await due()).blocked).toBeNull();
  });

  it('blocks an unresolved line and leaves it off the invoice', async () => {
    queue(contract(), [line('l1'), line('l2', { lineType: 'manual' })]);
    h.resolveLineQty
      .mockResolvedValueOnce({ counted: 1, billed: 1, included: null, overage: 0, overageMode: null })
      .mockResolvedValueOnce({ unresolved: 'manual_quantity_missing' });
    const p = await due();
    expect(p.blocked).toEqual({ code: 'LINE_UNRESOLVED', contractLineId: 'l2', reason: 'manual_quantity_missing' });
    expect(p.lines).toHaveLength(1);
  });

  it('autoIssue true takes recipients from the billing contact; false is [] with no org read', async () => {
    queue(contract({ autoIssue: true }), [line('l1')], { billingContact: { email: 'ap@example.test' } });
    expect((await due()).recipients).toEqual(['ap@example.test']);

    queue(contract({ autoIssue: true }), [line('l1')], { billingContact: null });
    expect((await due()).recipients).toEqual([]);

    h.select.mockClear();
    queue(contract({ autoIssue: false }), [line('l1')]);
    expect((await due()).recipients).toEqual([]);
    expect(h.select).toHaveBeenCalledTimes(2); // contract + lines, never organizations
  });
});

describe('previewDigestMaterial', () => {
  const basePreview = async (): Promise<Extract<InvoicePreview, { due: true }>> => {
    queue(contract({ autoIssue: true }), [line('l1')], { billingContact: { email: 'ap@example.test' } });
    return due();
  };
  const changed = (p: Extract<InvoicePreview, { due: true }>, mut: (c: Extract<InvoicePreview, { due: true }>) => void) => {
    const copy = structuredClone(p);
    mut(copy);
    return previewDigestMaterial(copy) !== previewDigestMaterial(p);
  };

  it('is stable for an identical preview', async () => {
    const p = await basePreview();
    expect(previewDigestMaterial(structuredClone(p))).toBe(previewDigestMaterial(p));
  });

  it('changes when a line quantity, unit price or taxable flag, the total, autoIssue or recipients change', async () => {
    const p = await basePreview();
    expect(changed(p, (c) => { c.lines[0].quantity = '2'; })).toBe(true);
    expect(changed(p, (c) => { c.lines[0].unitPrice = '99.00'; })).toBe(true);
    expect(changed(p, (c) => { c.lines[0].taxable = !c.lines[0].taxable; })).toBe(true);
    expect(changed(p, (c) => { c.total = '999.00'; })).toBe(true);
    expect(changed(p, (c) => { c.autoIssue = !c.autoIssue; })).toBe(true);
    expect(changed(p, (c) => { c.recipients = ['other@example.test']; })).toBe(true);
  });

  it('pins a not-due reason', () => {
    const a = previewDigestMaterial({ due: false, contractId: 'c', orgId: 'o', reason: 'not_due', nextBillingAt: null });
    const b = previewDigestMaterial({ due: false, contractId: 'c', orgId: 'o', reason: 'expired', nextBillingAt: null });
    expect(a).not.toBe(b);
  });
});
