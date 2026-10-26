/**
 * Deterministic order for a partner caller's `accessibleOrgIds` (#9529).
 *
 * The list is a set for authorization (`canAccessOrg`, `orgCondition`), but
 * its FIRST element is also the last-resort org of an AI chat session and the
 * default of every `getOrgId(auth)` tool helper
 * (`auth.orgId ?? auth.accessibleOrgIds[0]`). The org query had no ORDER BY,
 * so that element was whatever row the planner returned first.
 *
 * Order: customer/internal orgs before the hidden per-partner Quick Support
 * org (it holds no customer data and is absent from every org picker, so it
 * must never be anyone's default), then case-insensitive slug — the order the
 * `(partner_id, lower(slug))` index already returned in practice — then id.
 *
 * Sorted in memory rather than with ORDER BY so the query keeps its exact
 * shape: a partner reaches tens to hundreds of orgs, not thousands.
 */
export interface AccessibleOrgRow {
  id: string;
  slug?: string | null;
  type?: string | null;
}

const QUICK_SUPPORT_ORG_TYPE = 'quick_support';

function compareCodePoints(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function orderAccessibleOrgIds(rows: readonly AccessibleOrgRow[]): string[] {
  return [...rows]
    .sort((a, b) => {
      const aHidden = a.type === QUICK_SUPPORT_ORG_TYPE ? 1 : 0;
      const bHidden = b.type === QUICK_SUPPORT_ORG_TYPE ? 1 : 0;
      if (aHidden !== bHidden) return aHidden - bHidden;
      const bySlug = compareCodePoints((a.slug ?? '').toLowerCase(), (b.slug ?? '').toLowerCase());
      return bySlug !== 0 ? bySlug : compareCodePoints(a.id, b.id);
    })
    .map((row) => row.id);
}
