import { Hono } from 'hono';
import type { Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, sql, desc, inArray, lt, isNull, or } from 'drizzle-orm';
import { customAlphabet } from 'nanoid';
import { db, withSystemDbAccessContext } from '../db';
import { enrollmentKeys } from '../db/schema';
import { authMiddleware, requireMfa, requirePermission, requireScope, type AuthContext } from '../middleware/auth';
import { userRateLimit } from '../middleware/userRateLimit';
import { randomBytes } from 'crypto';
import { createAuditLogAsync } from '../services/auditService';
import { PERMISSIONS } from '../services/permissions';
import { hashEnrollmentKey } from '../services/enrollmentKeySecurity';
import {
  buildMacosInstallerZip, buildWindowsInstallerZip,
  fetchRegularMsi, fetchMacosPkg, fetchMacosInstallerAppZip,
} from '../services/installerBuilder';
import { renameAppInZip } from '../services/installerAppZip';
import {
  issueBootstrapTokenForKey,
  BootstrapTokenIssuanceError,
} from '../services/installerBootstrapTokenIssuance';
import { MsiSigningService } from '../services/msiSigning';
import { getGithubReleaseVersion } from '../services/binarySource';
import { captureException } from '../services/sentry';

/**
 * Narrow `Buffer | null` to `Buffer`, throwing an actionable error when
 * null. Replaces non-null assertions so a future code change that adds a
 * new platform without updating the fetch site produces a clear error
 * instead of an opaque `Cannot read property of null` deep inside the
 * installer-builder functions.
 */
function ensureBuffer(buf: Buffer | null, context: string): Buffer {
  if (!buf) {
    throw new Error(`Internal error: binary buffer not fetched (${context})`);
  }
  return buf;
}

export const enrollmentKeyRoutes = new Hono();

// ============================================
// Helper Functions
// ============================================

function envInt(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

const DEFAULT_ENROLLMENT_KEY_TTL_MINUTES = envInt('ENROLLMENT_KEY_DEFAULT_TTL_MINUTES', 60);

// Child enrollment keys (installer downloads, installer-link downloads, and
// short-link redemptions) get a fresh, independent TTL rather than inheriting
// the parent's remaining lifetime. The previous "inherit parentKey.expiresAt"
// behaviour made installers DOA whenever the parent was near expiry at
// download time — a minute-59 download against a 60-minute parent produced a
// child good for only 60 seconds. 24h by default, overridable.
const CHILD_ENROLLMENT_KEY_TTL_MINUTES = envInt('CHILD_ENROLLMENT_KEY_TTL_MINUTES', 60 * 24);

// Parent keys that are within this window of expiry are refused as installer
// sources. Prevents a race where the admin-side parent is already live on
// this side of the API but the install on a remote device fires 30 seconds
// later, after the parent expired.
const INSTALLER_PARENT_MIN_REMAINING_SECONDS = envInt('INSTALLER_PARENT_MIN_REMAINING_SECONDS', 60);

function generateEnrollmentKey(): string {
  return randomBytes(32).toString('hex'); // 64-char hex string
}

/** Fresh absolute expiry for a child enrollment key, independent of parent. */
function freshChildExpiresAt(): Date {
  return new Date(Date.now() + CHILD_ENROLLMENT_KEY_TTL_MINUTES * 60 * 1000);
}

/**
 * Version string to send to the signing service. The signing service keys
 * its template cache by GitHub release tag (e.g. `v0.62.24`), matching the
 * download URL convention used elsewhere in binarySource.ts. We store bare
 * semver in BREEZE_VERSION / BINARY_VERSION and prepend the `v` here.
 * `"latest"` is passed through — the server will surface its own rejection.
 */
function signingServiceVersion(): string {
  const v = getGithubReleaseVersion();
  if (v === 'latest' || v.startsWith('v')) return v;
  return `v${v}`;
}

/**
 * Guard against building an installer from a parent key whose remaining
 * lifetime is so short the child would already be dead by the time the
 * installer reaches the target machine. Callers that hit this should
 * surface the returned error directly.
 */
function parentKeyTooCloseToExpiry(expiresAt: Date | null): boolean {
  if (!expiresAt) return false;
  const remainingMs = expiresAt.getTime() - Date.now();
  return remainingMs < INSTALLER_PARENT_MIN_REMAINING_SECONDS * 1000;
}

function getPagination(query: { page?: string; limit?: string }) {
  const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit ?? '50', 10) || 50));
  return { page, limit, offset: (page - 1) * limit };
}

async function ensureOrgAccess(
  orgId: string,
  auth: Pick<AuthContext, 'scope' | 'orgId' | 'accessibleOrgIds' | 'canAccessOrg'>
) {
  if (auth.scope === 'organization') {
    return auth.orgId === orgId;
  }
  if (auth.scope === 'partner') {
    return auth.canAccessOrg(orgId);
  }
  return true;
}

function writeEnrollmentKeyAudit(
  c: any,
  auth: { user: { id: string; email?: string } },
  event: {
    orgId: string;
    action: string;
    keyId?: string;
    keyName?: string;
    details?: Record<string, unknown>;
  }
): void {
  createAuditLogAsync({
    orgId: event.orgId,
    actorId: auth.user.id,
    actorEmail: auth.user.email,
    action: event.action,
    resourceType: 'enrollment_key',
    resourceId: event.keyId,
    resourceName: event.keyName,
    details: event.details,
    ipAddress: c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip'),
    userAgent: c.req.header('user-agent'),
    result: 'success'
  });
}

// fetchRegularMsi, fetchMacosPkg moved to installerBuilder.ts

const shortCodeAlphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz';
const generateShortCode = customAlphabet(shortCodeAlphabet, 10);

