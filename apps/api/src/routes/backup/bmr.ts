import { Hono } from 'hono';
import type { AuditResult } from '@breeze/shared';
import { z } from 'zod';
import { zValidator } from '../../lib/validation';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db, runOutsideDbContext, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import {
  backupSnapshots,
  bareMetalRecoveries,
  devices,
  recoveryBootMediaArtifacts,
  recoveryMediaArtifacts,
  recoveryTokens,
  restoreJobs,
} from '../../db/schema';
import { requireMfa, requirePermission, requireScope } from '../../middleware/auth';
import { writeAuditEvent, writeRouteAudit } from '../../services/auditEvents';
import { enqueueRecoveryMediaBuild } from '../../jobs/recoveryMediaWorker';
import { enqueueRecoveryBootMediaBuild } from '../../jobs/recoveryBootMediaWorker';
import { PERMISSIONS } from '../../services/permissions';
import { getGithubReleasePageUrl } from '../../services/binarySource';
import {
  BMR_BOOTSTRAP_VERSION,
  BMR_MIN_HELPER_VERSION,
  asRecord,
  buildAuthenticatedBootstrapPayload,
  expireUnusedRecoveryTokens,
  generateRecoveryToken,
  hashRecoveryToken,
  isValidRecoveryTokenFormat,
  resolveRecoveryTokenPresentation,
  resolveServerUrl,
  resolveSnapshotProviderConfig,
  syncExpiredRecoveryMediaArtifacts,
  toIsoString,
} from '../../services/recoveryBootstrap';
import { getAuthenticatedRecoveryDownloadTarget } from '../../services/recoveryDownloadService';
import {
  createRecoveryBootMediaRequest,
  getRecoveryBootMediaArtifact,
  getRecoveryBootMediaDownloadTarget,
  listRecoveryBootMediaArtifacts,
  toRecoveryBootMediaSigningDetails,
} from '../../services/recoveryBootMediaService';
import {
  getRecoveryMediaArtifact,
  getRecoveryMediaDownloadTarget,
  getRecoveryMediaSignatureDownloadTarget,
  listRecoveryMediaArtifacts,
  normalizeRecoveryMediaStatus,
  toRecoveryMediaSigningDetails,
} from '../../services/recoveryMediaService';
import { getCurrentRecoverySigningKey, getRecoverySigningKey, getRecoverySigningKeys } from '../../services/recoverySigning';
import { getTrustedClientIp, rateLimitIpKey } from '../../services/clientIp';
import { rateLimiter } from '../../services/rate-limit';
import { getRedis } from '../../services/redis';
import { resolveScopedOrgId } from './helpers';
import {
  authorizeRouteResilienceResources,
  resolveRouteAuthorizedDeviceIds,
} from './resilienceAuthorization';
import { captureRecoveryAuthorizationSubject } from '../../services/recoveryAuthorizationSubject';
import {
  bmrAuthenticateSchema,
  bmrBootMediaCreateSchema,
  bmrBootMediaListSchema,
  bmrCompleteSchema,
  bmrCreateTokenSchema,
  bmrMediaCreateSchema,
  bmrMediaListSchema,
  bmrTokenListSchema,
} from './schemas';

export const bmrRoutes = new Hono();
export const bmrPublicRoutes = new Hono();

const idParamSchema = z.object({ id: z.string().guid() });
const signingKeyParamSchema = z.object({ id: z.string().min(1) });
const BMR_AUTHENTICATE_TOKEN_LIMIT = 3;
const BMR_AUTHENTICATE_TOKEN_WINDOW_SECONDS = 60 * 60;
// D13: getAuthenticatedRecoveryDownloadTarget is fetched ONE OBJECT PER FILE, so
// a legitimate bare-metal recovery of a 10,000+-file snapshot makes that many
// requests against this per-token limit in the course of a normal restore — a
// 10,047-file recovery hit 429 after ~134 objects at the old 100/minute limit.
// Every request here is already authenticated (a valid, unrevoked recovery
// token) and path-scoped to that one token's own snapshot by
// getAuthenticatedRecoveryDownloadTarget, so the residual abuse case is a
// stolen token brute-forcing paths within that same snapshot — a case the path
// scoping already bounds regardless of how high this request-rate ceiling is.
// 10,000/minute comfortably covers the largest recoveries seen while still
// bounding runaway retry loops; the per-IP limiter (enforcePublicRateLimit,
// used by authenticate/complete) is unchanged.
const BMR_DOWNLOAD_TOKEN_LIMIT = 10_000;
const BMR_DOWNLOAD_TOKEN_WINDOW_SECONDS = 60;
const recoveryDownloadQuerySchema = z.object({
  token: z.string().min(1).optional(),
  path: z.string().min(1).max(4096),
});

async function resolveAllowedSnapshotIds(orgId: string, allowedDeviceIds: string[]): Promise<string[]> {
  if (allowedDeviceIds.length === 0) return [];
  const snapshots = await db
    .select({ id: backupSnapshots.id })
    .from(backupSnapshots)
    .where(and(eq(backupSnapshots.orgId, orgId), inArray(backupSnapshots.deviceId, allowedDeviceIds)));
  return snapshots.map((snapshot) => snapshot.id);
}

type RecoveryDownloadTokenSource = 'query' | 'authorization' | 'x-recovery-token' | 'missing';

function getSessionStatus(row: {
  status: string;
  authenticatedAt?: Date | null;
  usedAt?: Date | null;
  completedAt?: Date | null;
}) {
  if (row.status === 'revoked' || row.status === 'expired') return row.status;
  if (row.completedAt || row.status === 'used') return 'completed';
  if (row.status === 'authenticated' || row.authenticatedAt || row.usedAt) return 'authenticated';
  return 'pending';
}

export function toTokenSummary(row: {
  id: string;
  deviceId: string;
  // Nullable since 2026-10-15-140004 (D17): a recovery token outlives its
  // snapshot's retention deletion (ON DELETE SET NULL), so an old/terminal
  // token can legitimately report snapshotId: null here.
  snapshotId: string | null;
  restoreType: string;
  status: string;
  createdAt: Date;
  expiresAt: Date;
  authenticatedAt?: Date | null;
  completedAt?: Date | null;
  usedAt?: Date | null;
}) {
  return {
    id: row.id,
    deviceId: row.deviceId,
    snapshotId: row.snapshotId,
    restoreType: row.restoreType,
    status: row.status,
    sessionStatus: getSessionStatus(row),
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    authenticatedAt: row.authenticatedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    usedAt: row.usedAt?.toISOString() ?? null,
  };
}

function extractBearerToken(headerValue: string | null | undefined): string | null {
  if (!headerValue) return null;
  const trimmed = headerValue.trim();
  if (!trimmed) return null;
  const bearerMatch = /^Bearer\s+(.+)$/i.exec(trimmed);
  return bearerMatch ? bearerMatch[1]!.trim() : null;
}

function resolveRecoveryDownloadToken(c: any, queryToken?: string | null): { token: string | null; source: RecoveryDownloadTokenSource } {
  const authHeader = extractBearerToken(c.req.header('authorization'));
  if (authHeader) {
    return { token: authHeader, source: 'authorization' };
  }

  const headerToken = c.req.header('x-recovery-token')?.trim();
  if (headerToken) {
    return { token: headerToken, source: 'x-recovery-token' };
  }

  if (queryToken && queryToken.trim()) {
    return { token: queryToken.trim(), source: 'query' };
  }

  return { token: null, source: 'missing' };
}

