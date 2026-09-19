import { eq } from 'drizzle-orm';
import { db } from '../db';
import { organizations, partners } from '../db/schema/orgs';
import { readWithPartnerAxisVisibility } from '../db/partnerAxisRead';
import { resolveEffectiveTaxRate } from './invoiceMath';

/**
 * Thrown by resolveOrgTaxRate when the org row is not visible in the caller's
 * ambient RLS context (wrong tenant, or an org that's suspended/archived/
 * cross-partner and therefore hidden by breeze_has_org_access). Callers MUST
 * NOT catch this and fall through to the partner rate — that would silently
 * tax an invisible (possibly tax-exempt) org at the partner default. Map it
 * to a proper 404/403 at the service boundary instead (see quoteService's
 * resolveQuoteTaxRate wrapper).
 */
export class OrgNotVisibleForTaxError extends Error {
  constructor(public readonly orgId: string) {
    super(`Organization ${orgId} is not visible for tax resolution`);
    this.name = 'OrgNotVisibleForTaxError';
  }
}

/**
 * The ONE tax-rate resolver (settings audit rule 5) — used today by quote
 * creation, quote org-reassignment and quote update (via
 * quoteService.resolveQuoteTaxRate, a thin wrapper). A later wave (M18) will
 * route draft-invoice tax resolution through this same function; the
 * issued-invoice path keeps its own read (invoiceService.ts) because it runs
 * inside an already-open system transaction with the invoice/lines rows
 * locked and cannot call a helper that opens a second transaction.
 *
 * Tenancy contract (CLAUDE.md): `organizations` is read in the caller's
 * AMBIENT request context so RLS enforces org access — never escalated, and
 * checked BEFORE any partner read (fail-closed: see OrgNotVisibleForTaxError
 * above). The `partners` row is a partner-AXIS table (`PARTNER_TENANT_TABLES`),
 * so the read goes through `readWithPartnerAxisVisibility`, which only
 * escalates when the ambient scope isn't already 'system'. Callers MUST have
 * already verified the caller may access `orgId` (assertOrg or equivalent)
 * before calling this — `partnerId` must come from the verified auth context
 * (`resolvePartner(actor)` / `requirePartner(actor)`), never a client-supplied
 * value, and the caller must have already confirmed the org belongs to that
 * partner.
 *
 * Returns null (not an all-zero fraction) when there is no tax, mirroring the
 * old resolveQuoteTaxRate contract so a no-tax quote stays visually clean.
 */
export async function resolveOrgTaxRate(input: { orgId: string; partnerId: string }): Promise<string | null> {
  const [org] = await db
    .select({ taxExempt: organizations.taxExempt, taxRate: organizations.taxRate })
    .from(organizations)
    .where(eq(organizations.id, input.orgId))
    .limit(1);

  // Fail closed. A missing row under the caller's ambient context is either a
  // wrong/forged orgId or a real org RLS is hiding — never fall through to
  // the partner default for either case.
  if (!org) {
    throw new OrgNotVisibleForTaxError(input.orgId);
  }

  const [partner] = await readWithPartnerAxisVisibility(() =>
    db
      .select({ defaultTaxRate: partners.defaultTaxRate })
      .from(partners)
      .where(eq(partners.id, input.partnerId))
      .limit(1)
  );

  const rate = resolveEffectiveTaxRate({
    taxExempt: org.taxExempt,
    orgRate: org.taxRate,
    partnerRate: partner?.defaultTaxRate ?? null,
  });
  return Number(rate) > 0 ? rate : null;
}
