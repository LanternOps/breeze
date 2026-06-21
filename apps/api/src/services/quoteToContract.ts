// Phase 4: map an accepted quote's recurring lines into draft Contract specs.
// Pure / DB-free so the grouping rules are exhaustively unit-testable.
// Grouping is BY CADENCE: a Contract has a single intervalMonths, so monthly
// and annual lines can never share one — they become separate contracts.

export interface QuoteForContract {
  orgId: string;
  partnerId: string;
  quoteNumber: string;
  currencyCode: string | null;
  terms: string | null;
}

export interface QuoteLineForContract {
  recurrence: 'one_time' | 'monthly' | 'annual';
  customerVisible: boolean;
  description: string;
  unitPrice: string;
  quantity: string;
  taxable: boolean;
  catalogItemId: string | null;
  termMonths: number | null;
}

export interface NewContractLineSpec {
  lineType: 'flat' | 'per_device' | 'per_seat' | 'manual';
  description: string;
  unitPrice: string;
  taxable: boolean;
  catalogItemId?: string | null;
  manualQuantity?: string | null;
  siteId?: string | null;
  sortOrder?: number;
}

export interface NewContractSpec {
  orgId: string;
  partnerId: string;
  name: string;
  billingTiming: 'advance' | 'arrears';
  intervalMonths: number;
  startDate: string;
  endDate?: string | null;
  currencyCode?: string;
  notes?: string | null;
  terms?: string | null;
  createdBy?: string | null;
  lines: NewContractLineSpec[];
}

// Date-only (YYYY-MM-DD) month arithmetic in UTC. Month overflow rolls forward
// (Jan 31 + 1mo -> Mar 03), matching JS Date semantics — acceptable for term ends.
export function addMonthsToDate(dateStr: string, months: number): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    throw new Error(`addMonthsToDate: expected YYYY-MM-DD, got "${dateStr}"`);
  }
  if (!Number.isInteger(months) || months < 1) {
    throw new Error(`addMonthsToDate: months must be a positive integer, got ${months}`);
  }
  const [y, m, d] = dateStr.split('-').map((n) => parseInt(n, 10));
  const base = new Date(Date.UTC(y!, m! - 1, d!));
  base.setUTCMonth(base.getUTCMonth() + months);
  return base.toISOString().slice(0, 10);
}

const CADENCES: ReadonlyArray<{ key: 'monthly' | 'annual'; intervalMonths: number; label: string }> = [
  { key: 'monthly', intervalMonths: 1, label: 'Monthly' },
  { key: 'annual', intervalMonths: 12, label: 'Annual' },
];

export function buildContractSpecsFromQuote(
  quote: QuoteForContract,
  lines: QuoteLineForContract[],
  startDate: string,
  createdBy: string | null,
): NewContractSpec[] {
  const specs: NewContractSpec[] = [];

  for (const cadence of CADENCES) {
    const group = lines.filter((l) => l.recurrence === cadence.key && l.customerVisible);
    if (group.length === 0) continue;

    // endDate only when every line in the group agrees on a single non-null term.
    const distinctTerms = [...new Set(group.map((l) => l.termMonths).filter((t): t is number => t != null))];
    const endDate = distinctTerms.length === 1 ? addMonthsToDate(startDate, distinctTerms[0]!) : null;

    specs.push({
      orgId: quote.orgId,
      partnerId: quote.partnerId,
      name: `${quote.quoteNumber} — ${cadence.label}`,
      billingTiming: 'advance',
      intervalMonths: cadence.intervalMonths,
      startDate,
      endDate,
      currencyCode: quote.currencyCode ?? 'USD',
      notes: `Auto-created from accepted quote ${quote.quoteNumber}`,
      terms: quote.terms ?? null,
      createdBy,
      lines: group.map((l, i) => ({
        lineType: 'manual' as const,
        description: l.description,
        unitPrice: l.unitPrice,
        manualQuantity: l.quantity,
        taxable: l.taxable,
        catalogItemId: null, // drop the catalog link so billing uses the frozen quote price, not the live catalog price
        sortOrder: i,
      })),
    });
  }

  return specs;
}
