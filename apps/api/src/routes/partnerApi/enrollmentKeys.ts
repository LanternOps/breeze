import { Hono } from 'hono';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { db } from '../../db';
import { enrollmentKeys } from '../../db/schema';
import { sites } from '../../db/schema/orgs';
import { requirePartnerApiScope } from '../../middleware/partnerApiAuth';
import { hashEnrollmentKey } from '../../services/enrollmentKeySecurity';
import { writeAuditEventAsync } from '../../services/auditEvents';
import { getRedis } from '../../services/redis';
import { zValidator } from '../../lib/validation';

export const partnerEnrollmentKeyRoutes = new Hono();

const IDEMPOTENCY_TTL_SECONDS = 86_400; // 24 hours

function envInt(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

const DEFAULT_TTL_MINUTES = envInt('ENROLLMENT_KEY_DEFAULT_TTL_MINUTES', 60);

// Platform-operator-configured cap on how long a partner-API-minted enrollment
// key may be valid. Partners cannot bypass this by supplying a larger ttlMinutes.
// Default: 7 days (10_080 minutes). Override with the env var to raise or lower
// the cap without a code change.
const PARTNER_API_MAX_TTL_MINUTES = envInt('PARTNER_API_ENROLLMENT_KEY_MAX_TTL_MINUTES', 10_080);

const createEnrollmentKeySchema = z.object({
  orgId: z.string().uuid(),
  siteId: z.string().uuid().optional(),
  name: z.string().min(1).max(255),
  maxUsage: z.number().int().min(1).max(100_000).default(1),
  ttlMinutes: z.number().int().min(1).max(PARTNER_API_MAX_TTL_MINUTES).default(
    Math.min(DEFAULT_TTL_MINUTES, PARTNER_API_MAX_TTL_MINUTES),
  ),
}).strict();

function generateEnrollmentKey(): string {
  return randomBytes(32).toString('hex');
}

// POST /enrollment-keys — create a single-use enrollment key via the Partner API.
// Requires the enrollment-keys:write scope on the calling service principal.
// This endpoint mirrors the user-facing POST /api/v1/enrollment-keys but is
// accessible with an X-API-Key (brz_sp_...) so Vigil can generate tokens
// server-side without a user session or MFA step-up.
//
// Idempotency: pass X-Idempotency-Key to get a cached 200 response for retries
// within 24 h. The raw key is only returned on the initial 201; replays return
// the record metadata without it (the raw key cannot be reconstructed).
partnerEnrollmentKeyRoutes.post(
  '/enrollment-keys',
  requirePartnerApiScope('enrollment-keys:write'),
  zValidator('json', createEnrollmentKeySchema),
  async (c) => {
    const principal = c.get('partnerApiPrincipal');
    const data = c.req.valid('json');
    const idempotencyKey = c.req.header('X-Idempotency-Key');

    // Verify the requested org is accessible to this service principal.
    if (!principal.accessibleOrgIds.includes(data.orgId)) {
      return c.json({ error: 'Access to this organization denied' }, 403);
    }

    // Verify siteId belongs to the target org when provided.
    if (data.siteId) {
      const [site] = await db
        .select({ id: sites.id })
        .from(sites)
        .where(and(eq(sites.id, data.siteId!), eq(sites.orgId, data.orgId)))
        .limit(1);
      if (!site) {
        return c.json({ error: 'siteId does not belong to the specified org' }, 400);
      }
    }

    // Check idempotency cache before creating a new key.
    if (idempotencyKey) {
      const redis = getRedis();
      if (redis) {
        const cacheKey = `partner_enroll_key_idem:${principal.partnerServicePrincipalId}:${idempotencyKey}`;
        const cached = await redis.get(cacheKey).catch(() => null);
        if (cached) {
          const parsed = JSON.parse(cached) as Record<string, unknown>;
          // Return the cached record without the raw key — it cannot be
          // reconstructed and must not leave the server a second time.
          return c.json({ ...parsed, key: undefined, idempotencyReplay: true }, 200);
        }
      }
    }

    const rawKey = generateEnrollmentKey();
    const keyHash = hashEnrollmentKey(rawKey);
    const expiresAt = new Date(Date.now() + data.ttlMinutes * 60 * 1000);

    const [enrollmentKey] = await db
      .insert(enrollmentKeys)
      .values({
        orgId: data.orgId,
        siteId: data.siteId ?? null,
        name: data.name,
        key: keyHash,
        maxUsage: data.maxUsage,
        expiresAt,
        createdBy: principal.partnerServicePrincipalId,
      })
      .returning();

    if (!enrollmentKey) {
      return c.json({ error: 'Failed to create enrollment key' }, 500);
    }

    writeAuditEventAsync(c, {
      orgId: data.orgId,
      actorType: 'api_key',
      actorId: principal.partnerServicePrincipalId,
      action: 'enrollment_key.create',
      resourceType: 'enrollment_key',
      resourceId: enrollmentKey.id,
      resourceName: enrollmentKey.name,
      result: 'success',
      details: {
        siteId: enrollmentKey.siteId,
        maxUsage: enrollmentKey.maxUsage,
        expiresAt: enrollmentKey.expiresAt,
        via: 'partner_api',
        partnerId: principal.partnerId,
      },
    });

    const { key: _hash, ...safeRecord } = enrollmentKey;

    // Cache the safe record (no raw key) for idempotency replay.
    if (idempotencyKey) {
      const redis = getRedis();
      if (redis) {
        const cacheKey = `partner_enroll_key_idem:${principal.partnerServicePrincipalId}:${idempotencyKey}`;
        await redis.set(cacheKey, JSON.stringify(safeRecord), 'EX', IDEMPOTENCY_TTL_SECONDS).catch(() => {
          // Non-fatal: losing the cache entry means the next call creates a new
          // key rather than replaying. Acceptable — better than blocking the response.
        });
      }
    }

    return c.json({ ...safeRecord, key: rawKey }, 201);
  }
);
