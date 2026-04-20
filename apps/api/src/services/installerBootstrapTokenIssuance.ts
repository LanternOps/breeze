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
  createdByUserId: string;
  maxUsage?: number;
}

export interface IssuedBootstrapToken {
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
  const expiresAt = bootstrapTokenExpiresAt();

  await db.insert(installerBootstrapTokens).values({
    token,
    orgId: parent.orgId,
    parentEnrollmentKeyId: parent.id,
    siteId: parent.siteId,
    maxUsage: input.maxUsage ?? 1,
    createdBy: input.createdByUserId,
    expiresAt,
  });

  return { token, expiresAt, parentKeyName: parent.name };
}
