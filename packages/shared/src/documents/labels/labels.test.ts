import { describe, it, expect } from 'vitest';
import { documentLabelsFor, DOCUMENT_LABELS_EN, DOCUMENT_LABELS_PT_BR } from './index';
import { INVOICE_STATUSES } from '../../types/billing-enums';

describe('document labels', () => {
  it('a locale without document labels falls back to English', () => {
    expect(documentLabelsFor('fr-FR')).toBe(DOCUMENT_LABELS_EN);
    expect(documentLabelsFor('en')).toBe(DOCUMENT_LABELS_EN);
  });

  it('pt-BR has its own map (W3a)', () => {
    const pt = documentLabelsFor('pt-BR');
    expect(pt).not.toBe(DOCUMENT_LABELS_EN);
    expect(pt).toBe(DOCUMENT_LABELS_PT_BR);
    expect(pt.totals.balanceDue).toBe('Saldo devedor');
    expect(pt.columns.qty).toBe('Qtd');
    expect(pt.laborLine).toBe('Mão de obra');
    expect(pt.workedVsBilled('1,5', '2')).toBe('1,5 h trabalhadas · 2 h faturadas');
    expect(pt.issued).toBe('Emitida');
    expect(pt.pdf.from).toBe('De');
  });

  it('pt-BR has exactly the English key structure (functions stay functions)', () => {
    const shape = (o: unknown): unknown => (o && typeof o === 'object')
      ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, shape(v)]).sort(([a], [b]) => String(a).localeCompare(String(b))))
      : typeof o;
    expect(shape(DOCUMENT_LABELS_PT_BR)).toEqual(shape(DOCUMENT_LABELS_EN));
  });

  it('pt-BR quote labels are real translations, not the English placeholder (W2b)', () => {
    const q = DOCUMENT_LABELS_PT_BR.quote;
    expect(q).not.toBe(DOCUMENT_LABELS_EN.quote);
    expect(q.eyebrow).toBe('Proposta');
    expect(q.preparedFor).toBe('Preparado para');
    expect(q.validUntil).toBe('Válida até');
    expect(q.columns).toEqual({ description: 'Descrição', qty: 'Qtd.', unitPrice: 'Preço unitário', tax: 'Imposto', amount: 'Valor' });
    expect(q.totals.dueOnAcceptance).toBe('Devido na aceitação');
    expect(q.totals.tax('8.25')).toBe('Imposto (8.25%)');
    expect(q.deviceSet.role('server')).toBe('servidores');
    expect(q.deviceSet.estimated('dispositivos')).toBe('Quantidade estimada — cobrada pelo número real de dispositivos em cada período de faturamento.');
    expect(q.agreement.termsMeta(2, 3)).toBe('2 seções · ~3 min de leitura');
    expect(q.agreement.termsMeta(1, 3)).toBe('1 seção · ~3 min de leitura');
    expect(q.agreement.readMinutes(4)).toBe('~4 min de leitura');
    expect(q.cadence).toEqual({ one_time: 'Único', monthly: 'Mensal', annual: 'Anual' });
  });

  it('English PDF-only strings (W3a)', () => {
    expect(DOCUMENT_LABELS_EN.pdf.from).toBe('From');
    expect(DOCUMENT_LABELS_EN.pdf.taxId('12-345')).toBe('Tax ID: 12-345');
    expect(DOCUMENT_LABELS_EN.pdf.payOnline).toBe('Pay online:');
    expect(DOCUMENT_LABELS_EN.pdf.category('Network')).toBe('Category: Network');
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