async function allocateShortCode(): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateShortCode();
    const [existing] = await db
      .select({ id: enrollmentKeys.id })
      .from(enrollmentKeys)
      .where(eq(enrollmentKeys.shortCode, code))
      .limit(1);
    if (!existing) return code;
  }
  throw new Error('Failed to allocate unique short code after 5 attempts');
}

// ============================================
// Validation Schemas
// ============================================

const listEnrollmentKeysSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  orgId: z.string().uuid().optional(),
  expired: z.enum(['true', 'false']).optional()
});

const createEnrollmentKeySchema = z.object({
  orgId: z.string().uuid().optional(),
  siteId: z.string().uuid().optional(),
  name: z.string().min(1).max(255),
  maxUsage: z.number().int().min(1).max(100000).optional(),
  expiresAt: z.string().datetime().optional()
});

const rotateEnrollmentKeySchema = z.object({
  maxUsage: z.number().int().min(1).max(100000).nullable().optional(),
  expiresAt: z.string().datetime().optional()
});

const installerQuerySchema = z.object({
  count: z.coerce.number().int().min(1).max(100000).optional(),
});

const installerLinkSchema = z.object({
  platform: z.enum(['windows', 'macos']),
  count: z.number().int().min(1).max(100000).optional(),
});

function sanitizeEnrollmentKey(enrollmentKey: typeof enrollmentKeys.$inferSelect) {
  const { key, ...safeRecord } = enrollmentKey;
  return safeRecord;
}

// ============================================
// Routes
// ============================================

enrollmentKeyRoutes.use('*', authMiddleware);

// GET /enrollment-keys - List enrollment keys (org-scoped)
enrollmentKeyRoutes.get(
  '/',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action),
  zValidator('query', listEnrollmentKeysSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const { page, limit, offset } = getPagination(query);

    const conditions: ReturnType<typeof eq>[] = [];

    if (auth.scope === 'organization') {
      if (!auth.orgId) {
        return c.json({ error: 'Organization context required' }, 403);
      }
      conditions.push(eq(enrollmentKeys.orgId, auth.orgId));
    } else if (auth.scope === 'partner') {
      if (query.orgId) {
        const hasAccess = await ensureOrgAccess(query.orgId, auth);
        if (!hasAccess) {
          return c.json({ error: 'Access to this organization denied' }, 403);
        }
        conditions.push(eq(enrollmentKeys.orgId, query.orgId));
      } else {
        const orgIds = auth.accessibleOrgIds ?? [];
        if (orgIds.length === 0) {
          return c.json({ data: [], pagination: { page, limit, total: 0 } });
        }
        conditions.push(inArray(enrollmentKeys.orgId, orgIds) as ReturnType<typeof eq>);
      }
    } else if (auth.scope === 'system') {
      if (query.orgId) {
        conditions.push(eq(enrollmentKeys.orgId, query.orgId));
      }
    }

    // Filter by expired status
    if (query.expired === 'true') {
      conditions.push(lt(enrollmentKeys.expiresAt, new Date()) as ReturnType<typeof eq>);
    } else if (query.expired === 'false') {
      conditions.push(
        or(
          isNull(enrollmentKeys.expiresAt),
          sql`${enrollmentKeys.expiresAt} >= NOW()`
        ) as ReturnType<typeof eq>
      );
    }

    const whereCondition = conditions.length > 0 ? and(...conditions) : undefined;

    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(enrollmentKeys)
      .where(whereCondition);
    const total = Number(countResult[0]?.count ?? 0);

    const keyList = await db
      .select()
      .from(enrollmentKeys)
      .where(whereCondition)
      .orderBy(desc(enrollmentKeys.createdAt))
      .limit(limit)
      .offset(offset);

    return c.json({
      data: keyList.map((keyRecord) => sanitizeEnrollmentKey(keyRecord)),
      pagination: { page, limit, total }
    });
  }
);

// POST /enrollment-keys - Create new enrollment key
enrollmentKeyRoutes.post(
  '/',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  userRateLimit('enroll-write', 10, 60),
  requireMfa(),
  zValidator('json', createEnrollmentKeySchema),
  async (c) => {
    const auth = c.get('auth');
    const data = c.req.valid('json');
    let orgId = data.orgId;

    if (auth.scope === 'organization') {
      if (!auth.orgId) {
        return c.json({ error: 'Organization context required' }, 403);
      }
      if (data.orgId && data.orgId !== auth.orgId) {
        return c.json({ error: 'Can only create enrollment keys for your organization' }, 403);
      }
      orgId = auth.orgId;
    } else if (auth.scope === 'partner') {
      if (!orgId) {
        const singleOrg = auth.accessibleOrgIds?.[0];
        if (auth.accessibleOrgIds?.length === 1 && singleOrg) {
          orgId = singleOrg;
        } else {
          return c.json({ error: 'orgId is required when partner has multiple organizations' }, 400);
        }
      }
      const hasAccess = await ensureOrgAccess(orgId, auth);
      if (!hasAccess) {
        return c.json({ error: 'Access to this organization denied' }, 403);
      }
    } else if (!orgId) {
      return c.json({ error: 'orgId is required' }, 400);
    }

    const rawKey = generateEnrollmentKey();
    const keyHash = hashEnrollmentKey(rawKey);
    const expiresAt = data.expiresAt
      ? new Date(data.expiresAt)
      : new Date(Date.now() + DEFAULT_ENROLLMENT_KEY_TTL_MINUTES * 60 * 1000);
    const maxUsage = data.maxUsage ?? 1;

    const [enrollmentKey] = await db
      .insert(enrollmentKeys)
      .values({
        orgId,
        siteId: data.siteId ?? null,
        name: data.name,
        key: keyHash,
        maxUsage,
        expiresAt,
        createdBy: auth.user.id
      })
      .returning();

    if (!enrollmentKey) {
      return c.json({ error: 'Failed to create enrollment key' }, 500);
    }

    writeEnrollmentKeyAudit(c, auth, {
      orgId: enrollmentKey.orgId,
      action: 'enrollment_key.create',
      keyId: enrollmentKey.id,
      keyName: enrollmentKey.name,
      details: {
        siteId: enrollmentKey.siteId,
        maxUsage: enrollmentKey.maxUsage,
        expiresAt: enrollmentKey.expiresAt
      }
    });

    return c.json({
      ...sanitizeEnrollmentKey(enrollmentKey),
      key: rawKey
    }, 201);
  }
);

