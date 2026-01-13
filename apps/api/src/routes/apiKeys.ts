import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq, sql, desc } from 'drizzle-orm';
import { db } from '../db';
import { apiKeys, organizations } from '../db/schema';
import { authMiddleware, requireScope } from '../middleware/auth';
import { createHash, randomBytes } from 'crypto';

export const apiKeyRoutes = new Hono();

// ============================================
// Helper Functions
// ============================================

function generateApiKey(): { fullKey: string; keyPrefix: string; keyHash: string } {
  // Generate 32 random bytes and encode as base64url (43 chars)
  const randomPart = randomBytes(32).toString('base64url').slice(0, 32);
  const fullKey = `brz_${randomPart}`;
  const keyPrefix = fullKey.slice(0, 12); // "brz_" + first 8 chars
  const keyHash = createHash('sha256').update(fullKey).digest('hex');

  return { fullKey, keyPrefix, keyHash };
}

function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

function getPagination(query: { page?: string; limit?: string }) {
  const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit ?? '50', 10) || 50));
  return { page, limit, offset: (page - 1) * limit };
}

async function ensureOrgAccess(orgId: string, auth: { scope: string; partnerId: string | null; orgId: string | null }) {
  if (auth.scope === 'organization') {
    return auth.orgId === orgId;
  }

  if (auth.scope === 'partner') {
    const [org] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(
        and(
          eq(organizations.id, orgId),
          eq(organizations.partnerId, auth.partnerId as string)
        )
      )
      .limit(1);

    return Boolean(org);
  }

  // system scope has access to all
  return true;
}

// ============================================
// Validation Schemas
// ============================================

const listApiKeysSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  orgId: z.string().uuid().optional(),
  status: z.enum(['active', 'revoked', 'expired']).optional()
});

const createApiKeySchema = z.object({
  orgId: z.string().uuid(),
  name: z.string().min(1).max(255),
  scopes: z.array(z.string()).default([]),
  expiresAt: z.string().datetime().optional(),
  rateLimit: z.number().int().min(1).max(100000).default(1000)
});

const updateApiKeySchema = z.object({
  name: z.string().min(1).max(255).optional(),
  scopes: z.array(z.string()).optional(),
  rateLimit: z.number().int().min(1).max(100000).optional()
});

// ============================================
// Routes
// ============================================

// Apply auth middleware to all routes
apiKeyRoutes.use('*', authMiddleware);

// GET /api-keys - List API keys for org (don't return keyHash)
apiKeyRoutes.get(
  '/',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listApiKeysSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const { page, limit, offset } = getPagination(query);

    // Build conditions array
    const conditions: ReturnType<typeof eq>[] = [];

    // Filter by org access based on scope
    if (auth.scope === 'organization') {
      if (!auth.orgId) {
        return c.json({ error: 'Organization context required' }, 403);
      }
      conditions.push(eq(apiKeys.orgId, auth.orgId));
    } else if (auth.scope === 'partner') {
      if (query.orgId) {
        const hasAccess = await ensureOrgAccess(query.orgId, auth);
        if (!hasAccess) {
          return c.json({ error: 'Access to this organization denied' }, 403);
        }
        conditions.push(eq(apiKeys.orgId, query.orgId));
      } else {
        // Get API keys from all orgs under this partner
        const partnerOrgs = await db
          .select({ id: organizations.id })
          .from(organizations)
          .where(eq(organizations.partnerId, auth.partnerId as string));

        const orgIds = partnerOrgs.map(o => o.id);
        if (orgIds.length === 0) {
          return c.json({
            data: [],
            pagination: { page, limit, total: 0 }
          });
        }
        conditions.push(sql`${apiKeys.orgId} = ANY(${orgIds})` as ReturnType<typeof eq>);
      }
    } else if (auth.scope === 'system') {
      if (query.orgId) {
        conditions.push(eq(apiKeys.orgId, query.orgId));
      }
    }

    // Filter by status
    if (query.status) {
      conditions.push(eq(apiKeys.status, query.status));
    }

    const whereCondition = conditions.length > 0 ? and(...conditions) : undefined;

    // Get total count
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(apiKeys)
      .where(whereCondition);
    const total = Number(countResult[0]?.count ?? 0);

    // Get API keys (excluding keyHash for security)
    const keyList = await db
      .select({
        id: apiKeys.id,
        orgId: apiKeys.orgId,
        name: apiKeys.name,
        keyPrefix: apiKeys.keyPrefix,
        scopes: apiKeys.scopes,
        expiresAt: apiKeys.expiresAt,
        lastUsedAt: apiKeys.lastUsedAt,
        usageCount: apiKeys.usageCount,
        rateLimit: apiKeys.rateLimit,
        createdBy: apiKeys.createdBy,
        createdAt: apiKeys.createdAt,
        updatedAt: apiKeys.updatedAt,
        status: apiKeys.status
      })
      .from(apiKeys)
      .where(whereCondition)
      .orderBy(desc(apiKeys.createdAt))
      .limit(limit)
      .offset(offset);

    return c.json({
      data: keyList,
      pagination: { page, limit, total }
    });
  }
);

