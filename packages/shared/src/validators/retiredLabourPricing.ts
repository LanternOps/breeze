import { z } from 'zod';

// Labour-pricing inputs retired by the billing-profiles cut-over (#4628 W02).
//
// #6472: during the cut-over these keys were accepted and silently stripped, so
// `PATCH { defaultHourlyRate: 150 }` returned 200 and changed nothing — an
// integration raising a rate would keep billing at the old one. A previously
// meaningful write must fail loudly and name its replacement instead. This is
// a whole-request rejection: nothing else in the payload is applied either, so
// the caller never has to guess which half landed.

export const RETIRED_LABOUR_PRICING_FIELDS = ['defaultBillable', 'defaultHourlyRate', 'rateCurrency'] as const;
export type RetiredLabourPricingField = (typeof RETIRED_LABOUR_PRICING_FIELDS)[number];

export const LABOUR_PRICING_REPLACEMENT = {
  organization:
    "labour rates and billability now come from the organization's billing profile. "
    + 'Assign one with PUT /organizations/:id/billing-profile, or edit rates under Settings → Billing → Rates',
  category:
    'a category no longer carries pricing. Set defaultWorkTypeId and price that work type on the '
    + 'billing profile under Settings → Billing → Rates'
} as const;
export type LabourPricingReplacement = keyof typeof LABOUR_PRICING_REPLACEMENT;

export function retiredLabourPricingMessage(field: RetiredLabourPricingField, replacement: LabourPricingReplacement): string {
  return `${field} was retired in v0.115: ${LABOUR_PRICING_REPLACEMENT[replacement]}`;
}

/**
 * A retired field: rejected with an actionable message whenever present (any
 * value, including null), absent from the parsed type otherwise. Spread into a
 * `z.object` shape so the key is declared — an undeclared key would be stripped
 * by zod's default unknown-key handling, which is exactly the silent no-op.
 */
export function retiredLabourPricingFields(replacement: LabourPricingReplacement) {
  const retired = (field: RetiredLabourPricingField) =>
    z.never({ error: retiredLabourPricingMessage(field, replacement) }).optional();
  return {
    defaultBillable: retired('defaultBillable'),
    defaultHourlyRate: retired('defaultHourlyRate'),
    rateCurrency: retired('rateCurrency')
  };
}
