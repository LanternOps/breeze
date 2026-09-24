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
 * quoteService.resolveQuoteTaxRate, a thin wrapper) and the draft-invoice
 * detail preview. Persisted draft-invoice recompute (M18, #6227) uses the
 * transaction-aware sibling resolveOrgTaxRateOn below — same core, no second
 * transaction. The issued-invoice path keeps its own read (invoiceService.ts)
 * because it runs inside an already-open system transaction with the
 * invoice/lines rows locked and reads the whole partner row there anyway.
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
  const org = await readOrgTaxInputs(db, input.orgId);

  const [partner] = await readWithPartnerAxisVisibility(() =>
    db
      .select({ defaultTaxRate: partners.defaultTaxRate })
      .from(partners)
      .where(eq(partners.id, input.partnerId))
      .limit(1)
  );

  return combineTaxRate(org, partner?.defaultTaxRate ?? null);
}

/**
 * Thrown by resolveOrgTaxRateOn when the partner row is not visible on the
 * caller's executor. `partner_id` on every taxed document is a NOT NULL FK, so
 * the row exists — its absence means RLS hid it (a caller without partner
 * access). Falling back to the org-only rate would silently under-tax.
 */
export class PartnerNotVisibleForTaxError extends Error {
  constructor(public readonly partnerId: string) {
    super(`Partner ${partnerId} is not visible for tax resolution`);
    this.name = 'PartnerNotVisibleForTaxError';
  }
}

/** Minimal executor shape: the global `db` or a transaction handle. */
type TaxReadExecutor = Pick<typeof db, 'select'>;

/**
 * Transaction-aware variant of resolveOrgTaxRate (#6227, settings audit M18) —
 * SAME precedence (shared core below), for callers that hold row locks inside
 * a transaction: persisted draft-invoice recompute runs under the invoice row
 * lock, and resolveOrgTaxRate's partner read would go through
 * readWithPartnerAxisVisibility, which (outside system scope) opens a SECOND
 * pooled transaction while the first still holds the lock (quorum amendment 6).
 *
 * Both reads run on `dbc`, in the caller's own context — no escalation. That is
 * only correct for callers whose context can already see the partner row
 * (partner or system scope); every current caller is (invoice routes are
 * partner/system-scoped, AI billing tools gate on partner/system, the contract
 * worker is system). Any other context fails closed with
 * PartnerNotVisibleForTaxError rather than silently dropping the partner rate.
 */
export async function resolveOrgTaxRateOn(
  dbc: TaxReadExecutor,
  input: { orgId: string; partnerId: string },
): Promise<string | null> {
  const org = await readOrgTaxInputs(dbc, input.orgId);
  const [partner] = await dbc
    .select({ defaultTaxRate: partners.defaultTaxRate })
    .from(partners)
    .where(eq(partners.id, input.partnerId))
    .limit(1);
  if (!partner) throw new PartnerNotVisibleForTaxError(input.partnerId);
  return combineTaxRate(org, partner.defaultTaxRate ?? null);
}

async function readOrgTaxInputs(dbc: TaxReadExecutor, orgId: string) {
  const [org] = await dbc
    .select({ taxExempt: organizations.taxExempt, taxRate: organizations.taxRate })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  // Fail closed. A missing row under the caller's ambient context is either a
  // wrong/forged orgId or a real org RLS is hiding — never fall through to
  // the partner default for either case.
  if (!org) {
    throw new OrgNotVisibleForTaxError(orgId);
  }
  return org;
}

/** The shared precedence core: exempt → 0, else org rate → partner rate → 0;
 *  null (not an all-zero fraction) when there is no tax. */
function combineTaxRate(org: { taxExempt: boolean; taxRate: string | null }, partnerRate: string | null): string | null {
  const rate = resolveEffectiveTaxRate({
    taxExempt: org.taxExempt,
    orgRate: org.taxRate,
    partnerRate,
  });
  return Number(rate) > 0 ? rate : null;
}