// POST /api-keys - Create new API key (return full key ONCE on creation)
apiKeyRoutes.post(
  '/',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', createApiKeySchema),
  async (c) => {
    const auth = c.get('auth');
    const data = c.req.valid('json');

    // Verify org access
    let orgId = data.orgId;

    if (auth.scope === 'organization') {
      if (!auth.orgId) {
        return c.json({ error: 'Organization context required' }, 403);
      }
      // Organization users can only create keys for their own org
      if (orgId !== auth.orgId) {
        return c.json({ error: 'Can only create API keys for your organization' }, 403);
      }
    } else if (auth.scope === 'partner') {
      const hasAccess = await ensureOrgAccess(orgId, auth);
      if (!hasAccess) {
        return c.json({ error: 'Access to this organization denied' }, 403);
      }
    }
    // System scope can create keys for any org

    // Generate the API key
    const { fullKey, keyPrefix, keyHash } = generateApiKey();

    // Create the API key record
    const [apiKey] = await db
      .insert(apiKeys)
      .values({
        orgId,
        name: data.name,
        keyHash,
        keyPrefix,
        scopes: data.scopes,
        expiresAt: data.expiresAt ? new Date(data.expiresAt) : null,
        rateLimit: data.rateLimit,
        createdBy: auth.user.id,
        status: 'active'
      })
      .returning();

    if (!apiKey) {
      return c.json({ error: 'Failed to create API key' }, 500);
    }

    // Return the full key ONCE - it won't be retrievable later
    return c.json({
      id: apiKey.id,
      orgId: apiKey.orgId,
      name: apiKey.name,
      key: fullKey, // Full key returned only on creation
      keyPrefix: apiKey.keyPrefix,
      scopes: apiKey.scopes,
      expiresAt: apiKey.expiresAt,
      rateLimit: apiKey.rateLimit,
      createdBy: apiKey.createdBy,
      createdAt: apiKey.createdAt,
      status: apiKey.status,
      warning: 'Store this API key securely. It will not be shown again.'
    }, 201);
  }
);

// GET /api-keys/:id - Get API key details
apiKeyRoutes.get(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const keyId = c.req.param('id');

    // Get API key (excluding keyHash)
    const [apiKey] = await db
      .select({
        id: apiKeys.id,
        orgId: apiKeys.orgId,
        name: apiKeys.name,
        keyPrefix: apiKeys.keyPrefix,
        scopes: apiKeys.scopes,
        expiresAt: apiKeys.expiresAt,
        lastUsedAt: apiKeys.lastUsedAt,
        usageCount: apiKeys.usageCount,
        rateLimit: apiKeys.rateLimit,
        createdBy: apiKeys.createdBy,
        createdAt: apiKeys.createdAt,
        updatedAt: apiKeys.updatedAt,
        status: apiKeys.status
      })
      .from(apiKeys)
      .where(eq(apiKeys.id, keyId))
      .limit(1);

    if (!apiKey) {
      return c.json({ error: 'API key not found' }, 404);
    }

    // Check org access
    const hasAccess = await ensureOrgAccess(apiKey.orgId, auth);
    if (!hasAccess) {
      return c.json({ error: 'Access denied' }, 403);
    }

    return c.json(apiKey);
  }
);

