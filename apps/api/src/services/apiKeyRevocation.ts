import { and, eq, ne } from 'drizzle-orm';
import { db } from '../db';
import { apiKeys } from '../db/schema';
import { createAuditLogAsync } from './auditService';

export interface RevokeApiKeyOptions {
  /** Row the caller already loaded; skips the lookup. Needs orgId + status. */
  existing?: { orgId: string; status: string };
  actorEmail?: string;
  /** Request-derived; a non-request caller omits both. */
  ipAddress?: string;
  userAgent?: string;
  /** Adds `reason` to the audit details. Off by default so the DELETE route's row is unchanged. */
  includeReasonInAudit?: boolean;
}

export interface RevokeApiKeyResult {
  revoked: boolean;
  /** Present only when revoked: the columns the DELETE route returns. */
  apiKey?: {
    id: string;
    name: string;
    keyPrefix: string;
    status: string;
    updatedAt: Date;
  };
}

/**
 * Soft-revoke an API key (status='revoked') and write one `api_key.revoke`
 * audit row. Idempotent: a missing or already-revoked key returns
 * `{ revoked: false }` with no write and no audit.
 *
 * Runs on the caller's current DB context (`db` is context-aware); it opens no
 * connection of its own. Authorization (org access, delegation ceiling) is the
 * caller's job and must happen before this call. The audit goes through
 * `createAuditLogAsync`, which commits outside the caller's transaction, so it
 * works identically for request and non-request callers; only the optional
 * ip/user-agent differ.
 */
export async function revokeApiKey(
  keyId: string,
  actorUserId: string,
  reason: string,
  opts: RevokeApiKeyOptions = {},
): Promise<RevokeApiKeyResult> {
  let existing = opts.existing;
  if (!existing) {
    const [found] = await db
      .select({ orgId: apiKeys.orgId, status: apiKeys.status })
      .from(apiKeys)
      .where(eq(apiKeys.id, keyId))
      .limit(1);
    existing = found;
  }
  if (!existing || existing.status === 'revoked') return { revoked: false };

  const [revoked] = await db
    .update(apiKeys)
    .set({ status: 'revoked', updatedAt: new Date() })
    .where(and(eq(apiKeys.id, keyId), ne(apiKeys.status, 'revoked')))
    .returning({
      id: apiKeys.id,
      name: apiKeys.name,
      keyPrefix: apiKeys.keyPrefix,
      status: apiKeys.status,
      updatedAt: apiKeys.updatedAt,
    });
  if (!revoked) return { revoked: false };

  void createAuditLogAsync({
    orgId: existing.orgId,
    actorId: actorUserId,
    actorEmail: opts.actorEmail,
    action: 'api_key.revoke',
    resourceType: 'api_key',
    resourceId: keyId,
    resourceName: revoked.name,
    details: {
      keyPrefix: revoked.keyPrefix,
      previousStatus: existing.status,
      ...(opts.includeReasonInAudit ? { reason } : {}),
    },
    ipAddress: opts.ipAddress,
    userAgent: opts.userAgent,
    result: 'success',
  });

  return { revoked: true, apiKey: revoked };
}
