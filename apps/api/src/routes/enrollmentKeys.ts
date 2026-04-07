import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, sql, desc, inArray, lt, isNull, or } from 'drizzle-orm';
import { db } from '../db';
import { enrollmentKeys } from '../db/schema';
import { authMiddleware, requireMfa, requirePermission, requireScope, type AuthContext } from '../middleware/auth';
import { randomBytes } from 'crypto';
import { createAuditLogAsync } from '../services/auditService';
import { PERMISSIONS } from '../services/permissions';
import { hashEnrollmentKey } from '../services/enrollmentKeySecurity';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { replaceMsiPlaceholders, buildMacosInstallerZip } from '../services/installerBuilder';
import { getBinarySource, getGithubTemplateMsiUrl, getGithubAgentPkgUrl } from '../services/binarySource';

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

async function fetchTemplateMsi(): Promise<Buffer> {
  if (getBinarySource() === 'github') {
    const url = getGithubTemplateMsiUrl();
    const resp = await fetch(url, { redirect: 'follow' });
    if (!resp.ok) throw new Error(`Failed to fetch template MSI: ${resp.status}`);
    return Buffer.from(await resp.arrayBuffer());
  }
  const binaryDir = resolve(process.env.AGENT_BINARY_DIR || './agent/bin');
  return readFile(join(binaryDir, 'breeze-agent-template.msi'));
}

async function fetchMacosPkg(): Promise<Buffer> {
  if (getBinarySource() === 'github') {
    const url = getGithubAgentPkgUrl('darwin', 'arm64');
    const resp = await fetch(url, { redirect: 'follow' });
    if (!resp.ok) throw new Error(`Failed to fetch macOS PKG: ${resp.status}`);
    return Buffer.from(await resp.arrayBuffer());
  }
  const binaryDir = resolve(process.env.AGENT_BINARY_DIR || './agent/bin');
  return readFile(join(binaryDir, 'breeze-agent-darwin-arm64.pkg'));
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
  async (c) => {
    const auth = c.get('auth');
    const keyId = c.req.param('id')!;
    const platform = c.req.param('platform');

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

    // Fetch template binary BEFORE creating child key (prevent orphans if fetch fails)
    let templateBuffer: Buffer;
    try {
      templateBuffer = platform === 'windows'
        ? await fetchTemplateMsi()
        : await fetchMacosPkg();
    } catch (err) {
      console.error(`[installer] Failed to fetch ${platform} binary:`, err);
      return c.json({ error: `${platform === 'windows' ? 'Template MSI' : 'macOS PKG'} not available` }, 503);
    }

    // Generate a child enrollment key (single-use, same org/site/expiry)
    const rawChildKey = generateEnrollmentKey();
    const childKeyHash = hashEnrollmentKey(rawChildKey);

    const [childKey] = await db
      .insert(enrollmentKeys)
      .values({
        orgId: parentKey.orgId,
        siteId: parentKey.siteId,
        name: `${parentKey.name} (installer)`,
        key: childKeyHash,
        keySecretHash: parentKey.keySecretHash,
        maxUsage: 1,
        expiresAt: parentKey.expiresAt,
        createdBy: auth.user.id,
      })
      .returning();

    if (!childKey) {
      return c.json({ error: 'Failed to generate installer key' }, 500);
    }

    // Build the installer — wrap in try/catch to clean up orphaned child key on failure
    try {
      if (platform === 'windows') {
        const modified = replaceMsiPlaceholders(templateBuffer, {
          serverUrl,
          enrollmentKey: rawChildKey,
          enrollmentSecret: globalSecret,
        });

        // Audit log
        writeEnrollmentKeyAudit(c, auth, {
          orgId: parentKey.orgId,
          action: 'enrollment_key.installer_download',
          keyId: parentKey.id,
          keyName: parentKey.name,
          details: { platform, childKeyId: childKey.id },
        });

        c.header('Content-Type', 'application/octet-stream');
        c.header('Content-Disposition', 'attachment; filename="breeze-agent.msi"');
        c.header('Content-Length', String(modified.length));
        c.header('Cache-Control', 'no-store');
        return c.body(modified as unknown as ArrayBuffer);
      }

      // macOS
      const zipBuffer = await buildMacosInstallerZip(templateBuffer, {
        serverUrl,
        enrollmentKey: rawChildKey,
        enrollmentSecret: globalSecret,
        siteId: parentKey.siteId,
      });

      // Audit log
      writeEnrollmentKeyAudit(c, auth, {
        orgId: parentKey.orgId,
        action: 'enrollment_key.installer_download',
        keyId: parentKey.id,
        keyName: parentKey.name,
        details: { platform, childKeyId: childKey.id },
      });

      c.header('Content-Type', 'application/zip');
      c.header('Content-Disposition', 'attachment; filename="breeze-agent-macos.zip"');
      c.header('Content-Length', String(zipBuffer.length));
      c.header('Cache-Control', 'no-store');
      return c.body(zipBuffer as unknown as ArrayBuffer);
    } catch (err) {
      console.error('[installer] Build failed:', err);
      await db.delete(enrollmentKeys).where(eq(enrollmentKeys.id, childKey.id)).catch(() => {});
      return c.json({ error: 'Failed to build installer' }, 500);
    }
  }
);
