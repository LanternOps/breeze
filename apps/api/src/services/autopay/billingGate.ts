import { assertBillingEnabledForOrg, assertBillingEnabledForPartner, type BillingDisabledErrorFactory } from '../billingEnabled';
import { InvoiceServiceError, type InvoiceServiceErrorCode } from '../invoiceTypes';

// Partner billing master switch: 404 {error:'Not found',code:'BILLING_DISABLED'} via InvoiceServiceError.
const billingDisabledError: BillingDisabledErrorFactory = (m, s, c) => new InvoiceServiceError(m, s, c as InvoiceServiceErrorCode);
export const assertAutopayBillingEnabledForOrg = (orgId: string | null | undefined) =>
  assertBillingEnabledForOrg(orgId, billingDisabledError);
export const assertAutopayBillingEnabledForPartner = (partnerId: string | null | undefined) =>
  assertBillingEnabledForPartner(partnerId, billingDisabledError);