// GET /enrollment-keys/:id - Get enrollment key details
enrollmentKeyRoutes.get(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action),
  async (c) => {
    const auth = c.get('auth');
    const keyId = c.req.param('id')!;

    const [enrollmentKey] = await db
      .select()
      .from(enrollmentKeys)
      .where(eq(enrollmentKeys.id, keyId))
      .limit(1);

    if (!enrollmentKey) {
      return c.json({ error: 'Enrollment key not found' }, 404);
    }

    const hasAccess = await ensureOrgAccess(enrollmentKey.orgId, auth);
    if (!hasAccess) {
      return c.json({ error: 'Access denied' }, 403);
    }

    return c.json(sanitizeEnrollmentKey(enrollmentKey));
  }
);

// POST /enrollment-keys/:id/rotate - Rotate enrollment key material in-place
enrollmentKeyRoutes.post(
  '/:id/rotate',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  userRateLimit('enroll-write', 10, 60),
  requireMfa(),
  zValidator('json', rotateEnrollmentKeySchema),
  async (c) => {
    const auth = c.get('auth');
    const keyId = c.req.param('id')!;
    const data = c.req.valid('json');

    const [existingKey] = await db
      .select()
      .from(enrollmentKeys)
      .where(eq(enrollmentKeys.id, keyId))
      .limit(1);

    if (!existingKey) {
      return c.json({ error: 'Enrollment key not found' }, 404);
    }

    const hasAccess = await ensureOrgAccess(existingKey.orgId, auth);
    if (!hasAccess) {
      return c.json({ error: 'Access denied' }, 403);
    }

    const rawKey = generateEnrollmentKey();
    const keyHash = hashEnrollmentKey(rawKey);
    const expiresAt = data.expiresAt ? new Date(data.expiresAt) : existingKey.expiresAt;
    const maxUsage = data.maxUsage !== undefined ? data.maxUsage : existingKey.maxUsage;

    const [rotatedKey] = await db
      .update(enrollmentKeys)
      .set({
        key: keyHash,
        usageCount: 0,
        expiresAt,
        maxUsage
      })
      .where(eq(enrollmentKeys.id, keyId))
      .returning();

    if (!rotatedKey) {
      return c.json({ error: 'Failed to rotate enrollment key' }, 500);
    }

    writeEnrollmentKeyAudit(c, auth, {
      orgId: rotatedKey.orgId,
      action: 'enrollment_key.rotate',
      keyId: rotatedKey.id,
      keyName: rotatedKey.name,
      details: {
        previousUsageCount: existingKey.usageCount,
        previousMaxUsage: existingKey.maxUsage,
        nextMaxUsage: rotatedKey.maxUsage,
        previousExpiresAt: existingKey.expiresAt,
        nextExpiresAt: rotatedKey.expiresAt
      }
    });

    return c.json({
      ...sanitizeEnrollmentKey(rotatedKey),
      key: rawKey
    });
  }
);

// DELETE /enrollment-keys/:id - Delete enrollment key (hard delete)
enrollmentKeyRoutes.delete(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  userRateLimit('enroll-write', 10, 60),
  requireMfa(),
  async (c) => {
    const auth = c.get('auth');
    const keyId = c.req.param('id')!;

    const [existingKey] = await db
      .select()
      .from(enrollmentKeys)
      .where(eq(enrollmentKeys.id, keyId))
      .limit(1);

    if (!existingKey) {
      return c.json({ error: 'Enrollment key not found' }, 404);
    }

    const hasAccess = await ensureOrgAccess(existingKey.orgId, auth);
    if (!hasAccess) {
      return c.json({ error: 'Access denied' }, 403);
    }

    await db
      .delete(enrollmentKeys)
      .where(eq(enrollmentKeys.id, keyId));

    writeEnrollmentKeyAudit(c, auth, {
      orgId: existingKey.orgId,
      action: 'enrollment_key.delete',
      keyId: existingKey.id,
      keyName: existingKey.name,
      details: {
        usageCount: existingKey.usageCount,
        maxUsage: existingKey.maxUsage
      }
    });

    return c.json({
      success: true,
      message: 'Enrollment key deleted successfully'
    });
  }
);

// ============================================
// GET /:id/installer/:platform - Download pre-configured installer
// ============================================