function allowRecoveryQueryToken(): boolean {
  const value = process.env.BMR_RECOVERY_ALLOW_QUERY_TOKEN?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

function writeRecoveryDownloadAudit(
  c: any,
  params: {
    orgId: string | null;
    result: AuditResult;
    resourceId?: string | null;
    snapshotId?: string | null;
    path?: string;
    tokenSource: RecoveryDownloadTokenSource;
    statusCode?: number;
    reason?: string;
    providerType?: string | null;
    transferType?: 'redirect' | 'stream';
  }
) {
  writeAuditEvent(c, {
    orgId: params.orgId,
    action: 'bmr.recovery.download',
    resourceType: 'recovery_token',
    resourceId: params.resourceId ?? null,
    details: {
      snapshotId: params.snapshotId ?? null,
      path: params.path ?? null,
      tokenSource: params.tokenSource,
      statusCode: params.statusCode ?? null,
      reason: params.reason ?? null,
      providerType: params.providerType ?? null,
      transferType: params.transferType ?? null,
    },
    result: params.result,
    errorMessage: params.reason ?? undefined,
  });
}

function toMediaResponse(row: {
  id: string;
  tokenId: string;
  snapshotId: string;
  platform: string;
  architecture: string;
  status: string;
  checksumSha256: string | null;
  signatureFormat?: string | null;
  signingKeyId?: string | null;
  signedAt?: Date | null;
  metadata: unknown;
  createdAt: Date;
  completedAt: Date | null;
  tokenStatus?: string | null;
}) {
  const effectiveStatus = normalizeRecoveryMediaStatus(row);
  const signing = toRecoveryMediaSigningDetails(row);
  return {
    id: row.id,
    tokenId: row.tokenId,
    snapshotId: row.snapshotId,
    platform: row.platform,
    architecture: row.architecture,
    status: effectiveStatus,
    checksumSha256: row.checksumSha256,
    signatureFormat: signing.signatureFormat,
    signingKeyId: signing.signingKeyId,
    signedAt: signing.signedAt,
    publicKey: signing.publicKey,
    publicKeyPath: signing.publicKeyPath,
    metadata: asRecord(row.metadata),
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    downloadPath:
      effectiveStatus === 'ready_signed' || effectiveStatus === 'legacy_unsigned'
        ? `/api/v1/backup/bmr/media/${row.id}/download`
        : null,
    signatureDownloadPath:
      effectiveStatus === 'ready_signed' ? `/api/v1/backup/bmr/media/${row.id}/signature` : null,
  };
}

function toBootMediaResponse(row: {
  id: string;
  tokenId: string;
  snapshotId: string;
  bundleArtifactId: string;
  platform: string;
  architecture: string;
  mediaType: string;
  status: string;
  checksumSha256: string | null;
  signatureFormat?: string | null;
  signingKeyId?: string | null;
  signedAt?: Date | null;
  metadata: unknown;
  createdAt: Date;
  completedAt: Date | null;
  tokenStatus?: string | null;
}) {
  const effectiveStatus =
    row.tokenStatus === 'revoked' || row.tokenStatus === 'expired' || row.tokenStatus === 'used'
      ? 'expired'
      : row.status;
  const signing = toRecoveryBootMediaSigningDetails(row);
  return {
    id: row.id,
    tokenId: row.tokenId,
    snapshotId: row.snapshotId,
    bundleArtifactId: row.bundleArtifactId,
    platform: row.platform,
    architecture: row.architecture,
    mediaType: row.mediaType,
    status: effectiveStatus,
    checksumSha256: row.checksumSha256,
    signatureFormat: signing.signatureFormat,
    signingKeyId: signing.signingKeyId,
    signedAt: signing.signedAt,
    publicKey: signing.publicKey,
    publicKeyPath: signing.publicKeyPath,
    metadata: asRecord(row.metadata),
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    downloadPath:
      effectiveStatus === 'ready_signed' ? `/api/v1/backup/bmr/boot-media/${row.id}/download` : null,
    signatureDownloadPath:
      effectiveStatus === 'ready_signed' ? `/api/v1/backup/bmr/boot-media/${row.id}/signature` : null,
  };
}

function toDownloadStreamResponse(
  target: {
    stream: NodeJS.ReadableStream & { destroy(): void };
    fileName: string;
    contentLength: number;
  },
  contentType: string
) {
  const webStream = new ReadableStream({
    start(controller) {
      target.stream.on('data', (chunk: string | Buffer) => {
        const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        controller.enqueue(new Uint8Array(bytes));
      });
      target.stream.on('end', () => controller.close());
      target.stream.on('error', (error) => controller.error(error));
    },
    cancel() {
      target.stream.destroy();
    },
  });

  return new Response(webStream, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${target.fileName}"`,
      'Content-Length': String(target.contentLength),
      'Cache-Control': 'no-cache',
    },
  });
}

async function expireTokenArtifacts(orgId: string) {
  await expireUnusedRecoveryTokens();
  await syncExpiredRecoveryMediaArtifacts(orgId);
}

// D9 — the public, token-authenticated recovery routes below (bmrPublicRoutes,
// mounted BEFORE authMiddleware in routes/backup/index.ts) have no ambient DB
// access context: the caller presents an opaque bearer token, not a JWT, so
// there is no org to scope to until the token row itself has been looked up.
// That initial lookup is therefore done inside `withSystemDbAccessContext`
// (see each handler below) — but everything AFTER the row is found (snapshot,
// device, provider-config, and any writes back to the token row) must run
// scoped to THAT token's own org, never left at system scope. This mirrors
// `runInOrg` in routes/backup/restore.ts, including the defensive
// `runOutsideDbContext` wrap: these routes have no ambient context in
// production, but the wrap keeps this helper safe to reuse even if that ever
// changes.
export function runInRecoveryOrgContext<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
  return runOutsideDbContext(() =>
    withDbAccessContext({ scope: 'organization', orgId, accessibleOrgIds: [orgId] }, fn)
  );
}

export async function enforcePublicRateLimit(
  c: any,
  action: 'authenticate' | 'complete' | 'exchange',
  limit: number
) {
  const ip = getTrustedClientIp(c);
  const rateCheck = await rateLimiter(getRedis(), `bmr:${action}:${rateLimitIpKey(ip)}`, limit, 60);
  if (rateCheck.allowed) return null;

  const retryAfter = Math.max(1, Math.ceil((rateCheck.resetAt.getTime() - Date.now()) / 1000));
  c.header('Retry-After', String(retryAfter));
  return c.json({ error: 'Rate limit exceeded. Please wait before retrying.' }, 429);
}

export async function enforceTokenRateLimit(
  c: any,
  action: 'authenticate' | 'download' | 'exchange' | 'progress',
  tokenHash: string,
  limit: number,
  windowSeconds: number
) {
  const rateCheck = await rateLimiter(getRedis(), `bmr:${action}:token:${tokenHash}`, limit, windowSeconds);
  if (rateCheck.allowed) return null;

  const retryAfter = Math.max(1, Math.ceil((rateCheck.resetAt.getTime() - Date.now()) / 1000));
  c.header('Retry-After', String(retryAfter));
  return c.json({ error: 'Rate limit exceeded. Please wait before retrying.' }, 429);
}

function isDownloadableRecoveryTokenStatus(status: string, authenticatedAt?: Date | null): boolean {
  return status === 'authenticated' || (status === 'active' && Boolean(authenticatedAt));
}

