import { DOCUMENT_LABELS_EN } from './en';
import type { DocumentLabels } from './types';

/**
 * Brazilian Portuguese document strings. The invoice keys that used to live in
 * the API's `pdf` namespace (apps/api/src/i18n/locales/pt-BR/pdf.json) moved
 * here in W3a so the screen and the PDF read the same in pt-BR (spec §3.7);
 * the rest follow the web app's pt-BR `invoiceDocument` wording.
 */
export const DOCUMENT_LABELS_PT_BR: DocumentLabels = Object.freeze({
  invoiceEyebrow: 'Fatura',
  draftNumber: 'Fatura',
  issued: 'Emitida',
  due: 'Vencimento',
  billTo: 'Cobrar de',
  notes: 'Observações',
  terms: 'Termos',
  termsFull: 'Termos e condições',
  columns: Object.freeze({ description: 'Descrição', qty: 'Qtd', unitPrice: 'Preço', tax: 'Imposto', amount: 'Valor' }),
  empty: 'Esta fatura ainda não tem itens.',
  laborLine: 'Mão de obra',
  ticketHeader: (n: string) => `Ticket nº ${n}`,
  ticketTitle: (n: string, subject: string) => `Ticket nº ${n}: ${subject}`,
  workedVsBilled: (worked: string, billed: string) => `${worked} h trabalhadas · ${billed} h faturadas`,
  notTaxable: 'Não tributável',
  totals: Object.freeze({
    subtotal: 'Subtotal',
    tax: (pct: string | null) => (pct ? `Imposto (${pct}%)` : 'Imposto'),
    total: 'Total',
    paid: 'Valor pago',
    balance: 'Saldo',
    balanceDue: 'Saldo devedor',
  }),
  deposit: Object.freeze({
    due: (deposit: string, paid: string, total: string) => ['Depósito de ', { strong: deposit }, ` devido — ${paid} de ${total} pagos.`],
    paid: (remaining: string) => [`Depósito pago — saldo restante ${remaining}.`],
  }),
  status: Object.freeze({
    draft: 'Rascunho',
    sent: 'Enviada',
    partially_paid: 'Parcialmente paga',
    overdue: 'Vencida',
    paid: 'Paga',
    void: 'Anulada',
  }),
  perMonth: Object.freeze({ text: '/mês', srText: 'por mês' }),
  perYear: Object.freeze({ text: '/ano', srText: 'por ano' }),
  // ---- W3a: strings only the PDF prints ----
  pdf: Object.freeze({
    from: 'De',
    taxId: (id: string) => `ID fiscal: ${id}`,
    payOnline: 'Pagar on-line:',
    category: (name: string) => `Categoria: ${name}`,
  }),
  // ---- W2a (#9418): quote document ----
  // Not translated yet: W2b ports the web app's pt-BR `quotes.document.*`
  // strings here before it deletes them. Until then pt-BR proposals read in
  // English, exactly as the portal and the PDF did before this package.
  quote: DOCUMENT_LABELS_EN.quote,
});
