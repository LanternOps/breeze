/**
 * Tenant-status gate for the UNAUTHENTICATED, capability-token public link
 * surfaces (`routes/quotesPublic.ts`, `routes/invoicesPublic.ts`).
 *
 * Those routers carry no auth middleware, so every query runs under a SYSTEM
 * context — which means RLS cannot answer "is this tenant still allowed to
 * transact?" for them the way it does for a signed-in request. Org-lifecycle
 * Wave 4 makes that gap load-bearing: an `archived`/`purging` org is supposed
 * to be hidden and read-only for its whole retention window, but a durable
 * accept/pay token minted months earlier keeps working — accepting a quote
 * issues an invoice, can place a Pax8 order, and emails the customer, all
 * inside a tenant that is counting down to permanent erasure.
 *
 * So the public links gate on the CURRENT owning org's status, and every
 * non-live status refuses with 410 (reads included: an archived org's quote
 * link must read as gone, not as a live proposal).
 *
 * Merge continuity is preserved on purpose: the gate reads the status of the
 * org that owns the row TODAY. A quote whose original org merged away has
 * already been re-tenanted onto the survivor, so `resolveQuoteLinkOrgGate`
 * resolves the survivor through the same merged-org id set the routes use for
 * every other lookup, and an active survivor keeps the link working.
 */
import { and, eq, inArray } from 'drizzle-orm';
import {
  db,
  getCurrentDbAccessContext,
  runOutsideDbContext,
  withSystemDbAccessContext,
} from '../db';
import { organizations } from '../db/schema';
import { quotes } from '../db/schema/quotes';

/**
 * Statuses whose public links keep working. Deliberately the same pair
 * `isUsableOrgStatus` uses: a public link is a customer-facing transaction
 * surface, so anything that is not a fully live tenant refuses.
 *
 * NOTE this tightens `suspended`/`churned`/`offboarding` too, which previously
 * transacted through these routes. That is the intended posture — a suspended
 * or churned tenant should not be issuing invoices or taking payments — and is
 * called out as a behavior change on the PR.
 */
export const PUBLIC_LINK_LIVE_ORG_STATUSES = ['active', 'trial'] as const;

/** The single 410 body every public route returns for a non-live tenant. */
export const PUBLIC_LINK_ORG_UNAVAILABLE = {
  error: 'This link is no longer available',
  code: 'ORG_UNAVAILABLE',
} as const;

export interface PublicLinkOrgGate {
  /** The org that currently owns the linked row, or null when nothing matched. */
  orgId: string | null;
  status: string | null;
  /**
   * True ONLY when a row WAS found and its owning org is not link-live. A
   * missing row leaves the gate open so the handler's own 401/404 keeps
   * owning "this link resolves to nothing" — the gate must never turn a
   * not-found into an existence oracle with a different status code.
   */
  blocked: boolean;
}

export function isPublicLinkOrgStatusLive(status: string | null | undefined): boolean {
  return (PUBLIC_LINK_LIVE_ORG_STATUSES as readonly string[]).includes(status ?? '');
}

/** Gate for "no row resolved" — see `blocked` above. */
export const PUBLIC_LINK_ORG_GATE_OPEN: PublicLinkOrgGate = {
  orgId: null,
  status: null,
  blocked: false,
};

function toGate(orgId: string | null, status: string | null): PublicLinkOrgGate {
  return { orgId, status, blocked: orgId !== null && !isPublicLinkOrgStatusLive(status) };
}

/**
 * Read the org status as a genuine system read whatever the ambient context is
 * — same escalation shape as `services/tenantStatus.ts`'s `readAsSystem`.
 * Public routes are contextless (fresh system tx); a caller already inside a
 * system transaction (invoice settle-return) reuses it rather than pinning a
 * second pooled connection idle-in-transaction.
 */
function readAsSystem<T>(fn: () => Promise<T>): Promise<T> {
  const ambient = getCurrentDbAccessContext();
  if (ambient && ambient.scope !== 'system') {
    return runOutsideDbContext(() => withSystemDbAccessContext(fn));
  }
  return withSystemDbAccessContext(fn);
}

/**
 * One query: resolve the quote's CURRENT org (across the merge chain) and that
 * org's status together. Callers resolve this once per request and share it
 * across handlers rather than re-reading per DB touch.
 */
export async function resolveQuoteLinkOrgGate(
  quoteId: string,
  orgIds: string[],
): Promise<PublicLinkOrgGate> {
  if (orgIds.length === 0) return PUBLIC_LINK_ORG_GATE_OPEN;
  const [row] = await readAsSystem(() =>
    db
      .select({ orgId: organizations.id, status: organizations.status })
      .from(quotes)
      .innerJoin(organizations, eq(organizations.id, quotes.orgId))
      .where(and(eq(quotes.id, quoteId), inArray(quotes.orgId, orgIds)))
      .limit(1),
  );
  return toGate(row?.orgId ?? null, row?.status ?? null);
}

/** Gate for a row whose owning org id the caller already resolved. */
export async function resolveOrgLinkGate(orgId: string): Promise<PublicLinkOrgGate> {
  const [row] = await readAsSystem(() =>
    db
      .select({ id: organizations.id, status: organizations.status })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1),
  );
  return toGate(row?.id ?? null, row?.status ?? null);
}
