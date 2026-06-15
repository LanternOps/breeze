import { describe, it, expect } from 'vitest';
import { timeEntryToLineSpec, ticketPartToLineSpec } from './invoiceAssembly';

describe('timeEntryToLineSpec', () => {
  it('converts minutes to hours and computes line total; flags unapproved; non-taxable', () => {
    const spec = timeEntryToLineSpec({
      id: 'te1', ticketId: 'tk1', description: 'Onsite repair',
      durationMinutes: 90, hourlyRate: '120.00', isApproved: false
    });
    expect(spec).toMatchObject({
      sourceType: 'time_entry', sourceId: 'te1', ticketId: 'tk1',
      description: 'Onsite repair', quantity: '1.50', unitPrice: '120.00',
      taxable: false, customerVisible: true, lineTotal: '180.00', isUnapprovedTime: true
    });
  });
  it('defaults description and rate', () => {
    const spec = timeEntryToLineSpec({ id: 'te2', ticketId: null, description: null, durationMinutes: 0, hourlyRate: null, isApproved: true });
    expect(spec.description).toBe('Labor');
    expect(spec.unitPrice).toBe('0.00');
    expect(spec.lineTotal).toBe('0.00');
    expect(spec.isUnapprovedTime).toBe(false);
  });
});

describe('ticketPartToLineSpec', () => {
  it('maps qty/price/cost; parts are taxable by default', () => {
    const spec = ticketPartToLineSpec({
      id: 'p1', ticketId: 'tk1', catalogItemId: 'c1', description: 'SSD 1TB',
      quantity: '2', unitPrice: '95.00', costBasis: '60.00'
    });
    expect(spec).toMatchObject({
      sourceType: 'part', sourceId: 'p1', ticketId: 'tk1', catalogItemId: 'c1',
      description: 'SSD 1TB', quantity: '2', unitPrice: '95.00', costBasis: '60.00',
      taxable: true, customerVisible: true, lineTotal: '190.00', isUnapprovedTime: false
    });
  });
});
