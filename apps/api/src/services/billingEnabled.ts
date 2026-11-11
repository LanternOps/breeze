import { eq, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { db, getCurrentDbAccessContext } from '../db';
import { readWithPartnerAxisVisibility } from '../db/partnerAxisRead';
import { organizations, partners } from '../db/schema/orgs';

/**
 * Partner billing master switch (`partners.billing_enabled`).
 * Spec: docs/superpowers/specs/billing/2026-10-16-partner-billing-enabled-design.md §7.
 *
 * With billing off, gated billing operations answer 404 with an IDENTICAL body
 * in every family: `{ error: 'Not found', code: 'BILLING_DISABLED' }`.
 *
 * Usage — each family throws its own error class so its `handleServiceError`
 * renders the body unchanged. All three constructors are `(message, status, code)`:
 *   await assertBillingEnabledForOrg(orgId, (m, s, c) =>
 *     new InvoiceServiceError(m, s, c as InvoiceServiceErrorCode));
 *   // QuoteServiceError / ContractServiceError: same shape.
 * The family's code union must include 'BILLING_DISABLED'.
 */
export const BILLING_DISABLED_MESSAGE = 'Not found';
export const BILLING_DISABLED_CODE = 'BILLING_DISABLED';
export const BILLING_DISABLED_STATUS = 404;

export type BillingDisabledErrorFactory = (
  message: string,
  status: typeof BILLING_DISABLED_STATUS,
  code: typeof BILLING_DISABLED_CODE,
) => Error;

/**
 * `partners` is partner-axis: an organization-scoped context (accessiblePartnerIds
 * = []) reads ZERO rows, which would answer "enabled" for a partner with billing
 * off (#2822). Same escape and same condition as `loadAutopayPartner`; the ids
 * passed in come from verified context or an RLS-visible row, and only the
 * boolean flag is read.
 */
const readPartnerAxis = <T>(fn: () => Promise<T>): Promise<T> =>
  getCurrentDbAccessContext()?.scope === 'organization' ? readWithPartnerAxisVisibility(fn) : fn();

/**
 * Fails OPEN (true) on a missing partner id, missing row, or non-boolean value,
 * like getServiceManagementMode: failing closed would withdraw a paid module.
 */
export async function isBillingEnabledForPartner(
  partnerId: string | null | undefined,
): Promise<boolean> {
  if (!partnerId) return true;

  const rows = await readPartnerAxis(() => db
    .select({ billingEnabled: partners.billingEnabled })
    .from(partners)
    .where(eq(partners.id, partnerId))
    .limit(1));

  const stored = rows[0]?.billingEnabled;
  return typeof stored === 'boolean' ? stored : true;
}

/**
 * Resolves the org's partner in ONE joined query. Unknown org => true, so the
 * family's own natural not-found error still applies.
 */
export async function isBillingEnabledForOrg(
  orgId: string | null | undefined,
): Promise<boolean> {
  if (!orgId) return true;

  const rows = await readPartnerAxis(() => db
    .select({ billingEnabled: partners.billingEnabled })
    .from(organizations)
    .leftJoin(partners, eq(partners.id, organizations.partnerId))
    .where(eq(organizations.id, orgId))
    .limit(1));

  const stored = rows[0]?.billingEnabled;
  return typeof stored === 'boolean' ? stored : true;
}

export async function assertBillingEnabledForPartner(
  partnerId: string | null | undefined,
  makeError: BillingDisabledErrorFactory,
): Promise<void> {
  if (!(await isBillingEnabledForPartner(partnerId))) {
    throw makeError(BILLING_DISABLED_MESSAGE, BILLING_DISABLED_STATUS, BILLING_DISABLED_CODE);
  }
}

export async function assertBillingEnabledForOrg(
  orgId: string | null | undefined,
  makeError: BillingDisabledErrorFactory,
): Promise<void> {
  if (!(await isBillingEnabledForOrg(orgId))) {
    throw makeError(BILLING_DISABLED_MESSAGE, BILLING_DISABLED_STATUS, BILLING_DISABLED_CODE);
  }
}

/** True for the `BILLING_DISABLED` error any family's constructor produces. */
export function isBillingDisabledError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === BILLING_DISABLED_CODE
  );
}

/**
 * `NOT EXISTS`-shaped predicate for fleet-wide sweeps that select org-scoped rows
 * under a system context: excludes rows whose org's partner has billing off, so
 * the sweep never selects (and never fails or alerts on) work it cannot do.
 * Fails OPEN like `isBillingEnabledForOrg` — an unknown org or a NULL flag keeps
 * the row. Exported as a builder so each call site is compiled-SQL assertable.
 * Resolves the partner through `organizations.partner_id`, the same join the
 * gates use, never a denormalized `partner_id` on the row.
 */
export function billingEnabledOrgPredicate(orgIdColumn: PgColumn): SQL {
  return sql`NOT EXISTS (
    SELECT 1 FROM ${organizations} AS billing_gate_org
      JOIN ${partners} AS billing_gate_partner ON billing_gate_partner.id = billing_gate_org.partner_id
     WHERE billing_gate_org.id = ${orgIdColumn}
       AND billing_gate_partner.billing_enabled = false
  )`;
}
