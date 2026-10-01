/**
 * Storage keys an organization's S3 backup destinations used before backups
 * were written only through storage sessions, and the evidence that replaced
 * keys were disabled (services/backupStorageCredentialHistory.ts).
 *
 *   GET  /backup/storage-credentials                        keys still needing action
 *   POST /backup/storage-credentials/:id/check              try a replaced key (rate limited per organization)
 *   POST /backup/storage-credentials/:id/confirm-disabled   the operator confirms they disabled it (weaker evidence)
 *
 * The check route manages its own DB contexts (middleware/selfManagedDbContextRoutes.ts):
 * it reads and writes in short contexts and calls storage with none held.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '../../lib/validation';
import { requireMfa, requirePermission, requireScope, withAuthDbAccessContext } from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';
import {
  REFUSED_FOR_LISTING_CODES,
  attestCredentialDisabled,
  checkReplacedCredential,
  listOutstandingCredentials,
} from '../../services/backupStorageCredentialHistory';
import { PERMISSIONS } from '../../services/permissions';
import { rateLimiter } from '../../services/rate-limit';
import { getRedis } from '../../services/redis';
import { canMutateOrgWideGovernance, SITE_CEILING_WRITE_DENIED_MESSAGE } from '../../services/siteCeilingAccess';
import { resolveScopedOrgId } from './helpers';

export const storageCredentialRoutes = new Hono();

/** Checks of old keys per organization per window: each one is a request to the storage provider. */
export const CREDENTIAL_CHECK_LIMIT = 10;
export const CREDENTIAL_CHECK_WINDOW_SECONDS = 10 * 60;

const idParamSchema = z.object({ id: z.string().uuid() });
const confirmSchema = z.object({
  confirm: z.literal(true),
  detail: z.string().trim().max(500).optional(),
});

const CHECK_MESSAGES = {
  revoked: 'The previous key no longer works. It is recorded as disabled.',
  still_live: 'The previous key still works. Disable it with your storage provider, then check again.',
  inconclusive: 'The storage provider could not be reached to check the previous key. Try again later.',
  refused_for_listing:
    'The previous key was refused for listing, but it may still work for uploads. '
    + 'Disable it with your storage provider, then check again, or confirm that you disabled it.',
} as const;

const NOT_CHECKABLE_MESSAGES = {
  in_use: 'This key is still used by its backup destination. Replace it on the destination first.',
  already_revoked: 'This key is already recorded as disabled.',
  no_sealed_settings:
    'This key can no longer be checked automatically. Disable it with your storage provider, then confirm that you did.',
} as const;

/** `s3::<endpoint>::<bucket>` → its parts, for display. */
function describeStorage(identity: string): { endpoint: string | null; bucket: string | null } {
  const parts = identity.split('::');
  if (parts.length !== 3) return { endpoint: null, bucket: null };
  return { endpoint: parts[1] || null, bucket: parts[2] || null };
}

storageCredentialRoutes.get(
  '/storage-credentials',
  requirePermission(PERMISSIONS.BACKUP_READ.resource, PERMISSIONS.BACKUP_READ.action),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
    if (!orgId) return c.json({ error: 'orgId is required for this scope' }, 400);

    const rows = await listOutstandingCredentials(orgId);
    return c.json({
      data: rows.map((r) => ({
        id: r.id,
        configId: r.configId,
        configName: r.configName,
        ...describeStorage(r.storageIdentity),
        usedBefore: r.broadcastUntil.toISOString(),
        replacedAt: r.supersededAt ? r.supersededAt.toISOString() : null,
        canCheck: r.canCheck,
        lastCheckedAt: r.lastProbeAt ? r.lastProbeAt.toISOString() : null,
        lastCheckOutcome: r.lastProbeOutcome,
        lastCheckCode: r.lastProbeCode,
      })),
    });
  },
);

