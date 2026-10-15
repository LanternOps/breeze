import { describe, it, expect } from 'vitest';
import {
  CONTRACT_LINE_TYPES, ALLOWANCE_LINE_TYPES, HOUR_BLOCK_LINE_TYPE, ROLLOVER_POLICIES,
  contractLineInputSchema, updateContractLineSchema, contractLineInvariantIssues, mergeContractLinePatch,
  type ContractLineShape, type PersistedContractLine,
} from './contracts';

const GUID = '11111111-1111-4111-8111-111111111111';

const VALID = {
  lineType: 'hour_block', description: 'Support block', unitPrice: '1000.00', taxable: false,
  includedQuantity: '10', overageMode: 'bill', overageUnitPrice: '150.00', rolloverPolicy: 'none',
} as const;

describe('hour_block — type registration (#4547 W03)', () => {
  it('is a contract line type and an allowance type, and matches the W01 constant', () => {
    expect(HOUR_BLOCK_LINE_TYPE).toBe('hour_block');
    expect(CONTRACT_LINE_TYPES).toContain('hour_block');
    expect(ALLOWANCE_LINE_TYPES).toContain('hour_block');
    expect([...ROLLOVER_POLICIES]).toEqual(['none', 'carry_forward']);
  });
});

describe('contractLineInputSchema — hour_block', () => {
  it('accepts the minimal valid block', () => {
    expect(contractLineInputSchema.safeParse(VALID).success).toBe(true);
  });

  it('accepts fractional hours (the integrality rule is exempt) while a device allowance stays whole', () => {
    expect(contractLineInputSchema.safeParse({ ...VALID, includedQuantity: '7.50' }).success).toBe(true);
    const device = contractLineInputSchema.safeParse({
      lineType: 'per_device', description: 'x', unitPrice: '1.00', taxable: false,
      includedQuantity: '7.5', overageMode: 'bill', overageUnitPrice: '2.00',
    });
    expect(device.success).toBe(false);
  });

  it('accepts carry_forward with a cap and an alert percentage', () => {
    const r = contractLineInputSchema.safeParse({ ...VALID, rolloverPolicy: 'carry_forward', rolloverCapHours: '5', hourBlockAlertPct: 80 });
    expect(r.success).toBe(true);
  });

  const REJECTED: Array<[string, Record<string, unknown>, string]> = [
    ['no included hours', { includedQuantity: undefined, overageMode: undefined, overageUnitPrice: undefined }, 'includedQuantity'],
    ['zero included hours', { includedQuantity: '0' }, 'includedQuantity'],
    ["overageMode 'flag'", { overageMode: 'flag', overageUnitPrice: undefined }, 'overageMode'],
    ['no overage mode', { overageMode: undefined, overageUnitPrice: undefined }, 'overageMode'],
    ['no overage price', { overageUnitPrice: undefined }, 'overageUnitPrice'],
    ['no rollover policy', { rolloverPolicy: undefined }, 'rolloverPolicy'],
    ['a cap under rollover none', { rolloverPolicy: 'none', rolloverCapHours: '5' }, 'rolloverCapHours'],
    ['a zero cap under carry_forward', { rolloverPolicy: 'carry_forward', rolloverCapHours: '0' }, 'rolloverCapHours'],
    ['alert 0', { hourBlockAlertPct: 0 }, 'hourBlockAlertPct'],
    ['alert 101', { hourBlockAlertPct: 101 }, 'hourBlockAlertPct'],
    ['a fractional alert', { hourBlockAlertPct: 80.5 }, 'hourBlockAlertPct'],
    ['a site', { siteId: GUID }, 'siteId'],
    ['device roles', { deviceRoles: ['server'] }, 'deviceRoles'],
    ['a device group', { deviceGroupId: GUID }, 'deviceGroupId'],
    ['a manual quantity', { manualQuantity: '1.00' }, 'manualQuantity'],
  ];
  it.each(REJECTED)('rejects %s', (_name, patch, path) => {
    const r = contractLineInputSchema.safeParse({ ...VALID, ...patch });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.map((i) => i.path[0])).toContain(path);
  });

  it('rejects an unknown rollover policy', () => {
    expect(contractLineInputSchema.safeParse({ ...VALID, rolloverPolicy: 'forever' }).success).toBe(false);
  });

  it('rejects block-only fields on every other line type', () => {
    for (const extra of [{ rolloverPolicy: 'none' }, { rolloverCapHours: '5' }, { hourBlockAlertPct: 50 }]) {
      const flat = contractLineInputSchema.safeParse({ lineType: 'flat', description: 'x', unitPrice: '1.00', taxable: false, ...extra });
      expect(flat.success).toBe(false);
      const seat = contractLineInputSchema.safeParse({ lineType: 'per_seat', description: 'x', unitPrice: '1.00', taxable: false, ...extra });
      expect(seat.success).toBe(false);
    }
  });

  it('never accepts the server-stamped columns: create strips them, they never reach the parsed output', () => {
    const r = contractLineInputSchema.safeParse({
      ...VALID, hourBlockFirstPeriodStart: '2020-01-01', hourBlockRetiredAt: '2020-01-01T00:00:00Z',
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data).not.toHaveProperty('hourBlockFirstPeriodStart');
      expect(r.data).not.toHaveProperty('hourBlockRetiredAt');
    }
  });
});