bmrRoutes.get(
  '/bmr/tokens',
  requirePermission(PERMISSIONS.BACKUP_READ.resource, PERMISSIONS.BACKUP_READ.action),
  zValidator('query', bmrTokenListSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
    if (!orgId) {
      return c.json({ error: 'orgId is required for this scope' }, 400);
    }

    const query = c.req.valid('query');
    const allowedDeviceIds = await resolveRouteAuthorizedDeviceIds(c, orgId);
    if (query.deviceId && allowedDeviceIds && !allowedDeviceIds.includes(query.deviceId)) {
      return c.json({ error: 'site_access_denied' }, 403);
    }
    if (allowedDeviceIds && allowedDeviceIds.length === 0) {
      return c.json({
        data: [],
        pagination: {
          limit: query.limit,
          offset: query.offset,
          count: 0,
        },
      });
    }
    const allowedSnapshotIds = allowedDeviceIds ? await resolveAllowedSnapshotIds(orgId, allowedDeviceIds) : null;
    if (query.snapshotId && allowedSnapshotIds && !allowedSnapshotIds.includes(query.snapshotId)) {
      return c.json({ error: 'site_access_denied' }, 403);
    }
    if (allowedSnapshotIds && allowedSnapshotIds.length === 0) {
      return c.json({
        data: [],
        pagination: {
          limit: query.limit,
          offset: query.offset,
          count: 0,
        },
      });
    }
    await expireTokenArtifacts(orgId);

    const rows = await db
      .select({
        id: recoveryTokens.id,
        deviceId: recoveryTokens.deviceId,
        snapshotId: recoveryTokens.snapshotId,
        restoreType: recoveryTokens.restoreType,
        status: recoveryTokens.status,
        createdAt: recoveryTokens.createdAt,
        expiresAt: recoveryTokens.expiresAt,
        authenticatedAt: recoveryTokens.authenticatedAt,
        completedAt: recoveryTokens.completedAt,
        usedAt: recoveryTokens.usedAt,
      })
      .from(recoveryTokens)
      .where(
        and(
          eq(recoveryTokens.orgId, orgId),
          query.status ? eq(recoveryTokens.status, query.status) : undefined,
          query.deviceId ? eq(recoveryTokens.deviceId, query.deviceId) : undefined,
          query.snapshotId ? eq(recoveryTokens.snapshotId, query.snapshotId) : undefined,
          allowedDeviceIds ? inArray(recoveryTokens.deviceId, allowedDeviceIds) : undefined,
          allowedSnapshotIds ? inArray(recoveryTokens.snapshotId, allowedSnapshotIds) : undefined
        )
      )
      .orderBy(desc(recoveryTokens.createdAt), desc(recoveryTokens.id))
      .limit(query.limit)
      .offset(query.offset);

    return c.json({
      data: rows.map(toTokenSummary),
      pagination: {
        limit: query.limit,
        offset: query.offset,
        count: rows.length,
      },
    });
  }
);

bmrRoutes.post(
  '/bmr/tokens',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.BACKUP_WRITE.resource, PERMISSIONS.BACKUP_WRITE.action),
  requireMfa(),
  zValidator('json', bmrCreateTokenSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
    if (!orgId) {
      return c.json({ error: 'orgId is required for this scope' }, 400);
    }

    const payload = c.req.valid('json');
    const authorization = await authorizeRouteResilienceResources(c, orgId, [
      { kind: 'snapshot', id: payload.snapshotId, role: 'source' },
    ], 'token');
    if (!authorization.ok) return authorization.response;

    const [snapshot] = await db
      .select()
      .from(backupSnapshots)
      .where(and(eq(backupSnapshots.id, payload.snapshotId), eq(backupSnapshots.orgId, orgId)))
      .limit(1);

    if (!snapshot) {
      return c.json({ error: 'Snapshot not found' }, 404);
    }

    const plainToken = generateRecoveryToken();
    const tokenHash = hashRecoveryToken(plainToken);
    const expiresAt = new Date(Date.now() + payload.expiresInHours * 60 * 60 * 1000);

    const [row] = await db
      .insert(recoveryTokens)
      .values({
        orgId,
        deviceId: snapshot.deviceId,
        snapshotId: snapshot.id,
        tokenHash,
        restoreType: payload.restoreType,
        targetConfig: payload.targetConfig ?? null,
        status: 'active',
        createdBy: auth.user?.id ?? null,
        expiresAt,
      })
      .returning();

    if (!row) {
      return c.json({ error: 'Failed to create recovery token' }, 500);
    }

    const serverUrl = resolveServerUrl(c.req.url);

    writeRouteAudit(c, {
      orgId,
      action: 'bmr.token.create',
      resourceType: 'recovery_token',
      resourceId: row.id,
      details: {
        snapshotId: snapshot.id,
        deviceId: snapshot.deviceId,
        restoreType: payload.restoreType,
      },
    });

    return c.json(
      {
        ...toTokenSummary(row),
        token: plainToken,
        bootstrap: {
          version: BMR_BOOTSTRAP_VERSION,
          minHelperVersion: BMR_MIN_HELPER_VERSION,
          serverUrl,
          releaseUrl: getGithubReleasePageUrl(),
          command: `breeze-backup bmr-recover --token ${plainToken} --server "${serverUrl}"`,
          commandTemplate: `breeze-backup bmr-recover --token <recovery-token> --server "${serverUrl}"`,
          prerequisites: [
            'Boot the target machine into a compatible recovery environment.',
            'Download the current breeze-backup helper before starting recovery.',
            'Ensure the environment can reach the Breeze server and backup storage.',
            'Have storage or network drivers ready if the target hardware needs them.',
          ],
        },
      },
      201
    );
  }
);

bmrRoutes.get(
  '/bmr/tokens/:id',
  requirePermission(PERMISSIONS.BACKUP_READ.resource, PERMISSIONS.BACKUP_READ.action),
  zValidator('param', idParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
    if (!orgId) {
      return c.json({ error: 'orgId is required for this scope' }, 400);
    }

    const { id } = c.req.valid('param');
    const authorization = await authorizeRouteResilienceResources(c, orgId, [
      { kind: 'recovery_token', id, role: 'source' },
      { kind: 'recovery_token', id, role: 'target' },
    ], 'read');
    if (!authorization.ok) return authorization.response;
    await expireTokenArtifacts(orgId);

    const payload = await resolveRecoveryTokenPresentation(orgId, id, c.req.url);
    if (!payload) {
      return c.json({ error: 'Recovery token not found' }, 404);
    }

    return c.json(payload);
  }
);

bmrRoutes.delete(
  '/bmr/tokens/:id',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.BACKUP_WRITE.resource, PERMISSIONS.BACKUP_WRITE.action),
  requireMfa(),
  zValidator('param', idParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
    if (!orgId) {
      return c.json({ error: 'orgId is required for this scope' }, 400);
    }

    const { id } = c.req.valid('param');
    const authorization = await authorizeRouteResilienceResources(c, orgId, [
      { kind: 'recovery_token', id, role: 'source' },
      { kind: 'recovery_token', id, role: 'target' },
    ], 'revoke');
    if (!authorization.ok) return authorization.response;

    const [row] = await db
      .update(recoveryTokens)
      .set({ status: 'revoked' })
      .where(and(eq(recoveryTokens.id, id), eq(recoveryTokens.orgId, orgId)))
      .returning({ id: recoveryTokens.id });

    if (!row) {
      return c.json({ error: 'Recovery token not found' }, 404);
    }

    await db
      .update(recoveryMediaArtifacts)
      .set({ status: 'expired' })
      .where(eq(recoveryMediaArtifacts.tokenId, row.id));
    await db
      .update(recoveryBootMediaArtifacts)
      .set({ status: 'expired' })
      .where(eq(recoveryBootMediaArtifacts.tokenId, row.id));

    writeRouteAudit(c, {
      orgId,
      action: 'bmr.token.revoke',
      resourceType: 'recovery_token',
      resourceId: row.id,
    });

    return c.json({ id: row.id, status: 'revoked' });
  }
);

bmrRoutes.get(
  '/bmr/signing-key',
  requirePermission(PERMISSIONS.BACKUP_READ.resource, PERMISSIONS.BACKUP_READ.action),
  async (c) => {
    const key = getCurrentRecoverySigningKey();
    if (!key) {
      return c.json({ error: 'Recovery signing key not found' }, 404);
    }
    return c.json(key);
  }
);

bmrRoutes.get(
  '/bmr/signing-keys',
  requirePermission(PERMISSIONS.BACKUP_READ.resource, PERMISSIONS.BACKUP_READ.action),
  async (c) => {
    return c.json({ data: getRecoverySigningKeys() });
  }
);

bmrRoutes.get(
  '/bmr/signing-keys/:id',
  requirePermission(PERMISSIONS.BACKUP_READ.resource, PERMISSIONS.BACKUP_READ.action),
  zValidator('param', signingKeyParamSchema),
  async (c) => {
    const { id } = c.req.valid('param');
    const key = getRecoverySigningKey(id);
    if (!key) {
      return c.json({ error: 'Recovery signing key not found' }, 404);
    }
    return c.json(key);
  }
);