enrollmentKeyRoutes.get(
  '/:id/installer/:platform',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
  zValidator('query', installerQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const keyId = c.req.param('id')!;
    const platform = c.req.param('platform');
    const { count: childMaxUsage = 1 } = c.req.valid('query');

    if (platform !== 'windows' && platform !== 'macos') {
      return c.json({ error: 'Invalid platform. Must be "windows" or "macos".' }, 400);
    }

    // Look up parent enrollment key
    const [parentKey] = await db
      .select()
      .from(enrollmentKeys)
      .where(eq(enrollmentKeys.id, keyId))
      .limit(1);

    if (!parentKey) {
      return c.json({ error: 'Enrollment key not found' }, 404);
    }

    // Verify org access
    const hasAccess = await ensureOrgAccess(parentKey.orgId, auth);
    if (!hasAccess) {
      return c.json({ error: 'Access denied' }, 403);
    }

    // Verify key is still usable
    if (parentKey.expiresAt && new Date(parentKey.expiresAt) < new Date()) {
      return c.json({ error: 'Enrollment key has expired' }, 410);
    }
    if (parentKey.maxUsage !== null && parentKey.usageCount >= parentKey.maxUsage) {
      return c.json({ error: 'Enrollment key usage exhausted' }, 410);
    }
    if (parentKeyTooCloseToExpiry(parentKey.expiresAt)) {
      return c.json({
        error: 'Parent enrollment key expires too soon to build an installer — regenerate the key with a longer TTL',
      }, 410);
    }

    // Require siteId on the parent key
    if (!parentKey.siteId) {
      return c.json({ error: 'Enrollment key must have a siteId to generate installers' }, 400);
    }

    // Determine server URL (no header fallback — prevent host header injection)
    const serverUrl = process.env.PUBLIC_API_URL || process.env.API_URL;
    if (!serverUrl) {
      return c.json({ error: 'Server URL not configured (set PUBLIC_API_URL or API_URL)' }, 500);
    }

    // Global enrollment secret (per-key secrets can't be recovered from hash)
    const globalSecret = process.env.AGENT_ENROLLMENT_SECRET || '';
    if (!globalSecret && parentKey.keySecretHash) {
      console.warn('[installer] AGENT_ENROLLMENT_SECRET not configured but parent key has a secret hash — agents may fail to enroll');
    }

    // ----------------------------------------------------------------
    // macOS — new app-bundle path (bootstrap token + renamed app zip)
    // Runs before the legacy binary fetch and child key creation.
    // Falls through to the legacy path when:
    //   (a) caller passed ?legacy=1, OR
    //   (b) the installer-app asset is not yet published on GitHub.
    // ----------------------------------------------------------------
    if (platform === 'macos') {
      const wantLegacy = c.req.query('legacy') === '1';
      const appZip = wantLegacy ? null : await fetchMacosInstallerAppZip();

      if (appZip) {
        // New path — bootstrap token + renamed app zip. No child enrollment key
        // is created here; the bootstrap endpoint creates it lazily on consume.
        let issued;
        try {
          issued = await issueBootstrapTokenForKey({
            parentEnrollmentKeyId: parentKey.id,
            createdByUserId: auth.user.id,
            maxUsage: childMaxUsage,
          });
        } catch (err) {
          if (err instanceof BootstrapTokenIssuanceError) {
            if (err.code === 'parent_not_found') return c.json({ error: err.message }, 404);
            return c.json({ error: err.message }, 410);
          }
          throw err;
        }

        const apiHost = new URL(serverUrl).host;
        const newAppName = `Breeze Installer [${issued.token}@${apiHost}].app`;

        let renamedZip: Buffer | undefined;
        try {
          renamedZip = await renameAppInZip(appZip, {
            oldAppName: 'Breeze Installer.app',
            newAppName,
          });
        } catch (err) {
          console.error('[installer] renameAppInZip failed, falling back to legacy zip', {
            parentKeyId: parentKey.id,
            tokenId: issued.id, // orphaned bootstrap token — will expire normally
            error: err instanceof Error ? err.message : String(err),
          });
          // Fall through to legacy path — do NOT return.
        }

        if (renamedZip) {
          writeEnrollmentKeyAudit(c, auth, {
            orgId: parentKey.orgId,
            action: 'enrollment_key.installer_download',
            keyId: parentKey.id,
            keyName: parentKey.name,
            details: { platform, mode: 'app-bundle', tokenId: issued.id, count: childMaxUsage },
          });

          c.header('Content-Type', 'application/zip');
          c.header('Content-Disposition', `attachment; filename="${newAppName}.zip"`);
          c.header('Content-Length', String(renamedZip.length));
          c.header('Cache-Control', 'no-store');
          return c.body(renamedZip as unknown as ArrayBuffer);
        }
      }

      // Falls through to legacy path below.
    }

    // Determine signing availability and fetch the binary BEFORE creating
    // child key. When the remote signing service is configured for Windows,
    // it builds and signs the MSI from scratch using its own cached
    // templates — the API doesn't need to fetch anything.
    const signingService = MsiSigningService.fromEnv();
    let binaryBuffer: Buffer | null = null;
    try {
      if (platform === 'windows' && !signingService) {
        binaryBuffer = await fetchRegularMsi();
      } else if (platform === 'macos') {
        binaryBuffer = await fetchMacosPkg();
      }
    } catch (err) {
      console.error(`[installer] Failed to fetch ${platform} binary:`, err);
      return c.json({ error: `${platform === 'windows' ? 'MSI' : 'macOS PKG'} not available` }, 503);
    }

    // Generate a child enrollment key. Child gets a FRESH TTL independent
    // of the parent's remaining lifetime — otherwise late-in-life parents
    // produce dead-on-arrival installers (see CHILD_ENROLLMENT_KEY_TTL_MINUTES).
    const rawChildKey = generateEnrollmentKey();
    const childKeyHash = hashEnrollmentKey(rawChildKey);
    const shortCode = await allocateShortCode();

    const [childKey] = await db
      .insert(enrollmentKeys)
      .values({
        orgId: parentKey.orgId,
        siteId: parentKey.siteId,
        name: `${parentKey.name} (installer${childMaxUsage > 1 ? ` x${childMaxUsage}` : ''})`,
        key: childKeyHash,
        keySecretHash: parentKey.keySecretHash,
        maxUsage: childMaxUsage,
        expiresAt: freshChildExpiresAt(),
        createdBy: auth.user.id,
        shortCode,
        installerPlatform: platform,
      })
      .returning();

    if (!childKey) {
      return c.json({ error: 'Failed to generate installer key' }, 500);
    }

    // Build the installer — wrap in try/catch to clean up orphaned child key on failure
    try {
      if (platform === 'windows') {
        let resultBuffer: Buffer;
        let contentType: string;
        let filename: string;

        if (signingService) {
          // Signing configured: ask the remote service to build and sign
          // an MSI from its cached template for this version.
          resultBuffer = await signingService.buildAndSignMsi({
            version: signingServiceVersion(),
            properties: {
              SERVER_URL: serverUrl,
              ENROLLMENT_KEY: rawChildKey,
              ...(globalSecret ? { ENROLLMENT_SECRET: globalSecret } : {}),
            },
          });
          contentType = 'application/octet-stream';
          filename = 'breeze-agent.msi';
        } else {
          // No signing: zip bundle with unmodified signed MSI + enrollment.json + install.bat
          resultBuffer = await buildWindowsInstallerZip(
            ensureBuffer(binaryBuffer, 'installer/windows zip'),
            {
              serverUrl,
              enrollmentKey: rawChildKey,
              enrollmentSecret: globalSecret,
              siteId: parentKey.siteId,
            },
          );
          contentType = 'application/zip';
          filename = 'breeze-agent-windows.zip';
        }

        writeEnrollmentKeyAudit(c, auth, {
          orgId: parentKey.orgId,
          action: 'enrollment_key.installer_download',
          keyId: parentKey.id,
          keyName: parentKey.name,
          details: { platform, childKeyId: childKey.id, shortCode, count: childMaxUsage, signed: !!signingService },
        });

        c.header('Content-Type', contentType);
        c.header('Content-Disposition', `attachment; filename="${filename}"`);
        c.header('Content-Length', String(resultBuffer.length));
        c.header('Cache-Control', 'no-store');
        return c.body(resultBuffer as unknown as ArrayBuffer);
      }

      // macOS — unchanged
      const zipBuffer = await buildMacosInstallerZip(
        ensureBuffer(binaryBuffer, 'installer/macos zip'),
        {
          serverUrl,
          enrollmentKey: rawChildKey,
          enrollmentSecret: globalSecret,
          siteId: parentKey.siteId,
        },
      );

      writeEnrollmentKeyAudit(c, auth, {
        orgId: parentKey.orgId,
        action: 'enrollment_key.installer_download',
        keyId: parentKey.id,
        keyName: parentKey.name,
        details: { platform, childKeyId: childKey.id, shortCode, count: childMaxUsage },
      });

      c.header('Content-Type', 'application/zip');
      c.header('Content-Disposition', 'attachment; filename="breeze-agent-macos.zip"');
      c.header('Content-Length', String(zipBuffer.length));
      c.header('Cache-Control', 'no-store');
      return c.body(zipBuffer as unknown as ArrayBuffer);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error('[installer] Build failed:', detail);
      captureException(err, c);

      // Audit the failure so it's traceable
      createAuditLogAsync({
        orgId: parentKey.orgId,
        actorId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'enrollment_key.installer_build_failed',
        resourceType: 'enrollment_key',
        resourceId: parentKey.id,
        resourceName: parentKey.name,
        details: { platform, childKeyId: childKey.id, count: childMaxUsage, error: detail },
        ipAddress: c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip'),
        userAgent: c.req.header('user-agent'),
        result: 'failure',
      });

      await db.delete(enrollmentKeys).where(eq(enrollmentKeys.id, childKey.id)).catch((cleanupErr) => {
        console.error('[installer] Failed to clean up orphaned child key:', childKey.id, cleanupErr instanceof Error ? cleanupErr.message : cleanupErr);
      });

      // Route is MFA-gated + org-write permission — safe to surface the
      // underlying error so admins debugging a misconfigured signing
      // service get actionable signal instead of an opaque 500.
      return c.json({ error: 'Failed to build installer', detail }, 500);
    }
  }
);

