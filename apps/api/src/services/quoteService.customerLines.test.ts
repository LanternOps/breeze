import { describe, expect, it } from 'vitest';
import { toCustomerLines } from './quoteService';

const full = {
  id: 'l1', quoteId: 'q1', blockId: null, orgId: 'o1', sourceType: 'catalog', catalogItemId: 'c1',
  parentLineId: null, name: 'Laptop', description: null, quantity: '1.00', unitPrice: '600.00',
  taxable: false, customerVisible: true, lineTotal: '600.00', recurrence: 'one_time',
  termMonths: null, billingFrequency: null, depositEligible: false, itemType: 'hardware',
  sku: 'LT-100', partNumber: 'MFG-9', imageId: null, sortOrder: 0, createdAt: new Date(),
  // internal-only:
  unitCost: '450.00', procurementSource: 'td_synnex', vendorSku: '7724459', manufacturer: 'HPE',
};

describe('toCustomerLines', () => {
  it('emits exactly the customer allowlist — never cost or vendor identity', () => {
    const line = toCustomerLines([full])[0]!;
    expect(line).not.toHaveProperty('unitCost');
    expect(line).not.toHaveProperty('procurementSource');
    expect(line).not.toHaveProperty('vendorSku');
    expect(line).not.toHaveProperty('manufacturer');
    // and keeps the deliberately customer-visible identifiers:
    expect(line.sku).toBe('LT-100');
    expect(line.partNumber).toBe('MFG-9');
    expect(line.unitPrice).toBe('600.00');
  });
});
