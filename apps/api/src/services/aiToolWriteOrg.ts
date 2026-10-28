import type { AuthContext } from '../middleware/auth';

/**
 * Error returned when a write needs an owner org and the caller can reach more
 * than one, so none can be picked for them (#6667).
 */
export const WRITE_ORG_AMBIGUOUS_ERROR = 'orgId is required: you have access to multiple organizations';

/**
 * Resolve the org that OWNS a row an AI/MCP tool is about to write.
 *
 * Writes must never use `accessibleOrgIds[0]`. For a partner tech that is
 * whichever customer org sorts first, so a create without `orgId` landed in an
 * unrelated tenant (#6667). The order is:
 *
 * 1. Org-scoped token: `auth.orgId`, and an `inputOrgId` naming any other org is
 *    refused. A device-bound chat session's `toolAuth` is narrowed to this shape
 *    (`buildDeviceBoundSessionAuth`), so its anchored org resolves here.
 * 2. An explicit `inputOrgId` the caller can access.
 * 3. `auth.aiWriteDefaultOrgId`: the device-page anchor of an AI chat session
 *    (#6675), re-checked with `canAccessOrg` here, on every call. It outranks
 *    `auth.orgId` for the same reason the session anchor does (#5684): the
 *    page's device, not the org selector, says which tenant the chat is about.
 *    Reads that borrow this resolver pass `{ useWriteDefault: false }` so the
 *    default never answers a read the caller did not scope.
 * 4. `auth.orgId`, when a non-org token carries one.
 * 5. The caller's only accessible org.
 * 6. Otherwise an error asking for `orgId`. Nothing is guessed.
 *
 * Lives in this leaf module, not `aiTools.ts`, so domain tool files that
 * `aiTools.ts` itself imports can use it without a circular import.
 * `aiTools.ts` re-exports it for existing importers.
 */
export function resolveWritableToolOrgId(
  auth: AuthContext,
  inputOrgId?: string,
  options: { useWriteDefault?: boolean } = {},
): { orgId?: string; error?: string } {
  if (auth.scope === 'organization') {
    if (!auth.orgId) return { error: 'Organization context required' };
    if (inputOrgId && inputOrgId !== auth.orgId) {
      return { error: 'Cannot access another organization' };
    }
    return { orgId: auth.orgId };
  }

  if (inputOrgId) {
    if (!auth.canAccessOrg(inputOrgId)) {
      return { error: 'Access denied to this organization' };
    }
    return { orgId: inputOrgId };
  }

  const writeDefault = auth.aiWriteDefaultOrgId;
  if (options.useWriteDefault !== false && writeDefault && auth.canAccessOrg(writeDefault)) {
    return { orgId: writeDefault };
  }

  if (auth.orgId) {
    return { orgId: auth.orgId };
  }

  if (Array.isArray(auth.accessibleOrgIds) && auth.accessibleOrgIds.length === 1) {
    return { orgId: auth.accessibleOrgIds[0] };
  }

  // `null` means unrestricted (system scope, or every org under the partner).
  if (auth.accessibleOrgIds === null || auth.accessibleOrgIds.length > 1) {
    return { error: WRITE_ORG_AMBIGUOUS_ERROR };
  }

  return { error: 'orgId is required for this operation' };
}

/** Error returned when a read's bound org is outside the caller's current reach. */
const READ_ORG_DENIED_ERROR = 'Access denied to this organization';

/**
 * Error returned when a read names no org and the caller's reach is unbounded
 * (system scope): reading every tenant on the platform is never a default.
 */
export const READ_ORG_UNBOUNDED_ERROR =
  'orgId is required: you have access to every organization, so name the one to read';

/**
 * The orgs a READ-ONLY AI tool queries. `allAccessibleOrgs` is true when the
 * caller named no org and reaches more than one, so the tool can say its answer
 * covers all of them rather than one.
 */
export type ToolReadOrgScope =
  | { ok: true; orgIds: string[]; allAccessibleOrgs: boolean }
  | { ok: false; error: string };

/**
 * Resolve the orgs a read-only AI/MCP tool queries (#10396).
 *
 * Reads must never use `accessibleOrgIds[0]` either. For a partner login (no
 * `auth.orgId`) that is whichever customer org sorts first, so a partner-wide
 * session got one org's rows and presented them as the fleet. The order is:
 *
 * 1. Org-scoped token, or an explicit `inputOrgId`: one org, resolved as
 *    `resolveWritableToolOrgId` does, then re-checked with `canAccessOrg`.
 * 2. `auth.orgId`, when a non-org token carries one, re-checked the same way.
 * 3. Every org in `accessibleOrgIds`. This is the caller's own reach (the same
 *    list `auth.orgCondition` filters by, already cut to the Wisp grant
 *    ceiling), so it never widens access. The HTTP fleet routes read the same
 *    way when no org is given (GET /patches/compliance).
 * 4. Unrestricted reach (`null`, system scope): an error asking for `orgId`.
 *
 * `auth.aiWriteDefaultOrgId` is deliberately not consulted: the device-page
 * anchor picks where a write lands, and never narrows a read (#6675).
 */
export function resolveReadableToolOrgScope(
  auth: AuthContext,
  inputOrgId?: string,
): ToolReadOrgScope {
  // A bound org (org-scoped token, explicit input, or a carried `auth.orgId`)
  // is always re-checked against the CURRENT reach and refused when outside
  // it. Wisp's `narrowAuthToCeiling` / `unreachableWispAuth` spread `...auth`:
  // they cut `accessibleOrgIds` and rebuild `canAccessOrg`, but keep the
  // login's `orgId`, so trusting `auth.orgId` alone would read past the grant.
  if (auth.scope === 'organization' || inputOrgId) {
    const single = resolveWritableToolOrgId(auth, inputOrgId, { useWriteDefault: false });
    if (!single.orgId) return { ok: false, error: single.error ?? 'Organization context required' };
    if (!auth.canAccessOrg(single.orgId)) return { ok: false, error: READ_ORG_DENIED_ERROR };
    return { ok: true, orgIds: [single.orgId], allAccessibleOrgs: false };
  }

  if (auth.orgId) {
    if (!auth.canAccessOrg(auth.orgId)) return { ok: false, error: READ_ORG_DENIED_ERROR };
    return { ok: true, orgIds: [auth.orgId], allAccessibleOrgs: false };
  }

  const reach = auth.accessibleOrgIds;
  if (reach === null) {
    return { ok: false, error: READ_ORG_UNBOUNDED_ERROR };
  }
  if (!Array.isArray(reach) || reach.length === 0) {
    return { ok: false, error: 'No organization context available' };
  }
  return { ok: true, orgIds: [...reach], allAccessibleOrgs: reach.length > 1 };
}
