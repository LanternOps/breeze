/**
 * Ownership of a chunked software upload session (#11412 W01, origin #9246).
 *
 * A session mirrors the owner of the catalog row it uploads into: an
 * org-owned package books an org session, a partner-wide package (org_id
 * NULL — e.g. the built-in SentinelOne package) books a partner session. The
 * owner is always taken from the catalog row (at create) or the session row
 * (afterwards), never from the request's `?orgId`, which the dashboard
 * injects for whatever org is selected in the switcher.
 *
 * "Plan D<n>" refers to the design decisions in
 * docs/superpowers/plans/integrations/2026-11-08-partner-wide-package-upload.md.
 */
import { and, eq, isNull, type SQL } from 'drizzle-orm';
import { softwareUploadSessions } from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import { authorizeCatalogItemWrite } from './softwareCatalogOps';
import { resolveScopedOrgId } from './softwareVersionShared';

export type UploadOwner =
  | { kind: 'organization'; orgId: string }
  | { kind: 'partner'; partnerId: string };

/**
 * The owner of a catalog or session row. Both tables carry an
 * `(org_id IS NULL) <> (partner_id IS NULL)` CHECK, so the throw is
 * unreachable for a row read from the database.
 */
export function uploadOwnerOf(row: { orgId: string | null; partnerId: string | null }): UploadOwner {
  // Loose (== null) so a projection that omits a column reads as "unset".
  if (row.orgId != null && row.partnerId == null) return { kind: 'organization', orgId: row.orgId };
  if (row.orgId == null && row.partnerId != null) return { kind: 'partner', partnerId: row.partnerId };
  throw new Error('software upload owner must have exactly one of orgId / partnerId');
}

/** Insert values for software_upload_sessions' owner columns. */
export function uploadOwnerColumns(owner: UploadOwner): { orgId: string | null; partnerId: string | null } {
  return owner.kind === 'organization'
    ? { orgId: owner.orgId, partnerId: null }
    : { orgId: null, partnerId: owner.partnerId };
}

/** The software_upload_sessions rows booked under `owner` (caps, owner-scoped re-reads). */
export function uploadOwnerSessionCondition(owner: UploadOwner): SQL {
  return owner.kind === 'organization'
    ? eq(softwareUploadSessions.orgId, owner.orgId)
    : and(isNull(softwareUploadSessions.orgId), eq(softwareUploadSessions.partnerId, owner.partnerId))!;
}

/**
 * Object-storage key for an uploaded installer. Org-owned keys keep their
 * historical layout. A partner-owned version stores ONE object under the
 * partner, which every child org's deployment presigns (plan D4): the key is
 * never handed to a client, only a presigned URL minted after authorization,
 * so per-org copies would buy no isolation.
 */
export function softwarePackageObjectKey(
  owner: UploadOwner,
  catalogId: string,
  versionId: string,
  fileName: string,
): string {
  return owner.kind === 'organization'
    ? `software/${owner.orgId}/${catalogId}/${versionId}/${fileName}`
    : `software/partner/${owner.partnerId}/${catalogId}/${versionId}/${fileName}`;
}

const SESSION_NOT_FOUND = 'Upload session not found';

/**
 * Authorize a caller against a session already loaded (under RLS) by
 * `(id, catalog_id)` (plan D6). Returns null when allowed, else the response
 * to send.
 *
 * - Org session: unchanged rule — the request's resolved org (`?orgId`) must
 *   be the session's org. A resolver error (400/403) is returned as is; a
 *   mismatch answers 404, matching the don't-reveal-existence behaviour.
 * - Partner session: the partner-wide write gate (system, or a full-partner
 *   admin of the owning partner — `canManagePartnerWidePolicies` via
 *   authorizeCatalogItemWrite). `?orgId` is ignored. A foreign caller gets
 *   404; a same-partner user without `orgAccess: 'all'` gets the gate's 403.
 *   RLS alone is weaker here: breeze_has_partner_access admits every token of
 *   the partner whatever its orgAccess, so this check is load-bearing.
 */
export function authorizeUploadSessionAccess(
  auth: AuthContext,
  session: { orgId: string | null; partnerId: string | null },
  requestedOrgId: string | undefined,
): { error: string; status: 400 | 403 | 404 } | null {
  const owner = uploadOwnerOf(session);
  if (owner.kind === 'organization') {
    const scoped = resolveScopedOrgId(auth, requestedOrgId);
    if ('error' in scoped) return { error: scoped.error, status: scoped.status };
    return scoped.orgId === owner.orgId ? null : { error: SESSION_NOT_FOUND, status: 404 };
  }
  const denied = authorizeCatalogItemWrite(auth, { orgId: null, partnerId: owner.partnerId }, undefined);
  if (!denied) return null;
  return denied.status === 404 ? { error: SESSION_NOT_FOUND, status: 404 } : denied;
}
