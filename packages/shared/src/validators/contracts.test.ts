import { describe, it, expect } from 'vitest';
import { createContractSchema, contractLineInputSchema, updateContractSchema, changeContractCurrencySchema } from './contracts';

describe('createContractSchema', () => {
  it('accepts a valid monthly advance contract', () => {
    const r = createContractSchema.safeParse({
      orgId: '11111111-1111-1111-1111-111111111111',
      name: 'Acme MSP', billingTiming: 'advance', intervalMonths: 1, startDate: '2026-07-01', autoIssue: false
    });
    expect(r.success).toBe(true);
  });
  it('rejects intervalMonths < 1', () => {
    const r = createContractSchema.safeParse({
      orgId: '11111111-1111-1111-1111-111111111111', name: 'x', billingTiming: 'advance', intervalMonths: 0, startDate: '2026-07-01'
    });
    expect(r.success).toBe(false);
  });
  it('rejects endDate before startDate', () => {
    const r = createContractSchema.safeParse({
      orgId: '11111111-1111-1111-1111-111111111111', name: 'x', billingTiming: 'advance',
      intervalMonths: 1, startDate: '2026-07-01', endDate: '2026-06-01'
    });
    expect(r.success).toBe(false);
  });
  // Regression: the web create form sends `endDate || null` and `notes.trim() || null`
  // for the common open-ended/no-notes case. The schema must accept null, not only undefined.
  it('accepts null endDate/notes (the open-ended UI payload)', () => {
    const r = createContractSchema.safeParse({
      orgId: '11111111-1111-1111-1111-111111111111', name: 'Acme MSP', billingTiming: 'advance',
      intervalMonths: 1, startDate: '2026-07-01', endDate: null, autoIssue: false, notes: null
    });
    expect(r.success).toBe(true);
  });
});

describe('auto-renew fields', () => {
  const base = {
    orgId: '11111111-1111-1111-1111-111111111111',
    name: 'Acme', billingTiming: 'advance' as const, intervalMonths: 1, startDate: '2026-07-01'
  };
  it('accepts a fixed-term auto-renew contract', () => {
    const r = createContractSchema.safeParse({
      ...base, endDate: '2027-07-01', autoRenew: true, renewalTermMonths: 12, renewalNoticeDays: 30
    });
    expect(r.success).toBe(true);
  });
  it('rejects autoRenew without an endDate (cannot renew an indefinite contract)', () => {
    const r = createContractSchema.safeParse({ ...base, autoRenew: true, renewalTermMonths: 12 });
    expect(r.success).toBe(false);
  });
  it('rejects autoRenew without a renewalTermMonths', () => {
    const r = createContractSchema.safeParse({ ...base, endDate: '2027-07-01', autoRenew: true });
    expect(r.success).toBe(false);
  });
  it('rejects renewalTermMonths < 1', () => {
    const r = createContractSchema.safeParse({
      ...base, endDate: '2027-07-01', autoRenew: true, renewalTermMonths: 0
    });
    expect(r.success).toBe(false);
  });
  it('allows clearing auto-renew on update', () => {
    expect(updateContractSchema.safeParse({ autoRenew: false }).success).toBe(true);
  });
});

describe('contractLineInputSchema', () => {
  it('requires manualQuantity for manual lines', () => {
    expect(contractLineInputSchema.safeParse({
      lineType: 'manual', description: 'licenses', unitPrice: '10.00', taxable: false
    }).success).toBe(false);
    expect(contractLineInputSchema.safeParse({
      lineType: 'manual', description: 'licenses', unitPrice: '10.00', taxable: false, manualQuantity: '3'
    }).success).toBe(true);
  });
  it('allows siteId only as an optional uuid on per_device lines', () => {
    expect(contractLineInputSchema.safeParse({
      lineType: 'per_device', description: 'RMM', unitPrice: '15.00', taxable: true,
      siteId: '22222222-2222-2222-2222-222222222222'
    }).success).toBe(true);
  });
  it('accepts a flat line with no quantity fields', () => {
    expect(contractLineInputSchema.safeParse({
      lineType: 'flat', description: 'Managed services', unitPrice: '500.00', taxable: false
    }).success).toBe(true);
  });
});