storageCredentialRoutes.post(
  '/storage-credentials/:id/check',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.BACKUP_WRITE.resource, PERMISSIONS.BACKUP_WRITE.action),
  requireMfa(),
  zValidator('param', idParamSchema),
  async (c) => {
    const auth = c.get('auth');
    if (!canMutateOrgWideGovernance(auth)) return c.json({ error: SITE_CEILING_WRITE_DENIED_MESSAGE }, 403);
    const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
    if (!orgId) return c.json({ error: 'orgId is required for this scope' }, 400);
    const { id } = c.req.valid('param');

    const result = await checkReplacedCredential({
      historyId: id,
      orgId,
      inOrg: (fn) => withAuthDbAccessContext(auth, fn),
      userId: auth.user?.id ?? null,
      // Taken only once the key is found and checkable: a check that cannot
      // run does not spend the organization's budget.
      admit: async () => {
        const limit = await rateLimiter(
          getRedis(),
          `backup-credential-check:${orgId}`,
          CREDENTIAL_CHECK_LIMIT,
          CREDENTIAL_CHECK_WINDOW_SECONDS,
          1,
          { refundOnReject: true },
        );
        return limit.allowed
          ? { allowed: true as const }
          : { allowed: false as const, retryAfterSeconds: Math.max(1, Math.ceil((limit.resetAt.getTime() - Date.now()) / 1000)) };
      },
    });
    if (result.status === 'rate_limited') {
      c.header('Retry-After', String(result.retryAfterSeconds));
      return c.json({ error: 'Too many key checks for this organization. Try again shortly.' }, 429);
    }
    if (result.status === 'not_found') return c.json({ error: 'Storage key not found' }, 404);
    if (result.status === 'not_checkable') {
      return c.json({ error: NOT_CHECKABLE_MESSAGES[result.reason], reason: result.reason }, 409);
    }

    writeRouteAudit(c, {
      orgId,
      action: 'backup.storage_credential.check',
      resourceType: 'backup_storage_credential',
      resourceId: id,
      details: { outcome: result.status },
    });
    const code = result.status === 'revoked' || result.status === 'inconclusive' ? result.code : null;
    const message = result.status === 'inconclusive' && code !== null && REFUSED_FOR_LISTING_CODES.includes(code)
      ? CHECK_MESSAGES.refused_for_listing
      : CHECK_MESSAGES[result.status];
    return c.json({ outcome: result.status, code, message });
  },
);

storageCredentialRoutes.post(
  '/storage-credentials/:id/confirm-disabled',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.BACKUP_WRITE.resource, PERMISSIONS.BACKUP_WRITE.action),
  requireMfa(),
  zValidator('param', idParamSchema),
  zValidator('json', confirmSchema),
  async (c) => {
    const auth = c.get('auth');
    if (!canMutateOrgWideGovernance(auth)) return c.json({ error: SITE_CEILING_WRITE_DENIED_MESSAGE }, 403);
    const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
    if (!orgId) return c.json({ error: 'orgId is required for this scope' }, 400);
    const { id } = c.req.valid('param');
    const { detail } = c.req.valid('json');

    const result = await attestCredentialDisabled({
      historyId: id,
      orgId,
      inOrg: (fn) => fn(),
      userId: auth.user?.id ?? null,
      evidence: 'operator_attested',
      detail: detail && detail.length > 0 ? detail : null,
    });
    if (result.status === 'not_found') return c.json({ error: 'Storage key not found' }, 404);
    if (result.status === 'not_checkable') {
      return c.json({ error: NOT_CHECKABLE_MESSAGES[result.reason], reason: result.reason }, 409);
    }

    writeRouteAudit(c, {
      orgId,
      action: 'backup.storage_credential.confirm_disabled',
      resourceType: 'backup_storage_credential',
      resourceId: id,
      details: { evidence: 'operator_attested' },
    });
    return c.json({ outcome: 'revoked' });
  },
);