// ============================================
// POST /:id/bootstrap-token — issue a single-use installer bootstrap token
// ============================================

const bootstrapTokenBodySchema = z.object({
  maxUsage: z.number().int().min(1).max(1000).default(1),
});

enrollmentKeyRoutes.post(
  '/:id/bootstrap-token',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  userRateLimit('enroll-write', 10, 60),
  requireMfa(),
  zValidator('json', bootstrapTokenBodySchema),
  async (c) => {
    const auth = c.get('auth');
    const keyId = c.req.param('id')!;
    const { maxUsage } = c.req.valid('json');

    const [parent] = await db
      .select()
      .from(enrollmentKeys)
      .where(eq(enrollmentKeys.id, keyId))
      .limit(1);

    if (!parent) {
      return c.json({ error: 'Enrollment key not found' }, 404);
    }

    const hasAccess = await ensureOrgAccess(parent.orgId, auth);
    if (!hasAccess) {
      return c.json({ error: 'Access denied' }, 403);
    }

    try {
      const { id: tokenId, token, expiresAt } = await issueBootstrapTokenForKey({
        parentEnrollmentKeyId: parent.id,
        createdByUserId: auth.user.id,
        maxUsage,
      });

      writeEnrollmentKeyAudit(c, auth, {
        orgId: parent.orgId,
        action: 'enrollment_key.bootstrap_token_issued',
        keyId: parent.id,
        keyName: parent.name,
        details: { maxUsage, tokenId },
      });

      return c.json({ token, expiresAt: expiresAt.toISOString(), maxUsage });
    } catch (err) {
      if (err instanceof BootstrapTokenIssuanceError) {
        if (err.code === 'parent_not_found') return c.json({ error: err.message }, 404);
        return c.json({ error: err.message }, 410);
      }
      throw err;
    }
  },
);