// Multi-currency wave 3 (#3775): a catalog-sourced contract line is priced by
// the server-side resolver, so the client supplies no unitPrice; non-catalog
// lines still carry their own price.
describe('contractLineInputSchema — catalog lines omit unitPrice', () => {
  it('accepts a flat catalog line without unitPrice', () => {
    expect(contractLineInputSchema.safeParse({
      lineType: 'flat', description: 'Managed services', taxable: true,
      catalogItemId: '33333333-3333-3333-3333-333333333333'
    }).success).toBe(true);
  });
  it('rejects a flat line with neither unitPrice nor catalogItemId', () => {
    const r = contractLineInputSchema.safeParse({
      lineType: 'flat', description: 'Managed services', taxable: false
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const issue = r.error.issues.find((i) => i.path.join('.') === 'unitPrice');
      expect(issue?.message).toBe('unitPrice is required unless catalogItemId is set');
    }
  });
  it('still accepts a non-catalog line carrying unitPrice', () => {
    expect(contractLineInputSchema.safeParse({
      lineType: 'per_seat', description: 'Seats', unitPrice: '12.00', taxable: true
    }).success).toBe(true);
  });
});

// Post-merge review #1: the editor omits `taxable` for a catalog line (the
// server resolves it from the item, ignoring any client value) and JSON drops
// the undefined key — so the schema must not require it there. Non-catalog
// lines still stamp the client's taxable verbatim, so it stays required.
describe('contractLineInputSchema — catalog lines omit taxable', () => {
  it('accepts a catalog line with neither unitPrice nor taxable (the editor payload)', () => {
    expect(contractLineInputSchema.safeParse({
      lineType: 'flat', description: 'Managed services',
      catalogItemId: '33333333-3333-3333-3333-333333333333'
    }).success).toBe(true);
  });
  it('rejects a non-catalog line without taxable', () => {
    const r = contractLineInputSchema.safeParse({
      lineType: 'flat', description: 'Managed services', unitPrice: '500.00'
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const issue = r.error.issues.find((i) => i.path.join('.') === 'taxable');
      expect(issue?.message).toBe('taxable is required unless catalogItemId is set');
    }
  });
});

// #3205: a per_device_role line bills a SET of device roles. deviceRoles is
// required on that type and forbidden on every other, mirrors the DB CHECK,
// never contains 'unknown' (a classification gap, not a rate) or duplicates.
describe('contractLineInputSchema — per_device_role (#3205)', () => {
  const base = { description: 'Network gear', unitPrice: '25.00', taxable: true };
  const parse = (v: unknown) => contractLineInputSchema.safeParse(v).success;

  it('requires a non-empty deviceRoles array on per_device_role', () => {
    expect(parse({ ...base, lineType: 'per_device_role' })).toBe(false);
    expect(parse({ ...base, lineType: 'per_device_role', deviceRoles: [] })).toBe(false);
    expect(parse({ ...base, lineType: 'per_device_role', deviceRoles: ['switch', 'router', 'firewall'] })).toBe(true);
  });

  it('rejects deviceRoles on every other line type', () => {
    for (const lineType of ['flat', 'per_device', 'per_seat'] as const) {
      expect(parse({ ...base, lineType, deviceRoles: ['server'] })).toBe(false);
    }
    expect(parse({ ...base, lineType: 'manual', manualQuantity: '2', deviceRoles: ['server'] })).toBe(false);
  });

  it('rejects unknown and unrecognised roles', () => {
    expect(parse({ ...base, lineType: 'per_device_role', deviceRoles: ['unknown'] })).toBe(false);
    expect(parse({ ...base, lineType: 'per_device_role', deviceRoles: ['server', 'mainframe'] })).toBe(false);
  });

  it('rejects duplicate roles', () => {
    expect(parse({ ...base, lineType: 'per_device_role', deviceRoles: ['server', 'server'] })).toBe(false);
  });

  it('accepts siteId on per_device_role and still rejects it on flat / per_seat / manual', () => {
    const siteId = '22222222-2222-2222-2222-222222222222';
    expect(parse({ ...base, lineType: 'per_device_role', deviceRoles: ['workstation'], siteId })).toBe(true);
    expect(parse({ ...base, lineType: 'flat', siteId })).toBe(false);
    expect(parse({ ...base, lineType: 'per_seat', siteId })).toBe(false);
    expect(parse({ ...base, lineType: 'manual', manualQuantity: '1', siteId })).toBe(false);
  });
});

describe('changeContractCurrencySchema (#3778)', () => {
  it('defaults confirmActiveChange to false — an ACTIVE restamp is never implicit', () => {
    const parsed = changeContractCurrencySchema.parse({ currencyCode: 'eur' });
    expect(parsed).toEqual({ currencyCode: 'EUR', clearLines: false, reprice: false, confirmActiveChange: false });
  });

  it('accepts confirmActiveChange alongside clearLines', () => {
    expect(changeContractCurrencySchema.parse({ currencyCode: 'EUR', clearLines: true, confirmActiveChange: true }))
      .toMatchObject({ clearLines: true, confirmActiveChange: true });
  });

  it('keeps clearLines and reprice mutually exclusive', () => {
    expect(changeContractCurrencySchema.safeParse({ currencyCode: 'EUR', clearLines: true, reprice: true }).success).toBe(false);
  });

  it('is strict — a mis-keyed field is a parse error, never a silent default', () => {
    expect(changeContractCurrencySchema.safeParse({ currencyCode: 'EUR', convert: true }).success).toBe(false);
    expect(changeContractCurrencySchema.safeParse({ currencyCode: 'EUR', confirmActive: true }).success).toBe(false);
  });

  it('rejects an unsupported currency code', () => {
    expect(changeContractCurrencySchema.safeParse({ currencyCode: 'XXX' }).success).toBe(false);
  });
});
