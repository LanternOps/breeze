/**
 * Dependency-free org-currency primitives (multi-currency wave 6, #3778).
 *
 * WHY ITS OWN MODULE: `orgCurrencyService` is called BY `invoiceService`, while
 * the org SHARE-lock barrier (Task 12) is called by ticket, catalog, quote and
 * contract writers. Hanging either on `invoiceService` would create a runtime
 * import cycle and leak invoice-specific error classes into unrelated domains.
 * This file therefore imports ONLY `../db`, the schema and `@breeze/shared` —
 * never a domain service. Each caller maps `OrgCurrencyServiceError` onto its
 * own error class at its boundary (precedent: the CatalogServiceError ->
 * InvoiceServiceError mapping for NO_PRICE_FOR_CURRENCY).
 */
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { organizations } from '../db/schema';

/** Either the ambient `db` handle or a `db.transaction` callback handle. */
export type DbExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Structural subset of `InvoiceActor` / `ContractActor` / `TimeEntryActor`:
 *  the org-axis allowlist is the only thing these primitives need. */
export interface OrgCurrencyActor {
  accessibleOrgIds: string[] | null;
}

export type OrgCurrencyServiceErrorCode =
  | 'ORG_DENIED'
  | 'ORG_NOT_FOUND';

export class OrgCurrencyServiceError extends Error {
  constructor(
    message: string,
    public status: 400 | 403 | 404 | 409 | 500 = 400,
    public code?: OrgCurrencyServiceErrorCode,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'OrgCurrencyServiceError';
  }
}

/** Org-axis guard by id (mirrors `invoiceService.requireOrgAccess`, but neutral
 *  so ticket/catalog/contract callers do not import invoice code).
 *  `accessibleOrgIds === null` is system/unrestricted scope. */
export function requireOrgAccessById(actor: OrgCurrencyActor, orgId: string): void {
  if (actor.accessibleOrgIds !== null && !actor.accessibleOrgIds.includes(orgId)) {
    throw new OrgCurrencyServiceError('Organization access denied', 403, 'ORG_DENIED');
  }
}

/**
 * Reads the org's stamping defaults under a SHARE lock held to the end of the
 * caller's transaction. Pairs with `changeOrgCurrency`'s FOR UPDATE so a
 * default-derived row can never commit an old stamp unseen (#3778).
 *
 * MUST be the FIRST statement of the caller's transaction — that is what makes
 * the wave-6 lock order (`organizations` outermost) auditable by grep. This is
 * the ONLY sanctioned way for a constructor to take the org lock.
 */
export async function readOrgStampingDefaults(
  tx: DbExecutor, orgId: string
): Promise<{ currencyCode: string }> {
  const [org] = await tx
    .select({ currencyCode: organizations.currencyCode })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1)
    .for('share');
  if (!org) throw new OrgCurrencyServiceError('Organization not found', 404, 'ORG_NOT_FOUND');
  return org;
}