bmrRoutes.get(
  '/bmr/media',
  requirePermission(PERMISSIONS.BACKUP_READ.resource, PERMISSIONS.BACKUP_READ.action),
  zValidator('query', bmrMediaListSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
    if (!orgId) {
      return c.json({ error: 'orgId is required for this scope' }, 400);
    }

    const query = c.req.valid('query');
    const authorizedDeviceIds = await resolveRouteAuthorizedDeviceIds(c, orgId);
    if (authorizedDeviceIds && authorizedDeviceIds.length === 0) {
      return c.json({ data: [], pagination: { limit: query.limit, offset: query.offset, count: 0 } });
    }
    await expireTokenArtifacts(orgId);
    const rows = await listRecoveryMediaArtifacts(orgId, { ...query, authorizedDeviceIds });
    return c.json({
      data: rows.map(toMediaResponse),
      pagination: {
        limit: query.limit,
        offset: query.offset,
        count: rows.length,
      },
    });
  }
);

bmrRoutes.post(
  '/bmr/media',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.BACKUP_WRITE.resource, PERMISSIONS.BACKUP_WRITE.action),
  requireMfa(),
  zValidator('json', bmrMediaCreateSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
    if (!orgId) {
      return c.json({ error: 'orgId is required for this scope' }, 400);
    }

    const payload = c.req.valid('json');
    const authorization = await authorizeRouteResilienceResources(c, orgId, [
      { kind: 'recovery_token', id: payload.tokenId, role: 'source' },
      { kind: 'recovery_token', id: payload.tokenId, role: 'target' },
    ], 'media');
    if (!authorization.ok) return authorization.response;
    await expireTokenArtifacts(orgId);

    const [token] = await db
      .select()
      .from(recoveryTokens)
      .where(and(eq(recoveryTokens.id, payload.tokenId), eq(recoveryTokens.orgId, orgId)))
      .limit(1);

    if (!token) {
      return c.json({ error: 'Recovery token not found' }, 404);
    }
    if (token.status !== 'active') {
      return c.json({ error: `Recovery token is ${token.status}` }, 409);
    }
    // D17 (2026-10-15-140004): recovery_tokens.snapshot_id is now ON DELETE
    // SET NULL, so a still-active token can point at a snapshot that
    // retention already deleted. There is nothing left to build media for.
    // Captured into a local so the narrowing survives the db.transaction
    // closure below — TS drops property narrowing across function
    // boundaries.
    const tokenSnapshotId = token.snapshotId;
    if (!tokenSnapshotId) {
      return c.json({ error: 'Recovery token\'s snapshot no longer exists (retention expiry)' }, 409);
    }

    const [existing] = await db
      .select()
      .from(recoveryMediaArtifacts)
      .where(
        and(
          eq(recoveryMediaArtifacts.tokenId, token.id),
          eq(recoveryMediaArtifacts.platform, payload.platform),
          eq(recoveryMediaArtifacts.architecture, payload.architecture)
        )
      )
      .limit(1);

    if (existing) {
      const existingStatus = normalizeRecoveryMediaStatus({ ...existing, tokenStatus: token.status });
      if (existingStatus === 'pending' || existingStatus === 'building') {
        return c.json(toMediaResponse({ ...existing, tokenStatus: token.status }), 202);
      }
      if (existingStatus === 'ready_signed' || existingStatus === 'legacy_unsigned') {
        return c.json(toMediaResponse({ ...existing, tokenStatus: token.status }), 200);
      }

      const subject = await captureRecoveryAuthorizationSubject(auth, orgId, 'media');
      const reset = await db.transaction(async (tx) => {
        const [row] = await tx.update(recoveryMediaArtifacts).set({
          status: 'pending',
          storageKey: null,
          checksumSha256: null,
          checksumStorageKey: null,
          signatureFormat: null,
          signatureStorageKey: null,
          signingKeyId: null,
          signedAt: null,
          metadata: {
            ...asRecord(existing.metadata),
            restartedAt: new Date().toISOString(),
          },
          completedAt: null,
          ...subject,
        })
        .where(eq(recoveryMediaArtifacts.id, existing.id))
        .returning();
        return row!;
      });

      await enqueueRecoveryMediaBuild(reset.id);
      return c.json(toMediaResponse({ ...reset, tokenStatus: token.status }), 202);
    }

    const subject = await captureRecoveryAuthorizationSubject(auth, orgId, 'media');
    const row = await db.transaction(async (tx) => {
      const [created] = await tx.insert(recoveryMediaArtifacts).values({
        orgId,
        tokenId: token.id,
        snapshotId: tokenSnapshotId,
        platform: payload.platform,
        architecture: payload.architecture,
        status: 'pending',
        metadata: {
          requestedBy: auth.user?.id ?? null,
          requestedAt: new Date().toISOString(),
        },
        createdBy: auth.user?.id ?? null,
        ...subject,
      })
      .returning();
      return created;
    });

    if (!row) {
      return c.json({ error: 'Failed to create recovery media job' }, 500);
    }

    await enqueueRecoveryMediaBuild(row.id);

    writeRouteAudit(c, {
      orgId,
      action: 'bmr.media.create',
      resourceType: 'recovery_media_artifact',
      resourceId: row.id,
      details: {
        tokenId: token.id,
        snapshotId: token.snapshotId,
        platform: row.platform,
        architecture: row.architecture,
      },
    });

    return c.json(toMediaResponse({ ...row, tokenStatus: token.status }), 202);
  }
);

bmrRoutes.get(
  '/bmr/media/:id',
  requirePermission(PERMISSIONS.BACKUP_READ.resource, PERMISSIONS.BACKUP_READ.action),
  zValidator('param', idParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
    if (!orgId) {
      return c.json({ error: 'orgId is required for this scope' }, 400);
    }

    const { id } = c.req.valid('param');
    const authorization = await authorizeRouteResilienceResources(c, orgId, [
      { kind: 'media_artifact', id, role: 'source' },
      { kind: 'media_artifact', id, role: 'target' },
    ], 'read');
    if (!authorization.ok) return authorization.response;
    await expireTokenArtifacts(orgId);
    const row = await getRecoveryMediaArtifact(orgId, id);
    if (!row) {
      return c.json({ error: 'Recovery media artifact not found' }, 404);
    }
    return c.json(toMediaResponse(row));
  }
);

bmrRoutes.get(
  '/bmr/media/:id/download',
  requirePermission(PERMISSIONS.BACKUP_READ.resource, PERMISSIONS.BACKUP_READ.action),
  zValidator('param', idParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
    if (!orgId) {
      return c.json({ error: 'orgId is required for this scope' }, 400);
    }

    const { id } = c.req.valid('param');
    const authorization = await authorizeRouteResilienceResources(c, orgId, [
      { kind: 'media_artifact', id, role: 'source' },
      { kind: 'media_artifact', id, role: 'target' },
    ], 'media');
    if (!authorization.ok) return authorization.response;
    await expireTokenArtifacts(orgId);
    const target = await getRecoveryMediaDownloadTarget(orgId, id);
    if (!target) {
      return c.json({ error: 'Recovery media artifact not found' }, 404);
    }
    if (target.unavailable) {
      return c.json({ error: 'Recovery media artifact is no longer available' }, 410);
    }

    writeRouteAudit(c, {
      orgId,
      action: 'bmr.media.download',
      resourceType: 'recovery_media_artifact',
      resourceId: id,
    });

    if (target.type === 'redirect') {
      return c.redirect(target.url, 302);
    }

    return toDownloadStreamResponse(target, 'application/gzip');
  }
);

