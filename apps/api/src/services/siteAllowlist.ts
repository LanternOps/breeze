/**
 * The one rule for reading a site allowlist (`allowedSiteIds`) — #6790.
 *
 *  - `undefined` → unrestricted (partner/system scope, or an org user with no
 *    site restriction).
 *  - an array    → the allowlist, passed through unchanged (`[]` = no sites).
 *  - anything else (a raw DB `null`, a non-array) → an EMPTY allowlist: no
 *    sites.
 *
 * The declared type is `string[] | undefined`; `permissions.ts` turns a DB
 * `null` into `undefined` before building permissions, so the third case is an
 * invariant breach. It must fail CLOSED — a truthiness check (`if (!ids)
 * return unrestricted`) would silently widen a malformed value to every site.
 *
 * Only for the `string[] | undefined` contract of `UserPermissions` /
 * `AuthContext`. Some internal option types (e.g. `filterEngine`'s
 * `EvaluateFilterOptions.allowedSiteIds`) deliberately document `null` as
 * "no site narrowing"; do not route those through here.
 *
 * Leaf module with no imports so the auth middleware, permissions service and
 * AI-tool helpers can all share it without an import cycle.
 */
export function normalizeSiteAllowlist(raw: unknown): readonly string[] | undefined {
  if (raw === undefined) return undefined;
  return Array.isArray(raw) ? (raw as string[]) : [];
}
