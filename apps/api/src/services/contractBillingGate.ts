import { assertBillingEnabledForOrg } from './billingEnabled';
import { ContractServiceError, type ContractServiceErrorCode } from './contractTypes';

/**
 * Partner billing master switch for the contract family: 404
 * `{ error: 'Not found', code: 'BILLING_DISABLED' }` when the org's partner has
 * billing off. Kept out of contractService so the services that need it do not
 * import the whole contract service module.
 */
export async function assertContractBillingEnabled(orgId: string | null | undefined): Promise<void> {
  await assertBillingEnabledForOrg(orgId, (m, s, c) => new ContractServiceError(m, s, c as ContractServiceErrorCode));
}
