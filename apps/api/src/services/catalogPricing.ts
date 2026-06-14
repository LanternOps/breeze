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
  unitPrice: string;
  costBasis: string | null;
  taxable: boolean;
  taxCategory: string | null;
  source: 'org_override' | 'item';
}

export function resolvePriceFrom(
  item: { unitPrice: string; costBasis: string | null; taxable: boolean; taxCategory: string | null },
  override: { unitPrice: string } | null
): ResolvedPrice {
  return {
    unitPrice: override ? override.unitPrice : item.unitPrice,
    costBasis: item.costBasis,
    taxable: item.taxable,
    taxCategory: item.taxCategory,
    source: override ? 'org_override' : 'item'
  };
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

export function computeBundleEconomicsFrom(args: {
  headlinePrice: string;
  components: Array<{ quantity: string; costBasis: string | null; revenueAllocation: string | null }>;
}): {
  headlinePrice: string;
  totalCost: string;
  margin: string;
  marginPct: number;
  allocationTotal: string;
  allocationMatchesHeadline: boolean;
} {
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
  return {
    headlinePrice: fromCents(headlineCents),
    totalCost: fromCents(costCents),
    margin: fromCents(marginCents),
    marginPct: headlineCents === 0 ? 0 : Math.round((marginCents / headlineCents) * 10000) / 100,
    allocationTotal: fromCents(allocCents),
    allocationMatchesHeadline: anyAllocation ? allocCents === headlineCents : true
  };
}
