// Pure money/bundle helpers. Money is carried as fixed-2-decimal strings to match
// numeric(12,2) columns. No DB, no I/O — fully unit-testable.

function toCents(v: string | number | null | undefined): number {
  if (v === null || v === undefined || v === '') return 0;
  return Math.round(Number(v) * 100);
}
function fromCents(cents: number): string {
  return (cents / 100).toFixed(2);
}

export function deriveUnitPrice(input: {
  explicitPrice: number | undefined;
  costBasis: string | null;
  markupPercent: string | null;
}): string {
  if (input.explicitPrice !== undefined) return Number(input.explicitPrice).toFixed(2);
  if (input.costBasis !== null && input.markupPercent !== null) {
    const cost = toCents(input.costBasis);
    const marked = Math.round(cost * (1 + Number(input.markupPercent) / 100));
    return fromCents(marked);
  }
  return '0.00';
}

export interface ResolvedPrice {
  unitPrice: string;                 // fixed-2-decimal, in currencyCode
  currencyCode: string;              // the TARGET currency the caller asked for
  costBasis: string | null;          // the item's cost — may be in another currency
  costCurrency: string;
  /** true only when costCurrency === currencyCode; callers must not compute margin otherwise */
  marginAvailable: boolean;
  taxable: boolean;
  taxCategory: string | null;
  source: 'org_override' | 'price_book';
}

/**
 * Pure resolution (spec §6): an org override IN THE TARGET CURRENCY wins; else
 * the price-book row for the target currency; else null — the typed gap the
 * caller turns into NO_PRICE_FOR_CURRENCY. Never converts, never falls
 * through to another currency's number.
 */
export function resolvePriceFrom(
  item: { costBasis: string | null; costCurrency: string; taxable: boolean; taxCategory: string | null },
  override: { unitPrice: string; currencyCode: string } | null,
  bookRow: { unitPrice: string } | null,
  targetCurrency: string
): ResolvedPrice | null {
  const common = {
    currencyCode: targetCurrency,
    costBasis: item.costBasis,
    costCurrency: item.costCurrency,
    marginAvailable: item.costCurrency === targetCurrency,
    taxable: item.taxable,
    taxCategory: item.taxCategory,
  };
  if (override && override.currencyCode === targetCurrency) {
    return { ...common, unitPrice: override.unitPrice, source: 'org_override' };
  }
  if (bookRow) return { ...common, unitPrice: bookRow.unitPrice, source: 'price_book' };
  return null;
}

export type BundleProblem =
  | 'SELF_REFERENCE'
  | 'NESTED_BUNDLE'
  | 'CROSS_PARTNER'
  | 'COMPONENT_NOT_FOUND'
  | 'DUPLICATE_COMPONENT';

export function detectBundleProblems(args: {
  bundleId: string;
  bundlePartnerId: string;
  components: Array<{ componentItemId: string; quantity: number }>;
  componentMeta: Map<string, { isBundle: boolean; partnerId: string }>;
}): BundleProblem[] {
  const problems = new Set<BundleProblem>();
  const seen = new Set<string>();
  for (const c of args.components) {
    if (seen.has(c.componentItemId)) problems.add('DUPLICATE_COMPONENT');
    seen.add(c.componentItemId);
    if (c.componentItemId === args.bundleId) problems.add('SELF_REFERENCE');
    const meta = args.componentMeta.get(c.componentItemId);
    if (!meta) { problems.add('COMPONENT_NOT_FOUND'); continue; }
    if (meta.isBundle) problems.add('NESTED_BUNDLE');
    if (meta.partnerId !== args.bundlePartnerId) problems.add('CROSS_PARTNER');
  }
  return [...problems];
}

export interface BundleEconomics {
  currencyCode: string;
  /** null when the bundle itself has no price in currencyCode */
  headlinePrice: string | null;
  /** every component has a price-book row in currencyCode AND headlinePrice !== null */
  priceBookComplete: boolean;
  /** every component's costCurrency === currencyCode (null cost still counts as 0, as before) */
  marginAvailable: boolean;
  /** null unless priceBookComplete && marginAvailable — never a partial sum */
  totalCost: string | null;
  margin: string | null;
  marginPct: number | null;
  allocationTotal: string;
  allocationMatchesHeadline: boolean;
  /** component item ids lacking a price in currencyCode (empty when complete) */
  missingPriceComponentIds: string[];
}

export function computeBundleEconomicsFrom(args: {
  currencyCode: string;
  headlinePrice: string | null;
  components: Array<{
    componentItemId: string;
    quantity: string;
    costBasis: string | null;
    costCurrency: string;
    revenueAllocation: string | null;
    hasPriceInCurrency: boolean;
  }>;
}): BundleEconomics {
  const missingPriceComponentIds = args.components
    .filter((component) => !component.hasPriceInCurrency)
    .map((component) => component.componentItemId);
  const priceBookComplete = args.headlinePrice !== null && missingPriceComponentIds.length === 0;
  const marginAvailable = args.components.every(
    (component) => component.costCurrency === args.currencyCode
  );
  let costCents = 0;
  let allocCents = 0;
  let anyAllocation = false;
  for (const c of args.components) {
    costCents += Math.round((toCents(c.costBasis) * Number(c.quantity || '0')));
    if (c.revenueAllocation !== null && c.revenueAllocation !== undefined) {
      anyAllocation = true;
      allocCents += toCents(c.revenueAllocation);
    }
  }
  const headlineCents = toCents(args.headlinePrice);
  const marginCents = headlineCents - costCents;
  const economicsAvailable = priceBookComplete && marginAvailable;
  return {
    currencyCode: args.currencyCode,
    headlinePrice: args.headlinePrice === null ? null : fromCents(headlineCents),
    priceBookComplete,
    marginAvailable,
    totalCost: economicsAvailable ? fromCents(costCents) : null,
    margin: economicsAvailable ? fromCents(marginCents) : null,
    marginPct: economicsAvailable
      ? headlineCents === 0
        ? 0
        : Math.round((marginCents / headlineCents) * 10000) / 100
      : null,
    allocationTotal: fromCents(allocCents),
    allocationMatchesHeadline: args.headlinePrice === null
      ? !anyAllocation
      : anyAllocation
        ? allocCents === headlineCents
        : true,
    missingPriceComponentIds
  };
}
