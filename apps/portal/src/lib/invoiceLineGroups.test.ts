import { describe, it, expect } from 'vitest';
import { groupInvoiceLinesByTicket } from './invoiceLineGroups';

type L = { id: string; ticketNumber: string | null; ticketCategory?: string | null };

describe('groupInvoiceLinesByTicket', () => {
  it('keeps a ticketless invoice as one headerless group in original order', () => {
    const lines: L[] = [{ id: 'a', ticketNumber: null }, { id: 'b', ticketNumber: null }];
    const groups = groupInvoiceLinesByTicket(lines);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.ticketNumber).toBeNull();
    expect(groups[0]!.lines.map((l) => l.id)).toEqual(['a', 'b']);
  });

  it('groups by ticket number in first-seen order and carries the category', () => {
    const lines: L[] = [
      { id: 'a', ticketNumber: 'T-1', ticketCategory: 'Hardware' },
      { id: 'b', ticketNumber: null },
      { id: 'c', ticketNumber: 'T-1', ticketCategory: 'Hardware' },
      { id: 'd', ticketNumber: 'T-2' },
    ];
    const groups = groupInvoiceLinesByTicket(lines);
    expect(groups.map((g) => [g.ticketNumber, g.ticketCategory, g.lines.map((l) => l.id)])).toEqual([
      ['T-1', 'Hardware', ['a', 'c']],
      [null, null, ['b']],
      ['T-2', null, ['d']],
    ]);
  });
});