bmrRoutes.get(
  '/bmr/media/:id/signature',
  requirePermission(PERMISSIONS.BACKUP_READ.resource, PERMISSIONS.BACKUP_READ.action),
  zValidator('param', idParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
    if (!orgId) {
      return c.json({ error: 'orgId is required for this scope' }, 400);
    }

    const { id } = c.req.valid('param');
    const authorization = await authorizeRouteResilienceResources(c, orgId, [
      { kind: 'media_artifact', id, role: 'source' },
      { kind: 'media_artifact', id, role: 'target' },
    ], 'media');
    if (!authorization.ok) return authorization.response;
    await expireTokenArtifacts(orgId);
    const target = await getRecoveryMediaSignatureDownloadTarget(orgId, id);
    if (!target) {
      return c.json({ error: 'Recovery media artifact not found' }, 404);
    }
    if (target.unavailable) {
      return c.json({ error: 'Recovery media signature is not available' }, 410);
    }

    writeRouteAudit(c, {
      orgId,
      action: 'bmr.media.signature.download',
      resourceType: 'recovery_media_artifact',
      resourceId: id,
    });

    if (target.type === 'redirect') {
      return c.redirect(target.url, 302);
    }

    return toDownloadStreamResponse(target, 'application/octet-stream');
  }
);

bmrRoutes.get(
  '/bmr/boot-media',
  requirePermission(PERMISSIONS.BACKUP_READ.resource, PERMISSIONS.BACKUP_READ.action),
  zValidator('query', bmrBootMediaListSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
    if (!orgId) {
      return c.json({ error: 'orgId is required for this scope' }, 400);
    }

    const query = c.req.valid('query');
    const authorizedDeviceIds = await resolveRouteAuthorizedDeviceIds(c, orgId);
    if (authorizedDeviceIds && authorizedDeviceIds.length === 0) {
      return c.json({ data: [], pagination: { limit: query.limit, offset: query.offset, count: 0 } });
    }
    await expireTokenArtifacts(orgId);
    const rows = await listRecoveryBootMediaArtifacts(orgId, { ...query, authorizedDeviceIds });
    return c.json({
      data: rows.map(toBootMediaResponse),
      pagination: {
        limit: query.limit,
        offset: query.offset,
        count: rows.length,
      },
    });
  }
);

bmrRoutes.post(
  '/bmr/boot-media',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.BACKUP_WRITE.resource, PERMISSIONS.BACKUP_WRITE.action),
  requireMfa(),
  zValidator('json', bmrBootMediaCreateSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
    if (!orgId) {
      return c.json({ error: 'orgId is required for this scope' }, 400);
    }

    const payload = c.req.valid('json');
    const authorization = await authorizeRouteResilienceResources(c, orgId, [
      { kind: 'recovery_token', id: payload.tokenId, role: 'source' },
      { kind: 'recovery_token', id: payload.tokenId, role: 'target' },
    ], 'media');
    if (!authorization.ok) return authorization.response;
    await expireTokenArtifacts(orgId);

    const [token] = await db
      .select()
      .from(recoveryTokens)
      .where(and(eq(recoveryTokens.id, payload.tokenId), eq(recoveryTokens.orgId, orgId)))
      .limit(1);

    if (!token) {
      return c.json({ error: 'Recovery token not found' }, 404);
    }
    if (token.status !== 'active') {
      return c.json({ error: `Recovery token is ${token.status}` }, 409);
    }

    let row;
    try {
      row = await createRecoveryBootMediaRequest({
        orgId,
        tokenId: token.id,
        auth,
        createdBy: auth.user?.id ?? null,
        bundleArtifactId: payload.bundleArtifactId ?? null,
      });
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : 'Failed to create boot media request' },
        409
      );
    }

    const responseStatus =
      row.status === 'pending' || row.status === 'building' ? 202 : row.status === 'ready_signed' ? 200 : 202;
    if (row.status === 'pending') {
      await enqueueRecoveryBootMediaBuild(row.id);
    }

    writeRouteAudit(c, {
      orgId,
      action: 'bmr.boot_media.create',
      resourceType: 'recovery_boot_media_artifact',
      resourceId: row.id,
      details: {
        tokenId: token.id,
        snapshotId: token.snapshotId,
        platform: row.platform,
        architecture: row.architecture,
        mediaType: row.mediaType,
      },
    });

    return c.json(toBootMediaResponse({ ...row, tokenStatus: token.status }), responseStatus);
  }
);

bmrRoutes.get(
  '/bmr/boot-media/:id',
  requirePermission(PERMISSIONS.BACKUP_READ.resource, PERMISSIONS.BACKUP_READ.action),
  zValidator('param', idParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
    if (!orgId) {
      return c.json({ error: 'orgId is required for this scope' }, 400);
    }

    const { id } = c.req.valid('param');
    const authorization = await authorizeRouteResilienceResources(c, orgId, [
      { kind: 'boot_media_artifact', id, role: 'source' },
      { kind: 'boot_media_artifact', id, role: 'target' },
    ], 'read');
    if (!authorization.ok) return authorization.response;
    await expireTokenArtifacts(orgId);
    const row = await getRecoveryBootMediaArtifact(orgId, id);
    if (!row) {
      return c.json({ error: 'Recovery boot media artifact not found' }, 404);
    }
    return c.json(toBootMediaResponse(row));
  }
);

bmrRoutes.get(
  '/bmr/boot-media/:id/download',
  requirePermission(PERMISSIONS.BACKUP_READ.resource, PERMISSIONS.BACKUP_READ.action),
  zValidator('param', idParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
    if (!orgId) {
      return c.json({ error: 'orgId is required for this scope' }, 400);
    }

    const { id } = c.req.valid('param');
    const authorization = await authorizeRouteResilienceResources(c, orgId, [
      { kind: 'boot_media_artifact', id, role: 'source' },
      { kind: 'boot_media_artifact', id, role: 'target' },
    ], 'media');
    if (!authorization.ok) return authorization.response;
    await expireTokenArtifacts(orgId);
    const target = await getRecoveryBootMediaDownloadTarget(orgId, id);
    if (!target) {
      return c.json({ error: 'Recovery boot media artifact not found' }, 404);
    }
    if (target.unavailable) {
      return c.json({ error: 'Recovery boot media artifact is no longer available' }, 410);
    }

    writeRouteAudit(c, {
      orgId,
      action: 'bmr.boot_media.download',
      resourceType: 'recovery_boot_media_artifact',
      resourceId: id,
    });

    if (target.type === 'redirect') {
      return c.redirect(target.url, 302);
    }

    return toDownloadStreamResponse(target, 'application/x-iso9660-image');
  }
);

bmrRoutes.get(
  '/bmr/boot-media/:id/signature',
  requirePermission(PERMISSIONS.BACKUP_READ.resource, PERMISSIONS.BACKUP_READ.action),
  zValidator('param', idParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
    if (!orgId) {
      return c.json({ error: 'orgId is required for this scope' }, 400);
    }

    const { id } = c.req.valid('param');
    const authorization = await authorizeRouteResilienceResources(c, orgId, [
      { kind: 'boot_media_artifact', id, role: 'source' },
      { kind: 'boot_media_artifact', id, role: 'target' },
    ], 'media');
    if (!authorization.ok) return authorization.response;
    await expireTokenArtifacts(orgId);
    const target = await getRecoveryBootMediaDownloadTarget(orgId, id, 'signature');
    if (!target) {
      return c.json({ error: 'Recovery boot media artifact not found' }, 404);
    }
    if (target.unavailable) {
      return c.json({ error: 'Recovery boot media signature is not available' }, 410);
    }

    writeRouteAudit(c, {
      orgId,
      action: 'bmr.boot_media.signature.download',
      resourceType: 'recovery_boot_media_artifact',
      resourceId: id,
    });

    if (target.type === 'redirect') {
      return c.redirect(target.url, 302);
    }

    return toDownloadStreamResponse(target, 'application/octet-stream');
  }
);

