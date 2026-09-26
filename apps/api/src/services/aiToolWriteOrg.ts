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
