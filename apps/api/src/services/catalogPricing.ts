// Pure money/bundle helpers. Money is carried as fixed-2-decimal strings to match
// numeric(12,2) columns. No DB, no I/O — fully unit-testable.
import { isRepresentableInCurrency, roundToCurrency } from '@breeze/shared';

function toCents(v: string | number | null | undefined): number {
  if (v === null || v === undefined || v === '') return 0;
  return Math.round(Number(v) * 100);
}
function fromCents(cents: number): string {
  return (cents / 100).toFixed(2);
}

/**
 * Cost snapshot guard (#3775 review #4/#8): a stored cost may only travel into
 * a document / margin figure when it is stamped in the target currency AND is
 * exact at that currency's minor unit. Legacy backfills can carry JPY 100.50
 * (snapshots rule — never rewritten in place); such a cost is a GAP here, never
 * rounded (that would reinterpret stored money) and never copied onward.
 */
export function snapshotCost(
  costBasis: string | null | undefined,
  costCurrency: string,
  targetCurrency: string
): string | null {
  if (costBasis === null || costBasis === undefined) return null;
  if (costCurrency !== targetCurrency) return null;
  return isRepresentableInCurrency(costBasis, targetCurrency) ? costBasis : null;
}

/**
 * Cost pair for an externally sourced (distributor / Pax8) amount (#3775 review
 * #2). A feed amount is only storable when the feed also names its currency:
 * with no currency the cost is a GAP (null) — never relabelled as the partner
 * currency by createCatalogItem's default. The raw number still lands in the
 * jsonb snapshot for traceability. Every importer builds its cost through this
 * seam so none of them can fall back to the default.
 */
export function importedCost(
  feedCost: number | null | undefined,
  feedCurrency: string | null | undefined
): { costBasis: number | null; costCurrency: string | undefined } {
  const costCurrency = feedCurrency?.trim() ? feedCurrency.trim().toUpperCase() : undefined;
  const cost = feedCost != null && Number.isFinite(feedCost) ? feedCost : null;
  return { costBasis: costCurrency ? cost : null, costCurrency };
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
  /**
   * The item's cost when it is usable in currencyCode (same currency AND
   * representable at its minor unit), else null — see snapshotCost. A cost in
   * another currency is a gap (marginAvailable false), never returned here.
   */
  costBasis: string | null;
  costCurrency: string;
  /** true only when costBasis !== null; callers must not compute margin otherwise */
  marginAvailable: boolean;
  taxable: boolean;
  taxCategory: string | null;
  source: 'org_override' | 'price_book';
}

/** Typed resolver gaps — the caller maps each to its CatalogServiceError code. */
export type PriceGap =
  | { gap: 'NO_PRICE_FOR_CURRENCY' }
  /**
   * The winning row exists but its amount is not exact at the target
   * currency's minor unit (legacy backfill, e.g. JPY 100.50 — #3775 review
   * #4). Never rounded (snapshots rule), never skipped in favour of the next
   * candidate: the row IS the price the partner maintains; it needs fixing.
   */
  | { gap: 'PRICE_NOT_REPRESENTABLE'; source: ResolvedPrice['source']; unitPrice: string };

export function isPriceGap(r: ResolvedPrice | PriceGap): r is PriceGap {
  return 'gap' in r;
}

/**
 * Pure resolution (spec §6): an org override IN THE TARGET CURRENCY wins; else
 * the price-book row for the target currency; else a NO_PRICE_FOR_CURRENCY
 * gap. A winning row that is not representable in the target currency is a
 * PRICE_NOT_REPRESENTABLE gap. Never converts, never falls through to another
 * currency's number.
 */
