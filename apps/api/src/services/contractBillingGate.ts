import { eq } from 'drizzle-orm';
import { db } from '../db';
import { contracts } from '../db/schema';
import { assertBillingEnabledForOrg } from './billingEnabled';
import { ContractServiceError, type ContractServiceErrorCode } from './contractTypes';

/**
 * Partner billing master switch for the contract family: 404
 * `{ error: 'Not found', code: 'BILLING_DISABLED' }` when the org's partner has
 * billing off. Kept out of contractService so routes can use it without pulling
 * the service module.
 */
export async function assertContractBillingEnabled(orgId: string | null | undefined): Promise<void> {
  await assertBillingEnabledForOrg(orgId, (m, s, c) => new ContractServiceError(m, s, c as ContractServiceErrorCode));
}

/**
 * Same gate, resolving the org from the contract id (one RLS-scoped read). An
 * unknown / invisible contract passes through so the caller's own not-found and
 * access errors keep their order.
 */
export async function assertContractBillingEnabledById(contractId: string): Promise<void> {
  const [row] = await db.select({ orgId: contracts.orgId }).from(contracts).where(eq(contracts.id, contractId)).limit(1);
  if (row) await assertContractBillingEnabled(row.orgId);
}