// ============================================
// POST /:id/installer-link - Generate a public download link
// ============================================

enrollmentKeyRoutes.post(
  '/:id/installer-link',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  userRateLimit('enroll-write', 10, 60),
  requireMfa(),
  zValidator('json', installerLinkSchema),
  async (c) => {
    const auth = c.get('auth');
    const keyId = c.req.param('id')!;
    const { platform, count: childMaxUsage = 1 } = c.req.valid('json');

    // Look up parent enrollment key
    const [parentKey] = await db
      .select()
      .from(enrollmentKeys)
      .where(eq(enrollmentKeys.id, keyId))
      .limit(1);

    if (!parentKey) {
      return c.json({ error: 'Enrollment key not found' }, 404);
    }

    // Verify org access
    const hasAccess = await ensureOrgAccess(parentKey.orgId, auth);
    if (!hasAccess) {
      return c.json({ error: 'Access denied' }, 403);
    }

    // Verify key is still usable
    if (parentKey.expiresAt && new Date(parentKey.expiresAt) < new Date()) {
      return c.json({ error: 'Enrollment key has expired' }, 410);
    }
    if (parentKey.maxUsage !== null && parentKey.usageCount >= parentKey.maxUsage) {
      return c.json({ error: 'Enrollment key usage exhausted' }, 410);
    }
    if (parentKeyTooCloseToExpiry(parentKey.expiresAt)) {
      return c.json({
        error: 'Parent enrollment key expires too soon to build an installer link — regenerate the key with a longer TTL',
      }, 410);
    }

    // Require siteId on the parent key
    if (!parentKey.siteId) {
      return c.json({ error: 'Enrollment key must have a siteId to generate installer links' }, 400);
    }

    // Verify the build pipeline is reachable before creating a child key —
    // otherwise a misconfigured MSI_SIGNING_URL, expired CF Access token,
    // or downed signing VM would produce a link that looks fine at creation
    // time but 500s for every customer who clicks it. The probe is a cheap
    // TCP/TLS + /health liveness check (GET /health with 5s timeout) when
    // signing is configured; otherwise a local binary fetch.
    try {
      if (platform === 'windows') {
        const signingService = MsiSigningService.fromEnv();
        if (signingService) {
          await signingService.probe();
        } else {
          await fetchRegularMsi();
        }
      } else {
        await fetchMacosPkg();
      }
    } catch (err) {
      console.error(`[installer-link] pre-flight check failed for ${platform}:`, err);
      captureException(err, c);
      return c.json({
        error: `${platform === 'windows' ? 'MSI build pipeline' : 'macOS PKG'} not reachable`,
      }, 503);
    }

    // Generate a child enrollment key with a fresh TTL independent of parent
    const rawChildKey = generateEnrollmentKey();
    const childKeyHash = hashEnrollmentKey(rawChildKey);
    const shortCode = await allocateShortCode();

    const [childKey] = await db
      .insert(enrollmentKeys)
      .values({
        orgId: parentKey.orgId,
        siteId: parentKey.siteId,
        name: `${parentKey.name} (link${childMaxUsage > 1 ? ` x${childMaxUsage}` : ''})`,
        key: childKeyHash,
        keySecretHash: parentKey.keySecretHash,
        maxUsage: childMaxUsage,
        expiresAt: freshChildExpiresAt(),
        createdBy: auth.user.id,
        shortCode,
        installerPlatform: platform,
      })
      .returning();

    if (!childKey) {
      return c.json({ error: 'Failed to generate installer link' }, 500);
    }

    // Build public URL
    const serverUrl = process.env.PUBLIC_API_URL || process.env.API_URL;
    if (!serverUrl) {
      return c.json({ error: 'Server URL not configured (set PUBLIC_API_URL or API_URL)' }, 500);
    }

    // Issue a one-time download handle so the raw token never appears in the URL.
    const { issueDownloadHandle } = await import('../services/downloadHandle');
    const handle = await issueDownloadHandle(rawChildKey);

    const publicUrl = `${serverUrl.replace(/\/$/, '')}/api/v1/enrollment-keys/public-download/${platform}?h=${handle}`;
    const shortUrl = `${serverUrl.replace(/\/$/, '')}/s/${shortCode}`;

    // Audit log
    writeEnrollmentKeyAudit(c, auth, {
      orgId: parentKey.orgId,
      action: 'enrollment_key.installer_link_created',
      keyId: parentKey.id,
      keyName: parentKey.name,
      details: { platform, childKeyId: childKey.id, shortCode, count: childMaxUsage },
    });

    return c.json({
      url: publicUrl,
      shortUrl,
      expiresAt: childKey.expiresAt,
      maxUsage: childMaxUsage,
      platform,
      childKeyId: childKey.id,
    });
  }
);

// ============================================
// POST /:id/download-handle - Exchange key for a one-time handle.
// Moves the raw token out of the public URL; the handle survives ~5 min and is single-use.
// ============================================