describe('updateContractLineSchema — hour_block', () => {
  it('accepts the three patchable block fields, nullable only where clearing leaves a valid row', () => {
    expect(updateContractLineSchema.safeParse({ rolloverPolicy: 'carry_forward' }).success).toBe(true);
    expect(updateContractLineSchema.safeParse({ rolloverCapHours: '12.5' }).success).toBe(true);
    expect(updateContractLineSchema.safeParse({ rolloverCapHours: null }).success).toBe(true);
    expect(updateContractLineSchema.safeParse({ hourBlockAlertPct: null }).success).toBe(true);
    expect(updateContractLineSchema.safeParse({ hourBlockAlertPct: 90 }).success).toBe(true);
    expect(updateContractLineSchema.safeParse({ rolloverPolicy: null }).success).toBe(false);
    expect(updateContractLineSchema.safeParse({ hourBlockAlertPct: 0 }).success).toBe(false);
  });

  it('rejects the server-stamped columns and lineType (strict schema)', () => {
    expect(updateContractLineSchema.safeParse({ hourBlockFirstPeriodStart: '2020-01-01' }).success).toBe(false);
    expect(updateContractLineSchema.safeParse({ hourBlockRetiredAt: '2020-01-01T00:00:00Z' }).success).toBe(false);
    expect(updateContractLineSchema.safeParse({ lineType: 'hour_block' }).success).toBe(false);
  });
});

describe('contractLineInvariantIssues — create and persisted agree on a block', () => {
  const SHAPES: Array<[string, ContractLineShape]> = [
    ['valid none', { lineType: 'hour_block', includedQuantity: '10', overageMode: 'bill', overageUnitPrice: '150.00', rolloverPolicy: 'none' }],
    ['valid carry + cap + alert', { lineType: 'hour_block', includedQuantity: '10', overageMode: 'bill', overageUnitPrice: '150.00', rolloverPolicy: 'carry_forward', rolloverCapHours: '4', hourBlockAlertPct: 75 }],
    ['cap under none', { lineType: 'hour_block', includedQuantity: '10', overageMode: 'bill', overageUnitPrice: '150.00', rolloverPolicy: 'none', rolloverCapHours: '4' }],
    ['flag mode', { lineType: 'hour_block', includedQuantity: '10', overageMode: 'flag', rolloverPolicy: 'none' }],
    ['no policy', { lineType: 'hour_block', includedQuantity: '10', overageMode: 'bill', overageUnitPrice: '150.00' }],
    ['alert 101', { lineType: 'hour_block', includedQuantity: '10', overageMode: 'bill', overageUnitPrice: '150.00', rolloverPolicy: 'none', hourBlockAlertPct: 101 }],
    ['manual quantity', { lineType: 'hour_block', includedQuantity: '10', overageMode: 'bill', overageUnitPrice: '150.00', rolloverPolicy: 'none', manualQuantity: '1.00' }],
    ['block field on flat', { lineType: 'flat', rolloverPolicy: 'none' }],
  ];
  it.each(SHAPES)('%s', (_name, shape) => {
    const create = contractLineInvariantIssues(shape, { mode: 'create' }).map((i) => `${i.path}:${i.message}`).sort();
    const persisted = contractLineInvariantIssues(shape, { mode: 'persisted' }).map((i) => `${i.path}:${i.message}`).sort();
    expect(persisted).toEqual(create);
  });

  it('a valid block has no issues in either mode', () => {
    const shape: ContractLineShape = { lineType: 'hour_block', includedQuantity: '10', overageMode: 'bill', overageUnitPrice: '150.00', rolloverPolicy: 'none' };
    expect(contractLineInvariantIssues(shape, { mode: 'create' })).toEqual([]);
    expect(contractLineInvariantIssues(shape, { mode: 'persisted' })).toEqual([]);
  });
});

describe('mergeContractLinePatch — block columns', () => {
  const current: PersistedContractLine = {
    lineType: 'hour_block', description: 'Support block', unitPrice: '1000.00', taxable: false, catalogItemId: null,
    manualQuantity: null, siteId: null, siteName: null, deviceRoles: null, deviceGroupId: null, deviceGroupName: null,
    sortOrder: 0, includedQuantity: '10.00', overageMode: 'bill', overageUnitPrice: '150.00',
    rolloverPolicy: 'carry_forward', rolloverCapHours: '4.00', hourBlockAlertPct: 80,
  };

  it('leaves the block columns alone when the patch does not name them', () => {
    expect(mergeContractLinePatch(current, { description: 'Renamed' } as never)).toMatchObject({
      rolloverPolicy: 'carry_forward', rolloverCapHours: '4.00', hourBlockAlertPct: 80,
    });
  });

  it('null clears the cap and the alert; a value replaces them', () => {
    const cleared = mergeContractLinePatch(current, { rolloverCapHours: null, hourBlockAlertPct: null } as never);
    expect(cleared.rolloverCapHours).toBeNull();
    expect(cleared.hourBlockAlertPct).toBeNull();
    expect(mergeContractLinePatch(current, { rolloverCapHours: '9' } as never).rolloverCapHours).toBe('9');
  });

  it('persisted parity: switching to none while a cap is set is a 400-shaped issue on the MERGED row', () => {
    const merged = mergeContractLinePatch(current, { rolloverPolicy: 'none' } as never);
    const issues = contractLineInvariantIssues(merged, { mode: 'persisted' });
    expect(issues.map((i) => i.path)).toContain('rolloverCapHours');
    const fixed = mergeContractLinePatch(current, { rolloverPolicy: 'none', rolloverCapHours: null } as never);
    expect(contractLineInvariantIssues(fixed, { mode: 'persisted' })).toEqual([]);
  });

  it('persisted parity: clearing the included hours or leaving bill mode is rejected', () => {
    expect(contractLineInvariantIssues(mergeContractLinePatch(current, { includedQuantity: null } as never), { mode: 'persisted' }).length).toBeGreaterThan(0);
    expect(contractLineInvariantIssues(mergeContractLinePatch(current, { overageMode: 'flag', overageUnitPrice: null } as never), { mode: 'persisted' }).length).toBeGreaterThan(0);
  });
});
