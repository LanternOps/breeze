/**
 * Full-control W14 PR B (#6784): the effect-digest pins for the three four-eyes money surfaces —
 * manage_contracts:generate_invoice and manage_accounting_sync push / push_bulk — and their per-ACTION mandatory
 * policy (PR B quorum QB7). The material builders are mocked: their own suites own what goes into the material;
 * this one owns the resolver wiring (argument checks, absent targets, order independence, drift → a new digest).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../../db';

const h = vi.hoisted(() => ({
  preview: vi.fn(),
  pushMaterial: vi.fn(),
}));

vi.mock('../contractInvoicePreview', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../contractInvoicePreview')>();
  return { ...actual, previewDueInvoice: h.preview };
});
vi.mock('./accountingPushDigest', () => ({ accountingPushMaterial: h.pushMaterial }));

import { computeEffectDigestOutcome, effectDigestResolverKey, requiresPinnedEffectDigest } from './effectDigest';
import { ContractInvoicePreviewNotFound, type InvoicePreview } from '../contractInvoicePreview';

const database = {} as Database;
const CONTRACT = '11111111-1111-4111-8111-111111111111';
const INV_A = '22222222-2222-4222-8222-222222222222';
const INV_B = '33333333-3333-4333-8333-333333333333';

const duePreview = (over: Partial<Extract<InvoicePreview, { due: true }>> = {}): InvoicePreview => ({
  due: true, contractId: CONTRACT, orgId: 'org-1', partnerId: 'p-1',
  period: { start: '2026-10-01', end: '2026-10-31' }, currencyCode: 'USD', autoIssue: true,
  lines: [{
    contractLineId: 'l-1', lineType: 'per_device', quantity: '12', unitPrice: '10.00', taxable: true,
    pricedFrom: 'contract_snapshot', lineTotal: '120.00', overage: null,
  }],
  subtotal: '120.00', taxRate: '0.10000', taxTotal: '12.00', total: '132.00',
  recipients: ['billing@example.com'], blocked: null,
  ...over,
});

async function pinned(tool: string, args: Record<string, unknown>): Promise<string> {
  const outcome = await computeEffectDigestOutcome(tool, args, database);
  if (outcome.kind !== 'pinned') throw new Error(`not pinned: ${JSON.stringify(outcome)}`);
  return outcome.digest;
}

beforeEach(() => {
  h.preview.mockReset();
  h.pushMaterial.mockReset();
});

describe('per-action mandatory pins (QB7)', () => {
  it('generate_invoice, push and push_bulk are mandatory; the tools\' other actions are not', () => {
    expect(requiresPinnedEffectDigest('manage_contracts', { action: 'generate_invoice' })).toBe(true);
    expect(requiresPinnedEffectDigest('manage_accounting_sync', { action: 'push' })).toBe(true);
    expect(requiresPinnedEffectDigest('manage_accounting_sync', { action: 'push_bulk' })).toBe(true);
    // Control: the sibling actions stay usable without a pin.
    expect(requiresPinnedEffectDigest('manage_contracts', { action: 'activate' })).toBe(false);
    expect(requiresPinnedEffectDigest('manage_contracts', { action: 'pause' })).toBe(false);
    expect(requiresPinnedEffectDigest('manage_accounting_sync', { action: 'link_mapping' })).toBe(false);
    // No args (the old call shape) never makes a per-action pin mandatory.
    expect(requiresPinnedEffectDigest('manage_contracts')).toBe(false);
    // Whole-tool entries are unchanged.
    expect(requiresPinnedEffectDigest('ioc_hunt')).toBe(true);
  });

  it('each mandatory pair has its own resolver', () => {
    expect(effectDigestResolverKey('manage_contracts', 'generate_invoice')).toBe('manage_contracts:generate_invoice');
    expect(effectDigestResolverKey('manage_accounting_sync', 'push')).toBe('manage_accounting_sync:push');
    expect(effectDigestResolverKey('manage_accounting_sync', 'push_bulk')).toBe('manage_accounting_sync:push_bulk');
    expect(effectDigestResolverKey('manage_accounting_sync', 'status')).toBeNull();
  });
});

describe('manage_contracts:generate_invoice', () => {
  const args = { action: 'generate_invoice', contractId: CONTRACT };

  it('pins the computed invoice: any drift in a figure the approvers signed is a new digest', async () => {
    h.preview.mockResolvedValue(duePreview());
    const base = await pinned('manage_contracts', args);
    expect(await pinned('manage_contracts', args)).toBe(base);
    for (const drift of [
      { total: '143.00', taxTotal: '13.00', subtotal: '130.00' },
      { autoIssue: false },
      { recipients: ['someone-else@example.com'] },
      { period: { start: '2026-11-01', end: '2026-11-30' } },
      { lines: [{ ...(duePreview() as Extract<InvoicePreview, { due: true }>).lines[0]!, taxable: false }] },
    ] as Array<Partial<Extract<InvoicePreview, { due: true }>>>) {
      h.preview.mockResolvedValueOnce(duePreview(drift));
      expect(await pinned('manage_contracts', args), JSON.stringify(drift)).not.toBe(base);
    }
    // Billed in the meantime: the preview is no longer due, which is different material too.
    h.preview.mockResolvedValueOnce({ due: false, contractId: CONTRACT, orgId: 'org-1', reason: 'not_due', nextBillingAt: '2026-11-01' });
    expect(await pinned('manage_contracts', args)).not.toBe(base);
  });

  it('missing / malformed contractId and an unknown contract never pin', async () => {
    expect(await computeEffectDigestOutcome('manage_contracts', { action: 'generate_invoice' }, database))
      .toEqual({ kind: 'unresolved', reason: 'missing_arg' });
    expect(await computeEffectDigestOutcome('manage_contracts', { action: 'generate_invoice', contractId: 'nope' }, database))
      .toEqual({ kind: 'unresolved', reason: 'target_absent' });
    expect(h.preview).not.toHaveBeenCalled();
    h.preview.mockRejectedValueOnce(new ContractInvoicePreviewNotFound(CONTRACT));
    expect(await computeEffectDigestOutcome('manage_contracts', args, database))
      .toEqual({ kind: 'unresolved', reason: 'target_absent' });
  });

  it('control: activate keeps its own (updatedAt) resolver and never computes a preview', () => {
    expect(effectDigestResolverKey('manage_contracts', 'activate')).toBe('manage_contracts:activate');
  });
});

describe('manage_accounting_sync push / push_bulk', () => {
  it('push pins the push material and the provider', async () => {
    h.pushMaterial.mockResolvedValue({ invoice: { id: INV_A, total: '10.00' } });
    const base = await pinned('manage_accounting_sync', { action: 'push', provider: 'xero', invoiceId: INV_A });
    expect(h.pushMaterial).toHaveBeenCalledWith(database, INV_A, 'xero');
    h.pushMaterial.mockResolvedValueOnce({ invoice: { id: INV_A, total: '11.00' } });
    expect(await pinned('manage_accounting_sync', { action: 'push', provider: 'xero', invoiceId: INV_A })).not.toBe(base);
    h.pushMaterial.mockResolvedValueOnce({ invoice: { id: INV_A, total: '10.00' } });
    expect(await pinned('manage_accounting_sync', { action: 'push', provider: 'quickbooks', invoiceId: INV_A })).not.toBe(base);
  });

  it('push: missing args and an absent invoice never pin', async () => {
    expect(await computeEffectDigestOutcome('manage_accounting_sync', { action: 'push', invoiceId: INV_A }, database))
      .toEqual({ kind: 'unresolved', reason: 'missing_arg' });
    h.pushMaterial.mockResolvedValueOnce(null);
    expect(await computeEffectDigestOutcome('manage_accounting_sync', { action: 'push', provider: 'xero', invoiceId: INV_A }, database))
      .toEqual({ kind: 'unresolved', reason: 'target_absent' });
  });

  it('push_bulk is order independent, pins every invoice, and drifts when any one does', async () => {
    h.pushMaterial.mockImplementation(async (_db: unknown, id: string) => ({ invoice: { id, total: '5.00' } }));
    const base = await pinned('manage_accounting_sync', { action: 'push_bulk', provider: 'xero', invoiceIds: [INV_A, INV_B] });
    expect(await pinned('manage_accounting_sync', { action: 'push_bulk', provider: 'xero', invoiceIds: [INV_B, INV_A, INV_A] })).toBe(base);
    h.pushMaterial.mockImplementation(async (_db: unknown, id: string) => ({ invoice: { id, total: id === INV_B ? '6.00' : '5.00' } }));
    expect(await pinned('manage_accounting_sync', { action: 'push_bulk', provider: 'xero', invoiceIds: [INV_A, INV_B] })).not.toBe(base);
  });

  it('push_bulk with no resolvable invoice never pins', async () => {
    h.pushMaterial.mockResolvedValue(null);
    expect(await computeEffectDigestOutcome('manage_accounting_sync', { action: 'push_bulk', provider: 'xero', invoiceIds: [INV_A] }, database))
      .toEqual({ kind: 'unresolved', reason: 'target_absent' });
    expect(await computeEffectDigestOutcome('manage_accounting_sync', { action: 'push_bulk', provider: 'xero', invoiceIds: [] }, database))
      .toEqual({ kind: 'unresolved', reason: 'missing_arg' });
  });
});