export function resolvePriceFrom(
  item: { costBasis: string | null; costCurrency: string; taxable: boolean; taxCategory: string | null },
  override: { unitPrice: string; currencyCode: string } | null,
  bookRow: { unitPrice: string } | null,
  targetCurrency: string
): ResolvedPrice | PriceGap {
  const costBasis = snapshotCost(item.costBasis, item.costCurrency, targetCurrency);
  const common = {
    currencyCode: targetCurrency,
    costBasis,
    costCurrency: item.costCurrency,
    marginAvailable: costBasis !== null,
    taxable: item.taxable,
    taxCategory: item.taxCategory,
  };
  let candidate: { unitPrice: string; source: ResolvedPrice['source'] } | null = null;
  if (override && override.currencyCode === targetCurrency) {
    candidate = { unitPrice: override.unitPrice, source: 'org_override' };
  } else if (bookRow) {
    candidate = { unitPrice: bookRow.unitPrice, source: 'price_book' };
  }
  if (!candidate) return { gap: 'NO_PRICE_FOR_CURRENCY' };
  if (!isRepresentableInCurrency(candidate.unitPrice, targetCurrency)) {
    return { gap: 'PRICE_NOT_REPRESENTABLE', source: candidate.source, unitPrice: candidate.unitPrice };
  }
  return { ...common, ...candidate };
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

/**
 * Why the bundle's OWN headline price is unavailable in the target currency
 * (#3775 review #1). The bundle's own gap is always a null headline — never an
 * error — but the REASON rides along so a caller that must refuse (adding the
 * bundle to a document) can raise the right typed 409 and repeat the
 * actionable text instead of a generic "no price".
 */
export type BundleHeadlineGap = 'NO_PRICE_FOR_CURRENCY' | 'PRICE_NOT_REPRESENTABLE';

export interface BundleEconomics {
  currencyCode: string;
  /** null when the bundle itself has no usable price in currencyCode */
  headlinePrice: string | null;
  /** null iff headlinePrice !== null; why the headline is unavailable */
  headlineGap: BundleHeadlineGap | null;
  /** the resolver's actionable text for a stated gap; null for the plain missing-row gap */
  headlineGapMessage: string | null;
  /** every component has a price-book row in currencyCode AND headlinePrice !== null */
  priceBookComplete: boolean;
  /** every component's costCurrency === currencyCode (null cost still counts as 0, as before) */
  marginAvailable: boolean;
  /** null unless priceBookComplete && marginAvailable — never a partial sum */
  totalCost: string | null;
  margin: string | null;
  marginPct: number | null;
  /**
   * false when any component allocation is stamped in a currency other than
   * currencyCode (#3775 review #7) — the split is then unavailable in this
   * currency: allocationTotal null, allocationMatchesHeadline false. Never a
   * partial sum, never a relabelled amount.
   */
  allocationAvailable: boolean;
  /** null unless allocationAvailable */
  allocationTotal: string | null;
  allocationMatchesHeadline: boolean;
  /** component item ids lacking a price in currencyCode (empty when complete) */
  missingPriceComponentIds: string[];
}

export function computeBundleEconomicsFrom(args: {
  currencyCode: string;
  headlinePrice: string | null;
  /** stated only for a non-obvious gap; a null headline defaults to NO_PRICE_FOR_CURRENCY */
  headlineGap?: BundleHeadlineGap | null;
  headlineGapMessage?: string | null;
  components: Array<{
    componentItemId: string;
    quantity: string;
    costBasis: string | null;
    costCurrency: string;
    revenueAllocation: string | null;
    /** currency the allocation was authored in; null iff revenueAllocation is null */
    allocationCurrency: string | null;
    hasPriceInCurrency: boolean;
  }>;
}): BundleEconomics {
  const currency = args.currencyCode;
  const missingPriceComponentIds = args.components
    .filter((component) => !component.hasPriceInCurrency)
    .map((component) => component.componentItemId);
  const priceBookComplete = args.headlinePrice !== null && missingPriceComponentIds.length === 0;
  // Margin needs EVERY component cost usable in the bundle currency: same
  // currency and representable at its minor unit (#3775 review #4/#8). A null
  // cost still counts as 0, as before.
  const marginAvailable = args.components.every(
    (component) => component.costBasis === null || snapshotCost(component.costBasis, component.costCurrency, currency) !== null
  );
  // All arithmetic is in hundredths (exact for numeric(_,2) inputs) and every
  // derived amount is rounded at the TARGET currency's minor unit — a JPY
  // component costing 101 × qty 0.5 is 51, never 50.50 (#3775 review #8).
  let costCents = 0;
  let allocCents = 0;
  let anyAllocation = false;
  // An allocation authored in another currency makes the WHOLE split
  // unavailable here (#3775 review #7): it is neither summed nor relabelled.
  let allocationAvailable = true;
  for (const c of args.components) {
    const cost = snapshotCost(c.costBasis, c.costCurrency, currency);
    if (cost !== null) {
      costCents += toCents(roundToCurrency(Number(cost) * Number(c.quantity || '0'), currency));
    }
    if (c.revenueAllocation !== null && c.revenueAllocation !== undefined) {
      anyAllocation = true;
      if (c.allocationCurrency !== currency) { allocationAvailable = false; continue; }
      // Summed exactly, never rounded: a legacy fractional-yen allocation must
      // report as NOT matching a whole-yen headline rather than be relabelled.
      allocCents += toCents(c.revenueAllocation);
    }
  }
  const headlineCents = args.headlinePrice === null ? 0 : toCents(roundToCurrency(args.headlinePrice, currency));
  const marginCents = headlineCents - costCents;
  const economicsAvailable = priceBookComplete && marginAvailable;
  return {
    currencyCode: currency,
    headlinePrice: args.headlinePrice === null ? null : fromCents(headlineCents),
    headlineGap: args.headlinePrice !== null ? null : (args.headlineGap ?? 'NO_PRICE_FOR_CURRENCY'),
    headlineGapMessage: args.headlinePrice !== null ? null : (args.headlineGapMessage ?? null),
    priceBookComplete,
    marginAvailable,
    totalCost: economicsAvailable ? fromCents(costCents) : null,
    margin: economicsAvailable ? fromCents(marginCents) : null,
    marginPct: economicsAvailable
      ? headlineCents === 0
        ? 0
        : Math.round((marginCents / headlineCents) * 10000) / 100
      : null,
    allocationAvailable,
    allocationTotal: allocationAvailable ? fromCents(allocCents) : null,
    allocationMatchesHeadline: !allocationAvailable
      ? false
      : args.headlinePrice === null
        ? !anyAllocation
        : anyAllocation
          ? allocCents === headlineCents
          : true,
    missingPriceComponentIds
  };
}
