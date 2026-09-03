/**
 * #3205 W05: the quote-line writers. The quantity is DERIVED, never accepted
 * from the client, and a line whose number cannot be computed is refused rather
 * than created at zero.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { countQuoteDeviceSetLines } = vi.hoisted(() => ({ countQuoteDeviceSetLines: vi.fn() }));
vi.mock('./quoteDeviceSet', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./quoteDeviceSet')>()),
  countQuoteDeviceSetLines,
}));

const results: unknown[][] = [];
const inserts: Array<{ table: unknown; values: Record<string, unknown> }> = [];
const updates: Array<{ table: unknown; values: Record<string, unknown> }> = [];
const wheres: unknown[][] = [];

vi.mock('../db', () => {
  const chain: Record<string, unknown> = {};
  let insertTable: unknown;
  let updateTable: unknown;
  const passthrough = ['select', 'from', 'limit', 'orderBy', 'returning', 'delete', 'for', 'innerJoin', 'leftJoin', 'execute'];
  for (const method of passthrough) chain[method] = vi.fn(() => chain);
  chain.where = vi.fn((...args: unknown[]) => { wheres.push(args); return chain; });
  chain.insert = vi.fn((table: unknown) => { insertTable = table; return chain; });
  chain.values = vi.fn((values: Record<string, unknown>) => {
    inserts.push({ table: insertTable, values });
    return chain;
  });
  chain.update = vi.fn((table: unknown) => { updateTable = table; return chain; });
  chain.set = vi.fn((values: Record<string, unknown>) => {
    updates.push({ table: updateTable, values });
    return chain;
  });
  chain.transaction = vi.fn(async (run: (tx: unknown) => unknown) => run(chain));
  (chain as { then: unknown }).then = (resolve: (value: unknown) => unknown) =>
    Promise.resolve(results.shift() ?? []).then(resolve);
  return {
    db: chain,
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
  };
});

import { addManualLine, refreshQuoteDeviceCounts, updateLine } from './quoteService';
import { quoteLines } from '../db/schema/quotes';

const QUOTE = '11111111-1111-4111-8111-111111111111';
const GROUP = '33333333-3333-4333-8333-333333333333';
const SITE = '22222222-2222-4222-8222-222222222222';
const ACTOR = { userId: 'u1', partnerId: 'p1', accessibleOrgIds: null };

function queueResult(rows: unknown[]): void { results.push(rows); }
function queueDraftQuote(overrides: Record<string, unknown>): void {
  queueResult([{ partnerId: 'p1', status: 'draft', siteId: null, ...overrides }]);
}
function queueNonDraftQuote(overrides: Record<string, unknown>): void {
  queueResult([{ partnerId: 'p1', status: 'sent', siteId: null, currencyCode: 'USD', orgId: 'org1', ...overrides }]);
}
function lastInsertValues(): Record<string, unknown> {
  return inserts.at(-1)?.values ?? {};
}
function lineUpdates(): Array<{ table: unknown; values: Record<string, unknown> }> {
  return updates.filter((call) => call.table === quoteLines);
}
function lastUpdateValues(): Record<string, unknown> {
  return lineUpdates().at(-1)?.values ?? {};
}
function containsValue(value: unknown, needle: string, seen = new Set<unknown>()): boolean {
  if (value === needle) return true;
  if (!value || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  return Object.values(value as Record<string, unknown>).some((part) => containsValue(part, needle, seen));
}
function updateCallsFor(lineId: string): unknown[][] {
  return wheres.filter((args) => containsValue(args, lineId));
}

beforeEach(() => {
  results.length = 0;
  inserts.length = 0;
  updates.length = 0;
  wheres.length = 0;
  vi.clearAllMocks();
  countQuoteDeviceSetLines.mockResolvedValue([
    { lineId: 'new', counted: 3, billed: 3, included: null, overage: 0, overageMode: null },
  ]);
});

describe('addManualLine with a device set', () => {
  it('stamps device_group_name and site_name and stores the DERIVED quantity', async () => {
    queueDraftQuote({ id: QUOTE, orgId: 'org1', currencyCode: 'USD' });
    queueResult([{ id: GROUP, name: 'VIP Laptops', type: 'static', siteId: null }]);
    queueResult([{ id: 'line-1' }]);
    await addManualLine(QUOTE, {
      sourceType: 'manual', name: 'VIP', unitPrice: 40, taxable: true, recurrence: 'monthly',
      contractLineType: 'per_device_group', deviceGroupId: GROUP,
    } as never, ACTOR);
    expect(lastInsertValues()).toMatchObject({
      contractLineType: 'per_device_group', deviceGroupId: GROUP, deviceGroupName: 'VIP Laptops',
      quantity: '3.00', lineTotal: '120.00',
    });
  });

  // THE MOST IMPORTANT ROW IN THIS SUITE. Quoting a brand-new customer with no
  // devices enrolled yet is the single most common case; refusing the line would
  // make the feature useless for new-customer proposals.
  it('stores 0 for an org with no matching devices', async () => {
    countQuoteDeviceSetLines.mockResolvedValueOnce([
      { lineId: 'new', counted: 0, billed: 0, included: null, overage: 0, overageMode: null },
    ]);
    queueDraftQuote({ id: QUOTE, orgId: 'org1', currencyCode: 'USD' });
    queueResult([{ id: 'line-1' }]);
    await addManualLine(QUOTE, {
      sourceType: 'manual', name: 'Servers', unitPrice: 40, taxable: true, recurrence: 'monthly',
      contractLineType: 'per_device_role', deviceRoles: ['server'],
    } as never, ACTOR);
    expect(lastInsertValues()).toMatchObject({ quantity: '0.00', lineTotal: '0.00' });
  });

  it('400s for a group from another org', async () => {
    queueDraftQuote({ id: QUOTE, orgId: 'org1', currencyCode: 'USD' });
    queueResult([]);
    await expect(addManualLine(QUOTE, {
      sourceType: 'manual', name: 'x', unitPrice: 1, taxable: false, recurrence: 'monthly',
      contractLineType: 'per_device_group', deviceGroupId: GROUP,
    } as never, ACTOR)).rejects.toMatchObject({ status: 400, code: 'GROUP_NOT_IN_ORG' });
  });

  it('400s DEVICE_SET_UNCOUNTABLE when the count fails, rather than creating a zero line', async () => {
    countQuoteDeviceSetLines.mockResolvedValueOnce([
      { lineId: 'new', counted: 0, billed: 0, included: null, overage: 0, overageMode: null, error: 'GROUP_EVALUATION_FAILED' },
    ]);
    queueDraftQuote({ id: QUOTE, orgId: 'org1', currencyCode: 'USD' });
    queueResult([{ id: GROUP, name: 'Broken', type: 'dynamic', siteId: null }]);
    await expect(addManualLine(QUOTE, {
      sourceType: 'manual', name: 'x', unitPrice: 1, taxable: false, recurrence: 'monthly',
      contractLineType: 'per_device_group', deviceGroupId: GROUP,
    } as never, ACTOR)).rejects.toMatchObject({
      status: 400, code: 'DEVICE_SET_UNCOUNTABLE', meta: { groupName: 'Broken' },
    });
  });

  it('representability-checks overageUnitPrice in the quote currency', async () => {
    queueDraftQuote({ id: QUOTE, orgId: 'org1', currencyCode: 'JPY' });
    await expect(addManualLine(QUOTE, {
      sourceType: 'manual', name: 'x', unitPrice: 40, taxable: false, recurrence: 'monthly',
      contractLineType: 'per_device', includedQuantity: 25, overageMode: 'bill', overageUnitPrice: 12.5,
    } as never, ACTOR)).rejects.toMatchObject({ status: 400, code: 'PRICE_NOT_REPRESENTABLE' });
  });
});

describe('updateLine on a device-set line', () => {
  const stored = {
    id: 'line-1', quoteId: QUOTE, quantity: '3.00', unitPrice: '40.00', recurrence: 'monthly', parentLineId: null,
    contractLineType: 'per_device_role', deviceRoles: ['server'], deviceGroupId: null, deviceGroupName: null,
    siteId: null, siteName: null, includedQuantity: null, overageMode: null, overageUnitPrice: null,
  };

  it('re-derives the quantity when the descriptor changes', async () => {
    countQuoteDeviceSetLines.mockResolvedValueOnce([
      { lineId: 'line-1', counted: 9, billed: 9, included: null, overage: 0, overageMode: null },
    ]);
    queueDraftQuote({ id: QUOTE, orgId: 'org1', currencyCode: 'USD' });
    queueResult([stored]);
    queueResult([{ id: 'line-1' }]);
    await updateLine(QUOTE, 'line-1', { deviceRoles: ['server', 'workstation'] } as never, ACTOR);
    expect(lastUpdateValues()).toMatchObject({
      quantity: '9.00', lineTotal: '360.00', deviceRoles: ['server', 'workstation'],
    });
  });

  it('400s on a client-supplied quantity for a device-set line', async () => {
    queueDraftQuote({ id: QUOTE, orgId: 'org1', currencyCode: 'USD' });
    queueResult([stored]);
    await expect(updateLine(QUOTE, 'line-1', { quantity: 12 } as never, ACTOR))
      .rejects.toMatchObject({ status: 400, code: 'INVALID_LINE_PATCH' });
  });

  it('400s on recurrence: one_time for a device-set line, before the CHECK can 500', async () => {
    queueDraftQuote({ id: QUOTE, orgId: 'org1', currencyCode: 'USD' });
    queueResult([stored]);
    await expect(updateLine(QUOTE, 'line-1', { recurrence: 'one_time' } as never, ACTOR))
      .rejects.toMatchObject({ status: 400, code: 'INVALID_LINE_PATCH' });
  });

  it('re-stamps the group name when deviceGroupId changes', async () => {
    countQuoteDeviceSetLines.mockResolvedValueOnce([
      { lineId: 'line-1', counted: 2, billed: 2, included: null, overage: 0, overageMode: null },
    ]);
    queueDraftQuote({ id: QUOTE, orgId: 'org1', currencyCode: 'USD' });
    queueResult([{ ...stored, contractLineType: 'per_device_group', deviceRoles: null, deviceGroupId: GROUP, deviceGroupName: 'Old' }]);
    queueResult([{ id: 'g2', name: 'New Group', type: 'static', siteId: null }]);
    queueResult([{ id: 'line-1' }]);
    await updateLine(QUOTE, 'line-1', { deviceGroupId: 'g2' } as never, ACTOR);
    expect(lastUpdateValues()).toMatchObject({ deviceGroupId: 'g2', deviceGroupName: 'New Group' });
  });

  it('clearing siteId clears the stamp and re-derives org-wide', async () => {
    countQuoteDeviceSetLines.mockResolvedValueOnce([
      { lineId: 'line-1', counted: 11, billed: 11, included: null, overage: 0, overageMode: null },
    ]);
    queueDraftQuote({ id: QUOTE, orgId: 'org1', currencyCode: 'USD' });
    queueResult([{ ...stored, contractLineType: 'per_device', deviceRoles: null, siteId: SITE, siteName: 'Dallas' }]);
    queueResult([{ id: 'line-1' }]);
    await updateLine(QUOTE, 'line-1', { siteId: null } as never, ACTOR);
    expect(lastUpdateValues()).toMatchObject({ siteId: null, siteName: null, quantity: '11.00' });
  });

  it('leaves an ordinary line completely alone', async () => {
    queueDraftQuote({ id: QUOTE, orgId: 'org1', currencyCode: 'USD' });
    queueResult([{ ...stored, contractLineType: null, deviceRoles: null }]);
    queueResult([{ id: 'line-1' }]);
    await updateLine(QUOTE, 'line-1', { quantity: 12 } as never, ACTOR);
    expect(countQuoteDeviceSetLines).not.toHaveBeenCalled();
    expect(lastUpdateValues()).toMatchObject({ quantity: '12' });
  });

  it.each([
    ['deviceRoles', ['server']],
    ['deviceGroupId', GROUP],
    ['siteId', SITE],
    ['includedQuantity', 25],
    ['overageMode', 'flag'],
    ['overageUnitPrice', 12],
  ])('400s when %s is patched onto an ordinary line', async (key, value) => {
    queueDraftQuote({ id: QUOTE, orgId: 'org1', currencyCode: 'USD' });
    queueResult([{ ...stored, contractLineType: null, deviceRoles: null }]);
    await expect(updateLine(QUOTE, 'line-1', { [key]: value } as never, ACTOR))
      .rejects.toMatchObject({
        status: 400,
        code: 'INVALID_LINE_PATCH',
        meta: { issues: [{ path: key }] },
      });
  });
});

describe('refreshQuoteDeviceCounts', () => {
  it('is refused on a non-draft quote', async () => {
    queueNonDraftQuote({ id: QUOTE, status: 'sent' });
    await expect(refreshQuoteDeviceCounts(QUOTE, ACTOR))
      .rejects.toMatchObject({ status: 409, code: 'INVALID_STATE' });
  });

  it('updates quantities and line totals and returns the per-line results', async () => {
    countQuoteDeviceSetLines.mockResolvedValueOnce([
      { lineId: 'l1', counted: 5, billed: 5, included: null, overage: 0, overageMode: null },
      { lineId: 'l2', counted: 0, billed: 0, included: null, overage: 0, overageMode: null, error: 'GROUP_DELETED' },
    ]);
    queueDraftQuote({ id: QUOTE, orgId: 'org1', currencyCode: 'USD' });
    queueResult([
      { id: 'l1', contractLineType: 'per_device', unitPrice: '40.00', quantity: '3.00', deviceGroupId: null, deviceGroupName: null, siteId: null, siteName: null, deviceRoles: null, includedQuantity: null, overageMode: null, overageUnitPrice: null, name: 'A', description: null },
      { id: 'l2', contractLineType: 'per_device_group', unitPrice: '10.00', quantity: '7.00', deviceGroupId: null, deviceGroupName: 'Gone', siteId: null, siteName: null, deviceRoles: null, includedQuantity: null, overageMode: null, overageUnitPrice: null, name: 'B', description: null },
    ]);
    const out = await refreshQuoteDeviceCounts(QUOTE, ACTOR);
    expect(out).toHaveLength(2);
    expect(updateCallsFor('l2')).toHaveLength(0);
    expect(lastUpdateValues()).toMatchObject({ quantity: '5.00', lineTotal: '200.00' });
  });
});