bmrPublicRoutes.post(
  '/bmr/recover/authenticate',
  zValidator('json', bmrAuthenticateSchema),
  async (c) => {
    const rateLimited = await enforcePublicRateLimit(c, 'authenticate', 10);
    if (rateLimited) {
      writeAuditEvent(c, {
        orgId: null,
        action: 'bmr.recovery.authenticate',
        resourceType: 'recovery_token',
        details: { reason: 'rate_limited' },
        result: 'denied',
        errorMessage: 'rate_limited',
      });
      return rateLimited;
    }

    await expireUnusedRecoveryTokens();

    const { token } = c.req.valid('json');
    if (!isValidRecoveryTokenFormat(token)) {
      writeAuditEvent(c, {
        orgId: null,
        action: 'bmr.recovery.authenticate',
        resourceType: 'recovery_token',
        details: { reason: 'invalid_token_format' },
        result: 'failure',
        errorMessage: 'Invalid recovery token',
      });
      return c.json({ error: 'Invalid recovery token' }, 401);
    }

    const tokenHash = hashRecoveryToken(token);
    const tokenRateLimited = await enforceTokenRateLimit(
      c,
      'authenticate',
      tokenHash,
      BMR_AUTHENTICATE_TOKEN_LIMIT,
      BMR_AUTHENTICATE_TOKEN_WINDOW_SECONDS
    );
    if (tokenRateLimited) {
      writeAuditEvent(c, {
        orgId: null,
        action: 'bmr.recovery.authenticate',
        resourceType: 'recovery_token',
        details: { reason: 'rate_limited_token' },
        result: 'denied',
        errorMessage: 'rate_limited_token',
      });
      return tokenRateLimited;
    }

    // System-scoped on purpose (D9): the caller presents an opaque bearer
    // token, not a JWT, so there is no org to scope to until this lookup
    // resolves the token's own org. This is the ONLY system-scoped query in
    // this handler — everything after `row` is found runs inside
    // runInRecoveryOrgContext(row.orgId, ...) below, never at system scope.
    const [row] = await withSystemDbAccessContext(() =>
      db
        .select()
        .from(recoveryTokens)
        .where(eq(recoveryTokens.tokenHash, tokenHash))
        .limit(1)
    );

    if (!row) {
      writeAuditEvent(c, {
        orgId: null,
        action: 'bmr.recovery.authenticate',
        resourceType: 'recovery_token',
        details: { reason: 'invalid_token' },
        result: 'failure',
        errorMessage: 'Invalid recovery token',
      });
      return c.json({ error: 'Invalid recovery token' }, 401);
    }

    return runInRecoveryOrgContext(row.orgId, async () => {
      if (row.expiresAt < new Date()) {
        await db
          .update(recoveryTokens)
            .set({ status: 'expired' })
            .where(eq(recoveryTokens.id, row.id));
        writeAuditEvent(c, {
          orgId: row.orgId,
          action: 'bmr.recovery.authenticate',
          resourceType: 'recovery_token',
          resourceId: row.id,
          details: { snapshotId: row.snapshotId, reason: 'expired' },
          result: 'failure',
          errorMessage: 'Token has expired',
        });
        return c.json({ error: 'Token has expired' }, 401);
      }

      if (row.status === 'revoked' || row.status === 'expired') {
        writeAuditEvent(c, {
          orgId: row.orgId,
          action: 'bmr.recovery.authenticate',
          resourceType: 'recovery_token',
          resourceId: row.id,
          details: { snapshotId: row.snapshotId, reason: row.status },
          result: 'failure',
          errorMessage: `Token is ${row.status}`,
        });
        return c.json({ error: `Token is ${row.status}` }, 401);
      }

      if (row.status === 'used' && row.completedAt) {
        writeAuditEvent(c, {
          orgId: row.orgId,
          action: 'bmr.recovery.authenticate',
          resourceType: 'recovery_token',
          resourceId: row.id,
          details: { snapshotId: row.snapshotId, reason: 'used' },
          result: 'failure',
          errorMessage: 'Token is used',
        });
        return c.json({ error: 'Token is used' }, 401);
      }

      const resolvedSnapshot = await resolveSnapshotProviderConfig(row.snapshotId);
      const snapshot = resolvedSnapshot?.snapshot ?? null;
      const config = resolvedSnapshot?.config ?? null;

      if (!snapshot || snapshot.orgId !== row.orgId || snapshot.deviceId !== row.deviceId) {
        writeAuditEvent(c, {
          orgId: row.orgId,
          action: 'bmr.recovery.authenticate',
          resourceType: 'recovery_token',
          resourceId: row.id,
          details: { snapshotId: row.snapshotId, reason: 'snapshot_missing_or_mismatched' },
          result: 'failure',
          errorMessage: 'Recovery snapshot not found',
        });
        return c.json({ error: 'Recovery snapshot not found' }, 404);
      }

      if (!['active', 'authenticated', 'used'].includes(row.status)) {
        writeAuditEvent(c, {
          orgId: row.orgId,
          action: 'bmr.recovery.authenticate',
          resourceType: 'recovery_token',
          resourceId: row.id,
          details: { snapshotId: row.snapshotId, reason: row.status },
          result: 'failure',
          errorMessage: `Token is ${row.status}`,
        });
        return c.json({ error: `Token is ${row.status}` }, 401);
      }

      const [device] = await db
        .select({
          id: devices.id,
          hostname: devices.hostname,
          osType: devices.osType,
          architecture: devices.architecture,
          displayName: devices.displayName,
        })
        .from(devices)
        .where(eq(devices.id, row.deviceId))
        .limit(1);

      const authenticatedAt = row.authenticatedAt ?? row.usedAt ?? new Date();
      const nextStatus = row.status === 'active' || (row.status === 'used' && !row.completedAt)
        ? 'authenticated'
        : row.status;

      if (row.status !== nextStatus || !row.authenticatedAt) {
        await db
          .update(recoveryTokens)
          .set({
            status: nextStatus,
            authenticatedAt,
          })
          .where(eq(recoveryTokens.id, row.id));
      }

      const clientIp = getTrustedClientIp(c, 'unknown');
      const redis = getRedis();
      if (redis) {
        try {
          const authIpKey = `bmr:authenticate:last-ip:${row.id}`;
          const previousIp = await redis.get(authIpKey);
          if (previousIp && previousIp !== clientIp) {
            writeAuditEvent(c, {
              orgId: row.orgId,
              action: 'bmr.recovery.authenticate.anomaly',
              resourceType: 'recovery_token',
              resourceId: row.id,
              details: {
                snapshotId: row.snapshotId,
                previousIp,
                currentIp: clientIp,
                reason: 'reauthenticated_from_new_ip',
              },
              result: 'success',
            });
          }
          const ttlSeconds = Math.max(60, Math.ceil((row.expiresAt.getTime() - Date.now()) / 1000));
          await redis.set(authIpKey, clientIp, 'EX', ttlSeconds);
        } catch (error) {
          console.warn(`[bmr] Failed to update recovery authenticate IP tracking for token ${row.id}:`, error);
        }
      }

      writeAuditEvent(c, {
        orgId: row.orgId,
        action: 'bmr.recovery.authenticate',
        resourceType: 'recovery_token',
        resourceId: row.id,
        details: {
          snapshotId: row.snapshotId,
          deviceId: row.deviceId,
          restoreType: row.restoreType,
          authenticatedAt: authenticatedAt.toISOString(),
        },
        result: 'success',
      });

      // Bare-metal recovery W04a: when this token was minted by
      // POST /bmr/recover/exchange, echo the (nonce-less) recovery binding
      // on bootstrap.recovery so a re-authenticating helper can see the
      // recovery id/identity. This is deliberately the LAST db call before
      // the payload is built, so it never shifts the position of any
      // earlier select() in bmr.test.ts's mocked call sequence — every
      // existing authenticate test leaves it unmocked and gets the harness
      // default empty result, i.e. no `recovery` field. The nonce itself is
      // NEVER returned here: it only ever exists in plaintext for the
      // single exchange response that generated it, and is never
      // persisted — only its hash is stored on the recovery row — so there
      // is no plaintext left for a later authenticate call to leak.
      const [recoveryBinding] = await db
        .select({
          id: bareMetalRecoveries.id,
          identity: bareMetalRecoveries.identity,
          deviceId: bareMetalRecoveries.deviceId,
          snapshotId: bareMetalRecoveries.snapshotId,
        })
        .from(bareMetalRecoveries)
        .where(eq(bareMetalRecoveries.recoveryTokenId, row.id))
        .limit(1);

      const authenticatedPayload = buildAuthenticatedBootstrapPayload({
        tokenId: row.id,
        deviceId: row.deviceId,
        // snapshot.id (not row.snapshotId) — TS can't narrow row.snapshotId
        // from the `!snapshot` guard above, but by construction they're the
        // same value: resolveSnapshotProviderConfig looked snapshot up BY
        // row.snapshotId, so a non-null `snapshot` proves it was non-null.
        // snapshot.id is properly typed non-null (backup_snapshots' PK).
        snapshotId: snapshot.id,
        restoreType: row.restoreType,
        targetConfig: row.targetConfig,
        authenticatedAt,
        device: device
          ? {
              id: device.id,
              hostname: device.hostname,
              displayName: device.displayName ?? null,
              osType: device.osType,
              architecture: device.architecture,
            }
          : null,
        snapshot: {
          id: snapshot.id,
          orgId: snapshot.orgId,
          jobId: snapshot.jobId,
          deviceId: snapshot.deviceId,
          configId: snapshot.configId ?? null,
          snapshotId: snapshot.snapshotId,
          label: snapshot.label,
          location: snapshot.location,
          timestamp: toIsoString(snapshot.timestamp),
          size: snapshot.size,
          fileCount: snapshot.fileCount,
          hardwareProfile: snapshot.hardwareProfile,
          systemStateManifest: snapshot.systemStateManifest,
          backupType: snapshot.backupType,
          isIncremental: snapshot.isIncremental,
          metadata: asRecord(snapshot.metadata),
        },
        providerType: resolvedSnapshot?.providerType,
        config: config
          ? {
              id: config.id,
              orgId: config.orgId,
              name: config.name,
              type: config.type,
              provider: config.provider,
              providerConfig: config.providerConfig,
              schedule: config.schedule ?? null,
              retention: config.retention ?? null,
              isActive: config.isActive,
            }
          : null,
        requestUrl: c.req.url,
        tokenExpiresAt: row.expiresAt,
        recovery: recoveryBinding
          ? {
              id: recoveryBinding.id,
              identity: recoveryBinding.identity as 'original' | 'new',
              deviceId: recoveryBinding.deviceId,
              snapshotId: recoveryBinding.snapshotId,
            }
          : null,
      });

      return c.json(authenticatedPayload);
    });
  }
);

