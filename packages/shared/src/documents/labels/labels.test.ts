import { describe, it, expect } from 'vitest';
import { documentLabelsFor, DOCUMENT_LABELS_EN } from './index';
import { INVOICE_STATUSES } from '../../types/billing-enums';

describe('document labels', () => {
  it('every locale falls back to English in W1', () => {
    expect(documentLabelsFor('fr-FR')).toBe(DOCUMENT_LABELS_EN);
    expect(documentLabelsFor('pt-BR')).toBe(DOCUMENT_LABELS_EN);
    expect(documentLabelsFor('en')).toBe(DOCUMENT_LABELS_EN);
  });

  it('English matches the strings the portal prints today', () => {
    expect(DOCUMENT_LABELS_EN.totals.balanceDue).toBe('Balance due');
    expect(DOCUMENT_LABELS_EN.totals.balance).toBe('Balance');
    expect(DOCUMENT_LABELS_EN.totals.tax('8.25')).toBe('Tax (8.25%)');
    expect(DOCUMENT_LABELS_EN.totals.tax(null)).toBe('Tax');
    expect(DOCUMENT_LABELS_EN.workedVsBilled('1.5', '2')).toBe('1.5 h worked · 2 h billed');
    expect(DOCUMENT_LABELS_EN.ticketHeader('42')).toBe('Ticket #42');
    expect(DOCUMENT_LABELS_EN.ticketTitle('42', 'Printer offline')).toBe('Ticket #42: Printer offline');
    expect(DOCUMENT_LABELS_EN.columns).toEqual({ description: 'Description', qty: 'Qty', unitPrice: 'Price', tax: 'Tax', amount: 'Amount' });
    expect(DOCUMENT_LABELS_EN.termsFull).toBe('Terms & Conditions');
    expect(DOCUMENT_LABELS_EN.billTo).toBe('Bill to');
  });

  it('deposit sentences match the portal strip', () => {
    expect(DOCUMENT_LABELS_EN.deposit.due('$50.00', '$0.00', '$100.00'))
      .toEqual(['Deposit of ', { strong: '$50.00' }, ' due — $0.00 of $100.00 paid.']);
    expect(DOCUMENT_LABELS_EN.deposit.paid('$50.00')).toEqual(['Deposit paid — remaining balance $50.00.']);
  });

  it('has a status label for every invoice status (portal STATUS_LABELS)', () => {
    expect(Object.keys(DOCUMENT_LABELS_EN.status).sort()).toEqual([...INVOICE_STATUSES].sort());
    expect(DOCUMENT_LABELS_EN.status.partially_paid).toBe('Partially paid');
  });
});
