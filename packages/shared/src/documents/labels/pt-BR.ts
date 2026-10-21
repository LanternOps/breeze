import type { DocumentLabels } from './types';

/** Plural device-role nouns (the web app's pt-BR `quotes.deviceSet.roleNoun`). */
const PT_BR_ROLE_NOUNS: Record<string, string> = {
  workstation: 'estações de trabalho',
  server: 'servidores',
  printer: 'impressoras',
  router: 'roteadores',
  switch: 'comutadores de rede',
  firewall: 'firewalls de rede',
  access_point: 'pontos de acesso',
  phone: 'telefones',
  iot: 'dispositivos IoT',
  camera: 'câmeras',
  nas: 'dispositivos NAS',
};

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
  // ---- W2a (#9418) / W2b (#9419): quote document ----
  // Ported from the web app's pt-BR `quotes.document.*` strings (deleted with
  // the old Preview body). The status words are new here: the web Preview
  // printed its own status pill labels.
  quote: Object.freeze({
    eyebrow: 'Proposta',
    draftNumber: 'Proposta',
    issued: 'Emitida',
    validUntil: 'Válida até',
    preparedFor: 'Preparado para',
    preparedBy: 'Preparado por',
    columns: Object.freeze({ description: 'Descrição', qty: 'Qtd.', unitPrice: 'Preço unitário', tax: 'Imposto', amount: 'Valor' }),
    pricing: 'Preços',
    cadence: Object.freeze({ one_time: 'Único', monthly: 'Mensal', annual: 'Anual' }),
    tableSubtotal: 'Subtotal',
    imageAlt: 'Imagem da proposta',
    imageUnavailable: 'Imagem indisponível',
    deviceSet: Object.freeze({
      devices: 'dispositivos',
      seats: 'licenças',
      role: (role: string) => PT_BR_ROLE_NOUNS[role] ?? role,
      inGroup: (name: string) => `dispositivos em “${name}”`,
      atSite: (set: string, site: string) => `${set} em ${site}`,
      estimated: (set: string) => `Quantidade estimada — cobrada pelo número real de ${set} em cada período de faturamento.`,
      includesBilled: (included: string, price: string) => `Inclui ${included}; unidades adicionais são cobradas a ${price} cada.`,
      includesFlagged: (included: string) => `Inclui ${included}; unidades adicionais são reportadas para revisão, não cobradas automaticamente.`,
    }),
    category: (category: string) => category.charAt(0).toUpperCase() + category.slice(1),
    totals: Object.freeze({
      firstPeriodSubtotal: 'Subtotal do primeiro período',
      subtotal: 'Subtotal',
      tax: (pct: string | null) => (pct ? `Imposto (${pct}%)` : 'Imposto'),
      monthlyRecurring: 'Recorrência mensal',
      annualRecurring: 'Recorrência anual',
      dueOnAcceptance: 'Devido na aceitação',
      depositDueNow: 'Depósito devido agora',
      remainingBalance: 'Saldo restante (conforme os termos)',
      total: 'Total',
      firstPeriodTotal: 'Total do primeiro período',
      recurringNote: 'Aceitar esta proposta fatura agora os encargos únicos. As linhas recorrentes são faturadas conforme sua própria programação.',
    }),
    terms: 'Termos',
    agreement: Object.freeze({
      fallbackTitle: 'Acordo',
      termsTitle: 'Termos e condições',
      pdfMeta: 'Documento PDF',
      unavailableMeta: 'Indisponível',
      readMinutes: (minutes: number) => `~${minutes} min de leitura`,
      termsMeta: (sections: number, minutes: number) => (sections > 0
        ? `${sections} ${sections === 1 ? 'seção' : 'seções'} · ~${minutes} min de leitura`
        : `~${minutes} min de leitura`),
      footer: (templateName: string, version: number) => `${templateName} — versão ${version}`,
      contentUnavailable: 'Conteúdo do acordo indisponível',
      fileUnavailable: 'Arquivo do acordo indisponível',
      download: 'Baixar acordo',
      heading: 'Acordos',
      read: 'Ler',
      hide: 'Ocultar',
    }),
    status: Object.freeze({
      viewed: 'Visualizada',
      accepted: 'Aceita',
      declined: 'Recusada',
      expired: 'Expirada',
      converted: 'Aceita',
      superseded: 'Substituída',
    }),
  }),
});
