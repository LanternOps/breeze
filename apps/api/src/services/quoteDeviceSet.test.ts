/**
 * #3205 W05: ONE snapshot for the whole set, PER-LINE degradation.
 *
 * The promise this file exists to keep: a quote can price four groups, and one
 * broken filter must mark ONE line, not four. That is only possible because
 * buildOrgDeviceSnapshot RETURNS its failures instead of throwing them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { buildOrgDeviceSnapshot, countContractSeats } = vi.hoisted(() => ({
  buildOrgDeviceSnapshot: vi.fn(),
  countContractSeats: vi.fn(),
}));
vi.mock('./contractSnapshot', () => ({ buildOrgDeviceSnapshot }));
vi.mock('./contractQuantities', () => ({ countContractSeats }));

import { countQuoteDeviceSetLines, type QuoteDeviceSetLine } from './quoteDeviceSet';
import { GroupEvaluationError } from './groupMembership';

const ORG = 'org-1';
const A = 'site-a';
const line = (p: Partial<QuoteDeviceSetLine> & Pick<QuoteDeviceSetLine, 'id' | 'contractLineType'>): QuoteDeviceSetLine => ({
  description: p.id, deviceRoles: null, deviceGroupId: null, deviceGroupName: null,
  siteId: null, siteName: null, includedQuantity: null, overageMode: null, overageUnitPrice: null, ...p,
});

const devices = [
  { id: 'd1', role: 'server', siteId: A },
  { id: 'd2', role: 'server', siteId: 'site-b' },
  { id: 'd3', role: 'workstation', siteId: A },
];

beforeEach(() => {
  vi.clearAllMocks();
  buildOrgDeviceSnapshot.mockResolvedValue({
    snapshot: { devices, groups: new Map([['g-ok', { siteId: null, memberIds: new Set(['d1', 'd3']) }]]) },
    groupErrors: new Map(),
  });
  countContractSeats.mockResolvedValue(7);
});

describe('countQuoteDeviceSetLines', () => {
  it('builds exactly ONE snapshot for many lines, and passes every named group id', async () => {
    await countQuoteDeviceSetLines(ORG, [
      line({ id: 'l1', contractLineType: 'per_device' }),
      line({ id: 'l2', contractLineType: 'per_device_role', deviceRoles: ['server'] }),
      line({ id: 'l3', contractLineType: 'per_device_group', deviceGroupId: 'g-ok', deviceGroupName: 'VIP' }),
    ]);
    expect(buildOrgDeviceSnapshot).toHaveBeenCalledTimes(1);
    expect(buildOrgDeviceSnapshot).toHaveBeenCalledWith(ORG, ['g-ok']);
  });

  it('counts each type from the shared snapshot; per_seat never touches it', async () => {
    const out = await countQuoteDeviceSetLines(ORG, [
      line({ id: 'l1', contractLineType: 'per_device' }),
      line({ id: 'l2', contractLineType: 'per_device', siteId: A, siteName: 'Dallas' }),
      line({ id: 'l3', contractLineType: 'per_device_role', deviceRoles: ['server'] }),
      line({ id: 'l4', contractLineType: 'per_device_group', deviceGroupId: 'g-ok', deviceGroupName: 'VIP' }),
      line({ id: 'l5', contractLineType: 'per_seat' }),
    ]);
    expect(out.map((c) => [c.lineId, c.counted, c.billed])).toEqual([
      ['l1', 3, 3], ['l2', 2, 2], ['l3', 2, 2], ['l4', 2, 2], ['l5', 7, 7],
    ]);
    expect(countContractSeats).toHaveBeenCalledWith(ORG);
  });

  // The degradation promise, stated as a test.
  it('a failed group marks ONLY its own lines and leaves the others counted', async () => {
    buildOrgDeviceSnapshot.mockResolvedValueOnce({
      snapshot: { devices, groups: new Map([['g-ok', { siteId: null, memberIds: new Set(['d1']) }]]) },
      groupErrors: new Map([['g-bad', new GroupEvaluationError('g-bad', 'invalid_filter')]]),
    });
    const out = await countQuoteDeviceSetLines(ORG, [
      line({ id: 'l1', contractLineType: 'per_device' }),
      line({ id: 'l2', contractLineType: 'per_device_group', deviceGroupId: 'g-bad', deviceGroupName: 'Broken' }),
      line({ id: 'l3', contractLineType: 'per_device_group', deviceGroupId: 'g-ok', deviceGroupName: 'VIP' }),
    ]);
    expect(out[0]).toMatchObject({ lineId: 'l1', counted: 3, error: undefined });
    expect(out[1]).toMatchObject({ lineId: 'l2', error: 'GROUP_EVALUATION_FAILED' });
    expect(out[2]).toMatchObject({ lineId: 'l3', counted: 1, error: undefined });
  });

  // NEVER silently zeroed: a zero here would be persisted as an authoritative
  // count, which is the exact silent failure this wave removes.
  it('an orphaned group or site yields an error and no number', async () => {
    const out = await countQuoteDeviceSetLines(ORG, [
      line({ id: 'l1', contractLineType: 'per_device_group', deviceGroupId: null, deviceGroupName: 'Gone' }),
      line({ id: 'l2', contractLineType: 'per_device', siteId: null, siteName: 'Dallas' }),
    ]);
    expect(out[0]).toMatchObject({ lineId: 'l1', error: 'GROUP_DELETED', counted: 0, billed: 0 });
    expect(out[1]).toMatchObject({ lineId: 'l2', error: 'SITE_DELETED', counted: 0, billed: 0 });
  });

  // W04's boundary rows, proven on the quote side: with an allowance the base
  // bills the ALLOWANCE every period, whether the count reaches it or not.
  it.each([[0, 25, 0], [24, 25, 0], [25, 25, 0], [26, 25, 1]])(
    'applies the fixed allowance at counted %i', async (counted, billed, overage) => {
      buildOrgDeviceSnapshot.mockResolvedValueOnce({
        snapshot: { devices: Array.from({ length: counted }, (_, i) => ({ id: `x${i}`, role: 'server', siteId: A })), groups: new Map() },
        groupErrors: new Map(),
      });
      const [c] = await countQuoteDeviceSetLines(ORG, [
        line({ id: 'l1', contractLineType: 'per_device', includedQuantity: '25.00', overageMode: 'bill', overageUnitPrice: '12.00' }),
      ]);
      expect(c).toMatchObject({ counted, billed, included: 25, overage, overageMode: 'bill' });
    });
});
