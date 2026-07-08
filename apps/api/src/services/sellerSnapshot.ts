// Pure helpers for the seller "From" contact block. buildSellerSnapshot freezes
// a partner's billing-contact profile onto a document at issue time; renderers
// read the frozen snapshot. The address sub-object uses the SAME keys as
// billToAddress so the PDF renderers' existing addressLines() helper works for it.

// Intentional duplicate of SellerSnapshot in apps/web/src/components/billing/invoiceTypes.ts
// and apps/portal/src/lib/api.ts — api/web/portal can't share a package; keep in sync.
export interface SellerSnapshot {
  name: string | null;
  // builder never returns null for address, but consumers may receive null from
  // legacy jsonb rows — the | null is load-bearing for readers; do not remove it.
  address: {
    line1: string | null; line2: string | null; city: string | null;
    region: string | null; postalCode: string | null; country: string | null;
  } | null;
  phone: string | null;
  email: string | null;
  website: string | null;
}

interface PartnerContactFields {
  name?: string | null;
  billingCompanyName?: string | null;
  billingEmail?: string | null;
  billingPhone?: string | null;
  billingWebsite?: string | null;
  billingAddressLine1?: string | null;
  billingAddressLine2?: string | null;
  billingAddressCity?: string | null;
  billingAddressRegion?: string | null;
  billingAddressPostalCode?: string | null;
  billingAddressCountry?: string | null;
}

export function buildSellerSnapshot(partner: PartnerContactFields | null | undefined): SellerSnapshot {
  return {
    name: partner?.billingCompanyName ?? partner?.name ?? null,
    address: {
      line1: partner?.billingAddressLine1 ?? null,
      line2: partner?.billingAddressLine2 ?? null,
      city: partner?.billingAddressCity ?? null,
      region: partner?.billingAddressRegion ?? null,
      postalCode: partner?.billingAddressPostalCode ?? null,
      country: partner?.billingAddressCountry ?? null,
    },
    phone: partner?.billingPhone ?? null,
    email: partner?.billingEmail ?? null,
    website: partner?.billingWebsite ?? null,
  };
}

export function sellerAddressLines(snapshot: SellerSnapshot | null | undefined): string[] {
  const a = snapshot?.address;
  if (!a) return [];
  const cityLine = [a.city, a.region, a.postalCode].filter(Boolean).join(', ');
  return [a.line1, a.line2, cityLine, a.country].filter((s): s is string => !!s && s.trim().length > 0);
}

// The frozen customer "Bill to" address snapshot. Same key shape as
// SellerSnapshot['address'] and what the PDF addressLines() helper reads. The
// invoice issue path and the quote send path both freeze this at issue/send time
// so the two documents render identically — build it through buildBillToAddress
// (below) rather than an inline literal so the shapes can never drift apart.
export interface BillToAddress {
  line1: string | null; line2: string | null; city: string | null;
  region: string | null; postalCode: string | null; country: string | null;
}

interface OrgBillingAddressFields {
  billingAddressLine1?: string | null;
  billingAddressLine2?: string | null;
  billingAddressCity?: string | null;
  billingAddressRegion?: string | null;
  billingAddressPostalCode?: string | null;
  billingAddressCountry?: string | null;
}

/** Freeze an org's billing-address columns into a BillToAddress. Always returns a
 *  well-formed all-keys object (never partial), so addressLines() never sees an
 *  undefined field. Shared by invoiceService (issue) and quoteLifecycle (send). */
export function buildBillToAddress(org: OrgBillingAddressFields | null | undefined): BillToAddress {
  return {
    line1: org?.billingAddressLine1 ?? null,
    line2: org?.billingAddressLine2 ?? null,
    city: org?.billingAddressCity ?? null,
    region: org?.billingAddressRegion ?? null,
    postalCode: org?.billingAddressPostalCode ?? null,
    country: org?.billingAddressCountry ?? null,
  };
}