bmrPublicRoutes.get(
  '/bmr/recover/download',
  zValidator('query', recoveryDownloadQuerySchema),
  async (c) => {
    await expireUnusedRecoveryTokens();

    const { token: queryToken, path } = c.req.valid('query');
    if (queryToken?.trim() && !allowRecoveryQueryToken()) {
      writeRecoveryDownloadAudit(c, {
        orgId: null,
        result: 'denied',
        path,
        tokenSource: 'query',
        statusCode: 400,
        reason: 'Recovery token query parameter is disabled',
      });
      return c.json({ error: 'Recovery token query parameter is disabled. Use Authorization: Bearer or X-Recovery-Token.' }, 400);
    }

    const { token, source: tokenSource } = resolveRecoveryDownloadToken(c, queryToken);
    if (!token) {
      writeRecoveryDownloadAudit(c, {
        orgId: null,
        result: 'denied',
        path,
        tokenSource,
        statusCode: 400,
        reason: 'Recovery token is required',
      });
      return c.json({ error: 'Recovery token is required' }, 400);
    }

    if (!isValidRecoveryTokenFormat(token)) {
      writeRecoveryDownloadAudit(c, {
        orgId: null,
        result: 'failure',
        path,
        tokenSource,
        statusCode: 401,
        reason: 'Invalid recovery token',
      });
      return c.json({ error: 'Invalid recovery token' }, 401);
    }

    const tokenHash = hashRecoveryToken(token);
    const tokenRateLimited = await enforceTokenRateLimit(
      c,
      'download',
      tokenHash,
      BMR_DOWNLOAD_TOKEN_LIMIT,
      BMR_DOWNLOAD_TOKEN_WINDOW_SECONDS
    );
    if (tokenRateLimited) {
      writeRecoveryDownloadAudit(c, {
        orgId: null,
        result: 'denied',
        path,
        tokenSource,
        statusCode: 429,
        reason: 'Rate limit exceeded',
      });
      return tokenRateLimited;
    }

    // System-scoped on purpose (D9): the caller presents an opaque bearer
    // token, not a JWT, so there is no org to scope to until this lookup
    // resolves the token's own org. This is the ONLY system-scoped query in
    // this handler — everything after `row` is found (including the
    // provider-config resolution and storage read inside
    // getAuthenticatedRecoveryDownloadTarget) runs inside
    // runInRecoveryOrgContext(row.orgId, ...) below, never at system scope.
    const [row] = await withSystemDbAccessContext(() =>
      db
        .select({
          id: recoveryTokens.id,
          orgId: recoveryTokens.orgId,
          deviceId: recoveryTokens.deviceId,
          snapshotId: recoveryTokens.snapshotId,
          status: recoveryTokens.status,
          authenticatedAt: recoveryTokens.authenticatedAt,
          expiresAt: recoveryTokens.expiresAt,
        })
        .from(recoveryTokens)
        .where(eq(recoveryTokens.tokenHash, tokenHash))
        .limit(1)
    );

    if (!row) {
      writeRecoveryDownloadAudit(c, {
        orgId: null,
        result: 'failure',
        path,
        tokenSource,
        statusCode: 401,
        reason: 'Invalid recovery token',
      });
      return c.json({ error: 'Invalid recovery token' }, 401);
    }

    return runInRecoveryOrgContext(row.orgId, async () => {
      if (!isDownloadableRecoveryTokenStatus(row.status, row.authenticatedAt)) {
        const status =
          row.status === 'revoked' || row.status === 'expired' || row.status === 'used'
            ? 401
            : 409;
        writeRecoveryDownloadAudit(c, {
          orgId: row.orgId,
          resourceId: row.id,
          snapshotId: row.snapshotId,
          result: status === 409 ? 'denied' : 'failure',
          path,
          tokenSource,
          statusCode: status,
          reason: row.status === 'active' ? 'Recovery token has not been authenticated' : `Token is ${row.status}`,
        });
        return c.json({ error: row.status === 'active' ? 'Recovery token has not been authenticated' : `Token is ${row.status}` }, status);
      }

      let target;
      try {
        target = await getAuthenticatedRecoveryDownloadTarget(row, path);
      } catch (error) {
        writeRecoveryDownloadAudit(c, {
          orgId: row.orgId,
          resourceId: row.id,
          snapshotId: row.snapshotId,
          result: 'failure',
          path,
          tokenSource,
          statusCode: 500,
          reason: error instanceof Error ? error.message : 'Failed to resolve recovery download',
        });
        return c.json(
          { error: error instanceof Error ? error.message : 'Failed to resolve recovery download' },
          500
        );
      }

      if (target.unavailable) {
        const status =
          target.reason === 'Recovery session has expired. Re-authenticate to continue.'
            ? 401
            : target.reason?.startsWith('Token is ')
              ? 401
              : 409;
        writeRecoveryDownloadAudit(c, {
          orgId: row.orgId,
          resourceId: row.id,
          snapshotId: row.snapshotId,
          result: status === 409 ? 'denied' : 'failure',
          path,
          tokenSource,
          statusCode: status,
          reason: target.reason,
        });
        return c.json({ error: target.reason }, status);
      }

      if (target.type === 'redirect') {
        writeRecoveryDownloadAudit(c, {
          orgId: row.orgId,
          resourceId: row.id,
          snapshotId: row.snapshotId,
          result: 'success',
          path,
          tokenSource,
          statusCode: 302,
          transferType: 'redirect',
        });
        return c.redirect(target.url, 302);
      }

      writeRecoveryDownloadAudit(c, {
        orgId: row.orgId,
        resourceId: row.id,
        snapshotId: row.snapshotId,
        result: 'success',
        path,
        tokenSource,
        statusCode: 200,
        transferType: 'stream',
      });

      // The file/S3 stream construction below reads from disk (or a
      // pre-signed URL, in the redirect branch above), never from Postgres —
      // it's safe for this to keep streaming after the org-scoped DB
      // transaction above closes, since every DB read this handler needs
      // (the lineage check + provider config resolution inside
      // getAuthenticatedRecoveryDownloadTarget) already completed above.
      const webStream = new ReadableStream({
        start(controller) {
          target.stream.on('data', (chunk: string | Buffer) => {
            const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
            controller.enqueue(new Uint8Array(bytes));
          });
          target.stream.on('end', () => controller.close());
          target.stream.on('error', (error) => controller.error(error));
        },
        cancel() {
          target.stream.destroy();
        },
      });

      return new Response(webStream, {
        status: 200,
        headers: {
          'Content-Type': target.contentType,
          'Content-Length': String(target.contentLength),
          'Cache-Control': 'no-store',
        },
      });
    });
  }
);

