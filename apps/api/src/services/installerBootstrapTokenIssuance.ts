import { db } from '../db';
import { eq } from 'drizzle-orm';
import { enrollmentKeys } from '../db/schema/orgs';
import { installerBootstrapTokens } from '../db/schema/installerBootstrapTokens';
import {
  generateBootstrapToken,
  bootstrapTokenExpiresAt,
} from './installerBootstrapToken';

export interface IssueBootstrapTokenInput {
  parentEnrollmentKeyId: string;
  /**
   * Creator user id, or null when the token is issued by an unauthenticated
   * path (e.g. the public /s/:code short-link installer download) whose parent
   * enrollment key may itself have no recorded creator. The created_by column
   * is a nullable uuid FK — pass null, never an empty string (an empty string
   * fails the uuid cast: `invalid input syntax for type uuid: ""`).
   */
  createdByUserId: string | null;
  maxUsage?: number;
  installerPlatform?: "windows" | "macos";
}

export interface IssuedBootstrapToken {
  id: string;
  token: string;
  expiresAt: Date;
  parentKeyName: string;
}

export class BootstrapTokenIssuanceError extends Error {
  constructor(public code: 'parent_not_found' | 'parent_expired' | 'parent_exhausted', message: string) {
    super(message);
    this.name = 'BootstrapTokenIssuanceError';
  }
}

/**
 * Issues a single-use bootstrap token tied to an existing parent enrollment
 * key. Used by both the standalone POST /enrollment-keys/:id/bootstrap-token
 * route AND the macOS installer download route — they were two duplicate
 * code paths in Plan A; this helper unifies them.
 *
 * Caller is responsible for:
 *  - access control (ensureOrgAccess on parentKey.orgId)
 *  - audit logging
 *
 * Throws BootstrapTokenIssuanceError on parent-key validation failures so
 * the caller can map to its own HTTP shape.
 */
export async function issueBootstrapTokenForKey(
  input: IssueBootstrapTokenInput,
): Promise<IssuedBootstrapToken> {
  const [parent] = await db
    .select()
    .from(enrollmentKeys)
    .where(eq(enrollmentKeys.id, input.parentEnrollmentKeyId))
    .limit(1);
  if (!parent) {
    throw new BootstrapTokenIssuanceError('parent_not_found', 'Enrollment key not found');
  }
  if (parent.expiresAt && new Date(parent.expiresAt) < new Date()) {
    throw new BootstrapTokenIssuanceError('parent_expired', 'Enrollment key has expired');
  }
  if (parent.maxUsage !== null && parent.usageCount >= parent.maxUsage) {
    throw new BootstrapTokenIssuanceError('parent_exhausted', 'Enrollment key usage exhausted');
  }

  const token = generateBootstrapToken();
  // Bound the token's TTL by the parent's remaining lifetime. Without this
  // cap, a token could be valid for 24h on paper while the parent expires
  // 30s later — recipients would click an "active" link and get 404
  // (parent_already_expired). Bound conservatively so consume reflects the
  // real usable window.
  const baseTokenExpiry = bootstrapTokenExpiresAt();
  const expiresAt = parent.expiresAt && new Date(parent.expiresAt) < baseTokenExpiry
    ? new Date(parent.expiresAt)
    : baseTokenExpiry;

  const [row] = await db.insert(installerBootstrapTokens).values({
    token,
    orgId: parent.orgId,
    parentEnrollmentKeyId: parent.id,
    siteId: parent.siteId,
    maxUsage: input.maxUsage ?? 1,
    createdBy: input.createdByUserId,
    expiresAt,
    installerPlatform: input.installerPlatform ?? "macos",
  }).returning();
  if (!row) {
    throw new Error('installerBootstrapTokens insert returned no row');
  }

  return { id: row.id, token, expiresAt, parentKeyName: parent.name };
}
