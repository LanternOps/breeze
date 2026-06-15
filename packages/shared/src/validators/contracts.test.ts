import { describe, it, expect } from 'vitest';
import { createContractSchema, contractLineInputSchema, updateContractSchema } from './contracts';

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