bmrPublicRoutes.post(
  '/bmr/recover/complete',
  zValidator('json', bmrCompleteSchema),
  async (c) => {
    const rateLimited = await enforcePublicRateLimit(c, 'complete', 5);
    if (rateLimited) {
      writeAuditEvent(c, {
        orgId: null,
        action: 'bmr.recovery.complete',
        resourceType: 'recovery_token',
        details: { reason: 'rate_limited' },
        result: 'denied',
        errorMessage: 'rate_limited',
      });
      return rateLimited;
    }

    await expireUnusedRecoveryTokens();

    const { token, result } = c.req.valid('json');
    if (!isValidRecoveryTokenFormat(token)) {
      writeAuditEvent(c, {
        orgId: null,
        action: 'bmr.recovery.complete',
        resourceType: 'recovery_token',
        details: { reason: 'invalid_token_format' },
        result: 'failure',
        errorMessage: 'Invalid recovery token',
      });
      return c.json({ error: 'Invalid recovery token' }, 401);
    }
    const tokenHash = hashRecoveryToken(token);

    // System-scoped on purpose (D9): the caller presents an opaque bearer
    // token, not a JWT, so there is no org to scope to until this lookup
    // resolves the token's own org. This is the ONLY system-scoped query in
    // this handler — everything after `row` is found (including the nested
    // db.transaction(...) below, which runs as a SAVEPOINT inside the
    // org-scoped transaction and inherits its RLS GUCs) runs inside
    // runInRecoveryOrgContext(row.orgId, ...), never at system scope.
    const [row] = await withSystemDbAccessContext(() =>
      db
        .select()
        .from(recoveryTokens)
        .where(eq(recoveryTokens.tokenHash, tokenHash))
        .limit(1)
    );

    if (!row) {
      writeAuditEvent(c, {
        orgId: null,
        action: 'bmr.recovery.complete',
        resourceType: 'recovery_token',
        details: { reason: 'invalid_token' },
        result: 'failure',
        errorMessage: 'Invalid recovery token',
      });
      return c.json({ error: 'Invalid recovery token' }, 401);
    }

    return runInRecoveryOrgContext(row.orgId, async () => {
      if (row.status === 'revoked' || row.status === 'expired') {
        writeAuditEvent(c, {
          orgId: row.orgId,
          action: 'bmr.recovery.complete',
          resourceType: 'recovery_token',
          resourceId: row.id,
          details: { snapshotId: row.snapshotId, status: result.status, reason: row.status },
          result: 'failure',
          errorMessage: `Token is ${row.status}`,
        });
        return c.json({ error: `Token is ${row.status}` }, 401);
      }

      if (row.status === 'used' && row.completedAt) {
        const [existingRestoreJob] = await db
          .select({
            id: restoreJobs.id,
            status: restoreJobs.status,
          })
          .from(restoreJobs)
          .where(eq(restoreJobs.recoveryTokenId, row.id))
          .limit(1);

        return c.json({
          restoreJobId: existingRestoreJob?.id ?? null,
          status: existingRestoreJob?.status ?? 'completed',
        });
      }

      if (!row.authenticatedAt && !row.usedAt) {
        writeAuditEvent(c, {
          orgId: row.orgId,
          action: 'bmr.recovery.complete',
          resourceType: 'recovery_token',
          resourceId: row.id,
          details: { snapshotId: row.snapshotId, status: result.status, reason: 'not_authenticated' },
          result: 'failure',
          errorMessage: 'Recovery token has not been authenticated',
        });
        return c.json({ error: 'Recovery token has not been authenticated' }, 409);
      }

      if (!(row.status === 'authenticated' || (row.status === 'active' && row.authenticatedAt) || (row.status === 'used' && !row.completedAt))) {
        writeAuditEvent(c, {
          orgId: row.orgId,
          action: 'bmr.recovery.complete',
          resourceType: 'recovery_token',
          resourceId: row.id,
          details: { snapshotId: row.snapshotId, status: result.status, reason: row.status },
          result: 'failure',
          errorMessage: `Token is ${row.status}`,
        });
        return c.json({ error: `Token is ${row.status}` }, 401);
      }

      const restoreStatus =
        result.status === 'completed'
          ? 'completed'
          : result.status === 'partial'
            ? 'partial'
            : 'failed';

      const completionTime = new Date();
      const persistedRestoreJob = await db.transaction(async (tx) => {
        const [restoreJob] = await tx
          .insert(restoreJobs)
          .values({
            orgId: row.orgId,
            snapshotId: row.snapshotId,
            deviceId: row.deviceId,
            restoreType: 'bare_metal',
            status: restoreStatus,
            targetConfig: {
              ...asRecord(row.targetConfig),
              result: {
                status: result.status,
                filesRestored: result.filesRestored ?? null,
                bytesRestored: result.bytesRestored ?? null,
                stateApplied: result.stateApplied ?? null,
                driversInjected: result.driversInjected ?? null,
                validated: result.validated ?? null,
                warnings: result.warnings ?? [],
                error: result.error ?? null,
                // D14: per-file failure count for a partially-successful
                // recovery. Optional and left null (not 0) when an older agent
                // build doesn't report it.
                failedFiles: result.failedFiles ?? null,
              },
            },
            recoveryTokenId: row.id,
            restoredSize: result.bytesRestored ?? null,
            restoredFiles: result.filesRestored ?? null,
            startedAt: row.authenticatedAt ?? row.usedAt ?? row.createdAt,
            completedAt: completionTime,
            createdAt: completionTime,
            updatedAt: completionTime,
          })
          .onConflictDoNothing({ target: restoreJobs.recoveryTokenId })
          .returning({
            id: restoreJobs.id,
            status: restoreJobs.status,
          });

        const persisted =
          restoreJob ??
          (
            await tx
              .select({
                id: restoreJobs.id,
                status: restoreJobs.status,
              })
              .from(restoreJobs)
              .where(eq(restoreJobs.recoveryTokenId, row.id))
              .limit(1)
          )[0];

        if (persisted) {
          await tx
            .update(recoveryTokens)
            .set({
              status: 'used',
              completedAt: completionTime,
              usedAt: completionTime,
            })
            .where(eq(recoveryTokens.id, row.id));

          await tx
            .update(recoveryMediaArtifacts)
            .set({ status: 'expired' })
            .where(eq(recoveryMediaArtifacts.tokenId, row.id));
        }

        return persisted ?? null;
      });

      writeAuditEvent(c, {
        orgId: row.orgId,
        action: 'bmr.recovery.complete',
        resourceType: 'recovery_token',
        resourceId: row.id,
        details: {
          snapshotId: row.snapshotId,
          restoreJobId: persistedRestoreJob?.id ?? null,
          status: result.status,
        },
        result: 'success',
      });

      return c.json({
        restoreJobId: persistedRestoreJob?.id ?? null,
        status: persistedRestoreJob?.status ?? restoreStatus,
      });
    });
  }
);