enrollmentKeyRoutes.post(
  '/:id/download-handle',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  userRateLimit('enroll-handle', 30, 60),
  async (c) => {
    const auth = c.get('auth');
    const keyId = c.req.param('id')!;
    const body = await c.req.json().catch(() => ({})) as { rawToken?: string };
    if (!body.rawToken || typeof body.rawToken !== 'string') {
      return c.json({ error: 'rawToken is required' }, 400);
    }

    // Ownership check: caller must own the key row.
    const [row] = await db.select().from(enrollmentKeys)
      .where(and(eq(enrollmentKeys.id, keyId)))
      .limit(1);
    if (!row) return c.json({ error: 'Not found' }, 404);

    // Verify org access.
    const hasAccess = await ensureOrgAccess(row.orgId, auth);
    if (!hasAccess) return c.json({ error: 'Not found' }, 404);

    // Verify the raw token matches the stored hash.
    if (row.key !== hashEnrollmentKey(body.rawToken)) {
      return c.json({ error: 'Invalid token' }, 400);
    }

    const { issueDownloadHandle } = await import('../services/downloadHandle');
    const handle = await issueDownloadHandle(body.rawToken);
    return c.json({ handle });
  },
);

// ============================================
// Public routes (no auth middleware)
// ============================================

// serveInstaller is the shared helper for both public-download and short-link routes.
// `rawToken` is the plaintext enrollment key to embed in the installer.
// `keyRow`  is the already-resolved enrollment key row (for validation and usage tracking).
async function serveInstaller(
  c: Context,
  keyRow: typeof enrollmentKeys.$inferSelect,
  platform: 'windows' | 'macos',
  rawToken: string,
  cleanupOnFailure = false,
): Promise<Response> {
  const ip = c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip') ?? 'unknown';

  // Rate limit by IP (10 per minute)
  try {
    const { getRedis } = await import('../services');
    const { rateLimiter } = await import('../services/rate-limit');
    const redis = getRedis();
    const rateResult = await rateLimiter(redis, `public-installer:${ip}`, 10, 60);
    if (!rateResult.allowed) {
      return c.json({ error: 'Too many requests. Please try again later.' }, 429);
    }
  } catch {
    // If Redis is unavailable, allow the request (fail open for downloads)
  }

  // Validate key is still usable
  if (keyRow.expiresAt && new Date(keyRow.expiresAt) < new Date()) {
    return c.json({ error: 'This download link has expired' }, 410);
  }
  if (keyRow.maxUsage !== null && keyRow.usageCount >= keyRow.maxUsage) {
    return c.json({ error: 'This download link has been used the maximum number of times' }, 410);
  }
  if (!keyRow.siteId) {
    return c.json({ error: 'Invalid enrollment key configuration' }, 400);
  }

  // Determine server URL
  const serverUrl = process.env.PUBLIC_API_URL || process.env.API_URL;
  if (!serverUrl) {
    return c.json({ error: 'Server URL not configured' }, 500);
  }

  const globalSecret = process.env.AGENT_ENROLLMENT_SECRET || '';

  // Fetch binary only for the local-build paths. When the remote signing
  // service is configured for Windows, it builds and signs the MSI from
  // scratch using its own cached templates — the API doesn't need to fetch
  // anything.
  const signingService = MsiSigningService.fromEnv();
  let binaryBuffer: Buffer | null = null;
  try {
    if (platform === 'windows' && !signingService) {
      binaryBuffer = await fetchRegularMsi();
    } else if (platform === 'macos') {
      binaryBuffer = await fetchMacosPkg();
    }
  } catch (err) {
    console.error(`[public-download] Failed to fetch ${platform} binary:`, err);
    return c.json({ error: 'Installer binary not available' }, 503);
  }

  // Build installer BEFORE incrementing usage (don't burn usage on build failure)
  try {
    let resultBuffer: Buffer;
    let contentType: string;
    let filename: string;

    if (platform === 'windows') {
      if (signingService) {
        resultBuffer = await signingService.buildAndSignMsi({
          version: signingServiceVersion(),
          properties: {
            SERVER_URL: serverUrl,
            ENROLLMENT_KEY: rawToken,
            ...(globalSecret ? { ENROLLMENT_SECRET: globalSecret } : {}),
          },
        });
        contentType = 'application/octet-stream';
        filename = 'breeze-agent.msi';
      } else {
        resultBuffer = await buildWindowsInstallerZip(
          ensureBuffer(binaryBuffer, 'public-download/windows zip'),
          {
            serverUrl,
            enrollmentKey: rawToken,
            enrollmentSecret: globalSecret,
            siteId: keyRow.siteId,
          },
        );
        contentType = 'application/zip';
        filename = 'breeze-agent-windows.zip';
      }
    } else {
      // macOS
      resultBuffer = await buildMacosInstallerZip(
        ensureBuffer(binaryBuffer, 'public-download/macos zip'),
        {
          serverUrl,
          enrollmentKey: rawToken,
          enrollmentSecret: globalSecret,
          siteId: keyRow.siteId,
        },
      );
      contentType = 'application/zip';
      filename = 'breeze-agent-macos.zip';
    }

    // NOTE: we DO NOT bump keyRow.usageCount here. The child key's
    // max_usage semantic is "max successful enrollments," not "max
    // downloads" — bumping on download burns the slot before the agent
    // has even tried to enroll, and the subsequent /agents/enroll call
    // then sees usage_count >= max_usage and returns an opaque 401.
    // The enroll endpoint at routes/agents/enrollment.ts owns the
    // increment via a TOCTOU-safe UPDATE ... WHERE usage_count < max_usage
    // so the slot is only consumed when enrollment actually succeeds.
    // Downloads are still tracked, but via the audit log below.

    createAuditLogAsync({
      orgId: keyRow.orgId,
      actorId: 'public',
      action: 'enrollment_key.public_download',
      resourceType: 'enrollment_key',
      resourceId: keyRow.id,
      resourceName: keyRow.name,
      details: { platform, ip, signed: !!signingService },
      ipAddress: ip,
      userAgent: c.req.header('user-agent'),
      result: 'success',
    });

    c.header('Content-Type', contentType);
    c.header('Content-Disposition', `attachment; filename="${filename}"`);
    c.header('Content-Length', String(resultBuffer.length));
    c.header('Cache-Control', 'no-store');
    return c.body(resultBuffer as unknown as ArrayBuffer);
  } catch (err) {
    console.error('[public-download] Build failed:', err instanceof Error ? err.message : err);
    // Public endpoint — do NOT leak err.message in the response body, but
    // fire Sentry so operators can still see the underlying cause.
    captureException(err, c);

    if (cleanupOnFailure) {
      await db.delete(enrollmentKeys).where(eq(enrollmentKeys.id, keyRow.id)).catch((cleanupErr) => {
        console.error('[public-download] Failed to clean up orphaned child key:', keyRow.id, cleanupErr instanceof Error ? cleanupErr.message : cleanupErr);
      });
    }

    return c.json({ error: 'Failed to build installer' }, 500);
  }
}

