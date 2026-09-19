import { describe, expect, it, vi, beforeEach } from 'vitest';

const queue: unknown[][] = [];
function queueResult(rows: unknown[]) { queue.push(rows); }

// Tracks whether each db.select() call happened INSIDE the mocked
// readWithPartnerAxisVisibility wrapper, so the "org read is not wrapped,
// partner read is" claim is actually verified per-call, not just counted.
let insideWrapper = false;
const wrapperFlagPerCall: boolean[] = [];

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => {
      wrapperFlagPerCall.push(insideWrapper);
      return { from: () => ({ where: () => ({ limit: () => Promise.resolve(queue.shift() ?? []) }) }) };
    }),
  },
}));
vi.mock('../db/partnerAxisRead', () => ({
  readWithPartnerAxisVisibility: vi.fn(async (fn: () => unknown) => {
    insideWrapper = true;
    try { return await fn(); } finally { insideWrapper = false; }
  }),
}));

import { resolveOrgTaxRate, OrgNotVisibleForTaxError } from './taxRateResolver';
import { readWithPartnerAxisVisibility } from '../db/partnerAxisRead';

const ORG_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const PARTNER_ID = 'bbbbbbbb-2222-4222-8222-222222222222';

beforeEach(() => {
  queue.length = 0;
  wrapperFlagPerCall.length = 0;
  insideWrapper = false;
  vi.clearAllMocks();
});

describe('resolveOrgTaxRate', () => {
  it('returns the org rate when the org has one, ignoring the partner default', async () => {
    queueResult([{ taxExempt: false, taxRate: '0.08000' }]); // org
    queueResult([{ defaultTaxRate: '0.05000' }]); // partner
    const rate = await resolveOrgTaxRate({ orgId: ORG_ID, partnerId: PARTNER_ID });
    expect(rate).toBe('0.08000');
  });

  it('falls back to the partner default when the org has no rate', async () => {
    queueResult([{ taxExempt: false, taxRate: null }]);
    queueResult([{ defaultTaxRate: '0.06000' }]);
    const rate = await resolveOrgTaxRate({ orgId: ORG_ID, partnerId: PARTNER_ID });
    expect(rate).toBe('0.06000');
  });

  it('returns null (not "0.00000") when neither level has a rate', async () => {
    queueResult([{ taxExempt: false, taxRate: null }]);
    queueResult([{ defaultTaxRate: null }]);
    const rate = await resolveOrgTaxRate({ orgId: ORG_ID, partnerId: PARTNER_ID });
    expect(rate).toBeNull();
  });

  it('a tax-exempt org returns null regardless of any configured rate', async () => {
    queueResult([{ taxExempt: true, taxRate: '0.08000' }]);
    queueResult([{ defaultTaxRate: '0.05000' }]);
    const rate = await resolveOrgTaxRate({ orgId: ORG_ID, partnerId: PARTNER_ID });
    expect(rate).toBeNull();
  });

  it('FAILS CLOSED: throws OrgNotVisibleForTaxError when the org row is not visible, and never reads the partner rate', async () => {
    queueResult([]); // org read returns nothing — not visible in the ambient context
    await expect(resolveOrgTaxRate({ orgId: ORG_ID, partnerId: PARTNER_ID })).rejects.toThrow(OrgNotVisibleForTaxError);
    // The partner read must never have been queued/consumed — only one
    // db.select() call happened (the org read), proving the function returned
    // before attempting readWithPartnerAxisVisibility at all.
    expect(readWithPartnerAxisVisibility).not.toHaveBeenCalled();
    expect(wrapperFlagPerCall).toEqual([false]);
  });

  it('reads the partner row through readWithPartnerAxisVisibility ONLY — the org read runs outside it', async () => {
    queueResult([{ taxExempt: false, taxRate: null }]); // org — call 1
    queueResult([{ defaultTaxRate: null }]); // partner — call 2
    await resolveOrgTaxRate({ orgId: ORG_ID, partnerId: PARTNER_ID });
    expect(readWithPartnerAxisVisibility).toHaveBeenCalledTimes(1);
    // Per-call proof: the FIRST db.select() (org) happened with insideWrapper
    // false, the SECOND (partner) happened with insideWrapper true. A prior
    // version of this test only asserted the call COUNT, which would also
    // pass if both reads were wrapped — this asserts the SHAPE.
    expect(wrapperFlagPerCall).toEqual([false, true]);
  });
});
