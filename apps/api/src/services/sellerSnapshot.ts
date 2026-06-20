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