export const publicEnrollmentRoutes = new Hono();

const publicDownloadQuerySchema = z.object({
  h: z.string().regex(/^dlh_[a-f0-9]{32}$/).optional(),
  token: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).refine((v) => v.h || v.token, { message: 'h or token is required' });

publicEnrollmentRoutes.get(
  '/public-download/:platform',
  zValidator('query', publicDownloadQuerySchema),
  async (c) => {
    const platform = c.req.param('platform');
    const { h, token } = c.req.valid('query');

    if (platform !== 'windows' && platform !== 'macos') {
      return c.json({ error: 'Invalid platform. Must be "windows" or "macos".' }, 400);
    }

    let rawToken: string | null = null;
    if (h) {
      const { consumeDownloadHandle } = await import('../services/downloadHandle');
      rawToken = await consumeDownloadHandle(h);
    } else if (token) {
      console.warn('[enrollmentKeys] public-download used legacy ?token= path; expected ?h=');
      rawToken = token;
    }
    if (!rawToken) {
      return c.json({ error: 'Invalid or expired download link' }, 404);
    }

    // System context required: public endpoint with no authenticated user,
    // RLS has no org context. The system context wraps BOTH the lookup and
    // serveInstaller so that the usage_count bump inside serveInstaller is
    // also scoped correctly — otherwise the breeze_app role's RLS UPDATE
    // policy silently drops the row modification and download quotas are
    // never enforced.
    const keyHash = hashEnrollmentKey(rawToken);
    const resolvedToken = rawToken;
    return withSystemDbAccessContext(async () => {
      const [enrollmentKey] = await db
        .select()
        .from(enrollmentKeys)
        .where(eq(enrollmentKeys.key, keyHash))
        .limit(1);

      if (!enrollmentKey) {
        return c.json({ error: 'Invalid or expired download link' }, 404);
      }

      return serveInstaller(c, enrollmentKey, platform, resolvedToken);
    });
  }
);

// ============================================
// Public short-link routes (no auth middleware)
// ============================================

export const publicShortLinkRoutes = new Hono();

publicShortLinkRoutes.get('/:code', async (c) => {
  const code = c.req.param('code');
  if (!code || code.length > 12) {
    return c.json({ error: 'Not found' }, 404);
  }

  // System context required: public endpoint with no authenticated user, RLS has no org context
  return withSystemDbAccessContext(async () => {
    const [row] = await db
      .select()
      .from(enrollmentKeys)
      .where(eq(enrollmentKeys.shortCode, code))
      .limit(1);

    if (!row || !row.installerPlatform) {
      return c.json({ error: 'Not found' }, 404);
    }

    if (row.installerPlatform !== 'windows' && row.installerPlatform !== 'macos') {
      return c.json({ error: 'Not found' }, 404);
    }

    // Check expiry on the short-code row BEFORE spawning a child key.
    if (row.expiresAt && new Date(row.expiresAt) < new Date()) {
      return c.json({ error: 'This link has expired.' }, 410);
    }

    // The short-link row holds only the hashed token — the raw token was never stored.
    // Spawn a fresh single-use child key FIRST so we have something to embed in the installer.
    // Child gets a FRESH TTL independent of the short-link row's remaining
    // lifetime so the installer survives the trip to the target machine even
    // if the short-link row is near its own expiry.
    const rawToken = generateEnrollmentKey();
    const tokenHash = hashEnrollmentKey(rawToken);

    const [downloadKey] = await db
      .insert(enrollmentKeys)
      .values({
        orgId: row.orgId,
        siteId: row.siteId,
        name: `${row.name} (short-link download)`,
        key: tokenHash,
        keySecretHash: row.keySecretHash,
        maxUsage: 1,
        expiresAt: freshChildExpiresAt(),
        createdBy: null,
        installerPlatform: row.installerPlatform,
      })
      .returning();

    if (!downloadKey) {
      return c.json({ error: 'Failed to prepare installer' }, 500);
    }

    // Atomic: only increment usage if still under the limit.
    // This prevents TOCTOU races and ensures a failed insert doesn't burn a slot.
    const claimed = await db
      .update(enrollmentKeys)
      .set({ usageCount: sql`${enrollmentKeys.usageCount} + 1` })
      .where(
        and(
          eq(enrollmentKeys.id, row.id),
          row.maxUsage !== null
            ? lt(enrollmentKeys.usageCount, row.maxUsage)
            : sql`true`
        )
      )
      .returning({ id: enrollmentKeys.id });

    if (claimed.length === 0) {
      // Limit was hit between our read and now — clean up the child key we just inserted.
      await db.delete(enrollmentKeys).where(eq(enrollmentKeys.id, downloadKey.id)).catch(() => {});
      return c.json({ error: 'This link has reached its maximum usage limit.' }, 410);
    }

    return serveInstaller(c, downloadKey, row.installerPlatform, rawToken, true);
  });
});