// PATCH /api-keys/:id - Update name, scopes, rateLimit
apiKeyRoutes.patch(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', updateApiKeySchema),
  async (c) => {
    const auth = c.get('auth');
    const keyId = c.req.param('id');
    const data = c.req.valid('json');

    if (Object.keys(data).length === 0) {
      return c.json({ error: 'No updates provided' }, 400);
    }

    // Get existing API key
    const [existingKey] = await db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.id, keyId))
      .limit(1);

    if (!existingKey) {
      return c.json({ error: 'API key not found' }, 404);
    }

    // Check org access
    const hasAccess = await ensureOrgAccess(existingKey.orgId, auth);
    if (!hasAccess) {
      return c.json({ error: 'Access denied' }, 403);
    }

    // Cannot update revoked or expired keys
    if (existingKey.status !== 'active') {
      return c.json({ error: `Cannot update ${existingKey.status} API key` }, 400);
    }

    // Build updates object
    const updates: Record<string, unknown> = { updatedAt: new Date() };

    if (data.name !== undefined) updates.name = data.name;
    if (data.scopes !== undefined) updates.scopes = data.scopes;
    if (data.rateLimit !== undefined) updates.rateLimit = data.rateLimit;

    const [updated] = await db
      .update(apiKeys)
      .set(updates)
      .where(eq(apiKeys.id, keyId))
      .returning({
        id: apiKeys.id,
        orgId: apiKeys.orgId,
        name: apiKeys.name,
        keyPrefix: apiKeys.keyPrefix,
        scopes: apiKeys.scopes,
        expiresAt: apiKeys.expiresAt,
        lastUsedAt: apiKeys.lastUsedAt,
        usageCount: apiKeys.usageCount,
        rateLimit: apiKeys.rateLimit,
        createdBy: apiKeys.createdBy,
        createdAt: apiKeys.createdAt,
        updatedAt: apiKeys.updatedAt,
        status: apiKeys.status
      });

    return c.json(updated);
  }
);

// DELETE /api-keys/:id - Revoke API key (soft delete, set status=revoked)
apiKeyRoutes.delete(
  '/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const keyId = c.req.param('id');

    // Get existing API key
    const [existingKey] = await db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.id, keyId))
      .limit(1);

    if (!existingKey) {
      return c.json({ error: 'API key not found' }, 404);
    }

    // Check org access
    const hasAccess = await ensureOrgAccess(existingKey.orgId, auth);
    if (!hasAccess) {
      return c.json({ error: 'Access denied' }, 403);
    }

    // Cannot revoke already revoked keys
    if (existingKey.status === 'revoked') {
      return c.json({ error: 'API key is already revoked' }, 400);
    }

    // Soft delete by setting status to revoked
    const [revoked] = await db
      .update(apiKeys)
      .set({
        status: 'revoked',
        updatedAt: new Date()
      })
      .where(eq(apiKeys.id, keyId))
      .returning({
        id: apiKeys.id,
        name: apiKeys.name,
        keyPrefix: apiKeys.keyPrefix,
        status: apiKeys.status,
        updatedAt: apiKeys.updatedAt
      });

    return c.json({
      success: true,
      message: 'API key revoked successfully',
      apiKey: revoked
    });
  }
);

// POST /api-keys/:id/rotate - Generate new key, invalidate old one
apiKeyRoutes.post(
  '/:id/rotate',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const keyId = c.req.param('id');

    // Get existing API key
    const [existingKey] = await db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.id, keyId))
      .limit(1);

    if (!existingKey) {
      return c.json({ error: 'API key not found' }, 404);
    }

    // Check org access
    const hasAccess = await ensureOrgAccess(existingKey.orgId, auth);
    if (!hasAccess) {
      return c.json({ error: 'Access denied' }, 403);
    }

    // Cannot rotate non-active keys
    if (existingKey.status !== 'active') {
      return c.json({ error: `Cannot rotate ${existingKey.status} API key` }, 400);
    }

    // Generate new key
    const { fullKey, keyPrefix, keyHash } = generateApiKey();

    // Update the key with new hash and prefix
    const [rotated] = await db
      .update(apiKeys)
      .set({
        keyHash,
        keyPrefix,
        updatedAt: new Date(),
        // Reset usage stats on rotation (optional - could preserve them)
        usageCount: 0,
        lastUsedAt: null
      })
      .where(eq(apiKeys.id, keyId))
      .returning({
        id: apiKeys.id,
        orgId: apiKeys.orgId,
        name: apiKeys.name,
        keyPrefix: apiKeys.keyPrefix,
        scopes: apiKeys.scopes,
        expiresAt: apiKeys.expiresAt,
        rateLimit: apiKeys.rateLimit,
        createdBy: apiKeys.createdBy,
        createdAt: apiKeys.createdAt,
        updatedAt: apiKeys.updatedAt,
        status: apiKeys.status
      });

    // Return the new full key ONCE
    return c.json({
      ...rotated,
      key: fullKey, // New full key returned only on rotation
      warning: 'Store this new API key securely. The old key has been invalidated and this new key will not be shown again.'
    });
  }
);
