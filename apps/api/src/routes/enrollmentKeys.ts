import { Hono } from 'hono';
import type { Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, sql, desc, inArray, lt, isNull, or } from 'drizzle-orm';
import { customAlphabet } from 'nanoid';
import { db } from '../db';
import { enrollmentKeys } from '../db/schema';
import { authMiddleware, requireMfa, requirePermission, requireScope, type AuthContext } from '../middleware/auth';
import { randomBytes } from 'crypto';
import { createAuditLogAsync } from '../services/auditService';
import { PERMISSIONS } from '../services/permissions';
import { hashEnrollmentKey } from '../services/enrollmentKeySecurity';
import {
  replaceMsiPlaceholders, buildMacosInstallerZip, buildWindowsInstallerZip,
  fetchTemplateMsi, fetchRegularMsi, fetchMacosPkg,
} from '../services/installerBuilder';
import { MsiSigningService } from '../services/msiSigning';

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

function generateEnrollmentKey(): string {
  return randomBytes(32).toString('hex'); // 64-char hex string
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

// fetchTemplateMsi, fetchRegularMsi, fetchMacosPkg moved to installerBuilder.ts

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

    // Determine signing availability and fetch appropriate binary BEFORE creating child key
    const signingService = MsiSigningService.fromEnv();
    let binaryBuffer: Buffer;
    try {
      if (platform === 'windows') {
        binaryBuffer = signingService ? await fetchTemplateMsi() : await fetchRegularMsi();
      } else {
        binaryBuffer = await fetchMacosPkg();
      }
    } catch (err) {
      console.error(`[installer] Failed to fetch ${platform} binary:`, err);
      return c.json({ error: `${platform === 'windows' ? 'MSI' : 'macOS PKG'} not available` }, 503);
    }

    // Generate a child enrollment key (single-use, same org/site/expiry)
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
        expiresAt: parentKey.expiresAt,
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
        const enrollValues = { serverUrl, enrollmentKey: rawChildKey, enrollmentSecret: globalSecret };

        let resultBuffer: Buffer;
        let contentType: string;
        let filename: string;

        if (signingService) {
          // Signing configured: patch template MSI → re-sign → serve signed .msi
          const patched = replaceMsiPlaceholders(binaryBuffer, enrollValues);
          if (!patched) {
            return c.json({ error: 'Failed to build Windows installer — template placeholders not found' }, 500);
          }
          resultBuffer = await signingService.signMsi(patched);
          contentType = 'application/octet-stream';
          filename = 'breeze-agent.msi';
        } else {
          // No signing: zip bundle with unmodified signed MSI + enrollment.json + install.bat
          resultBuffer = await buildWindowsInstallerZip(binaryBuffer, {
            ...enrollValues, siteId: parentKey.siteId,
          });
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
      const zipBuffer = await buildMacosInstallerZip(binaryBuffer, {
        serverUrl,
        enrollmentKey: rawChildKey,
        enrollmentSecret: globalSecret,
        siteId: parentKey.siteId,
      });

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
      console.error('[installer] Build failed:', err instanceof Error ? err.message : err);

      // Audit the failure so it's traceable
      createAuditLogAsync({
        orgId: parentKey.orgId,
        actorId: auth.user.id,
        actorEmail: auth.user.email,
        action: 'enrollment_key.installer_build_failed',
        resourceType: 'enrollment_key',
        resourceId: parentKey.id,
        resourceName: parentKey.name,
        details: { platform, childKeyId: childKey.id, count: childMaxUsage, error: err instanceof Error ? err.message : String(err) },
        ipAddress: c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip'),
        userAgent: c.req.header('user-agent'),
        result: 'failure',
      });

      await db.delete(enrollmentKeys).where(eq(enrollmentKeys.id, childKey.id)).catch((cleanupErr) => {
        console.error('[installer] Failed to clean up orphaned child key:', childKey.id, cleanupErr instanceof Error ? cleanupErr.message : cleanupErr);
      });
      return c.json({ error: 'Failed to build installer' }, 500);
    }
  }
);

// ============================================
// POST /:id/installer-link - Generate a public download link
// ============================================

enrollmentKeyRoutes.post(
  '/:id/installer-link',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
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

    // Require siteId on the parent key
    if (!parentKey.siteId) {
      return c.json({ error: 'Enrollment key must have a siteId to generate installer links' }, 400);
    }

    // Verify binary is available (fail fast before creating child key)
    try {
      if (platform === 'windows') {
        MsiSigningService.fromEnv() ? await fetchTemplateMsi() : await fetchRegularMsi();
      } else {
        await fetchMacosPkg();
      }
    } catch (err) {
      console.error(`[installer-link] Failed to fetch ${platform} binary:`, err);
      return c.json({ error: `${platform === 'windows' ? 'MSI' : 'macOS PKG'} not available` }, 503);
    }

    // Generate a child enrollment key
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
        expiresAt: parentKey.expiresAt,
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

    const publicUrl = `${serverUrl.replace(/\/$/, '')}/api/v1/enrollment-keys/public-download/${platform}?token=${rawChildKey}`;
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

  // Fetch binary (template if signing configured, regular if not)
  const signingService = MsiSigningService.fromEnv();
  let binaryBuffer: Buffer;
  try {
    if (platform === 'windows') {
      binaryBuffer = signingService ? await fetchTemplateMsi() : await fetchRegularMsi();
    } else {
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
      const enrollValues = { serverUrl, enrollmentKey: rawToken, enrollmentSecret: globalSecret };

      if (signingService) {
        const patched = replaceMsiPlaceholders(binaryBuffer, enrollValues);
        if (!patched) {
          return c.json({ error: 'Failed to build Windows installer' }, 500);
        }
        resultBuffer = await signingService.signMsi(patched);
        contentType = 'application/octet-stream';
        filename = 'breeze-agent.msi';
      } else {
        resultBuffer = await buildWindowsInstallerZip(binaryBuffer, {
          ...enrollValues, siteId: keyRow.siteId,
        });
        contentType = 'application/zip';
        filename = 'breeze-agent-windows.zip';
      }
    } else {
      // macOS
      resultBuffer = await buildMacosInstallerZip(binaryBuffer, {
        serverUrl,
        enrollmentKey: rawToken,
        enrollmentSecret: globalSecret,
        siteId: keyRow.siteId,
      });
      contentType = 'application/zip';
      filename = 'breeze-agent-macos.zip';
    }

    // Increment usage only after successful build
    await db
      .update(enrollmentKeys)
      .set({ usageCount: sql`${enrollmentKeys.usageCount} + 1` })
      .where(eq(enrollmentKeys.id, keyRow.id));

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
  token: z.string().min(1),
});

publicEnrollmentRoutes.get(
  '/public-download/:platform',
  zValidator('query', publicDownloadQuerySchema),
  async (c) => {
    const platform = c.req.param('platform');
    const { token } = c.req.valid('query');

    if (platform !== 'windows' && platform !== 'macos') {
      return c.json({ error: 'Invalid platform. Must be "windows" or "macos".' }, 400);
    }

    // Look up enrollment key by token hash
    const keyHash = hashEnrollmentKey(token);
    const [enrollmentKey] = await db
      .select()
      .from(enrollmentKeys)
      .where(eq(enrollmentKeys.key, keyHash))
      .limit(1);

    if (!enrollmentKey) {
      return c.json({ error: 'Invalid or expired download link' }, 404);
    }

    return serveInstaller(c, enrollmentKey, platform, token);
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
      expiresAt: row.expiresAt,
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
