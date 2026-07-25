import { Hono } from 'hono';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { db, withSystemDbAccessContext } from '../../db';
import { enrollmentKeys } from '../../db/schema';
import { sites } from '../../db/schema/orgs';
import { requirePartnerApiScope } from '../../middleware/partnerApiAuth';
import { hashEnrollmentKey } from '../../services/enrollmentKeySecurity';
import { zValidator } from '../../lib/validation';

export const partnerEnrollmentKeyRoutes = new Hono();

const MAX_TTL_MINUTES = 525_600; // 1 year

const createEnrollmentKeySchema = z.object({
  orgId: z.string().uuid(),
  siteId: z.string().uuid().optional(),
  name: z.string().min(1).max(255),
  maxUsage: z.number().int().min(1).max(100_000).default(1),
  ttlMinutes: z.number().int().min(1).max(MAX_TTL_MINUTES).default(60),
}).strict();

function generateEnrollmentKey(): string {
  return randomBytes(32).toString('hex');
}

// POST /enrollment-keys â€” create a single-use enrollment key via the Partner API.
// Requires the enrollment-keys:write scope on the calling service principal.
// This endpoint mirrors the user-facing POST /api/v1/enrollment-keys but is
// accessible with an X-API-Key (brz_sp_...) so Vigil can generate tokens
// server-side without a user session or MFA step-up.
partnerEnrollmentKeyRoutes.post(
  '/enrollment-keys',
  requirePartnerApiScope('enrollment-keys:write'),
  zValidator('json', createEnrollmentKeySchema),
  async (c) => {
    const principal = c.get('partnerApiPrincipal');
    const data = c.req.valid('json');

    // Verify the requested org is accessible to this service principal.
    if (!principal.accessibleOrgIds.includes(data.orgId)) {
      return c.json({ error: 'Access to this organization denied' }, 403);
    }

    // Verify siteId belongs to the target org when provided.
    if (data.siteId) {
      const [site] = await withSystemDbAccessContext(() =>
        db
          .select({ id: sites.id })
          .from(sites)
          .where(and(eq(sites.id, data.siteId!), eq(sites.orgId, data.orgId)))
          .limit(1)
      );
      if (!site) {
        return c.json({ error: 'siteId does not belong to the specified org' }, 400);
      }
    }

    const rawKey = generateEnrollmentKey();
    const keyHash = hashEnrollmentKey(rawKey);
    const expiresAt = new Date(Date.now() + data.ttlMinutes * 60 * 1000);

    const [enrollmentKey] = await withSystemDbAccessContext(() =>
      db
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
        .returning()
    );

    if (!enrollmentKey) {
      return c.json({ error: 'Failed to create enrollment key' }, 500);
    }

    const { key: _hash, ...safeRecord } = enrollmentKey;
    return c.json({ ...safeRecord, key: rawKey }, 201);
  }
);
