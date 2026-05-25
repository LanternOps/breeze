/**
 * POST /admin/tenant-erasure  — platform-admin GDPR org-wide erasure
 *
 * Body:  { orgId: uuid, confirmEmail: string }
 * Auth:  platform admin (mounted under adminRoutes) + MFA (this file).
 *
 * Behavior:
 *   1. Validate `confirmEmail` matches the caller's account email
 *      (case-insensitive). This is the second confirmation layer on
 *      top of platform-admin + MFA; pasting the wrong UUID is the
 *      single most-likely operator mistake.
 *   2. Lookup the org so we can surface name/partner in the audit.
 *   3. Enqueue a BullMQ job to perform the cascade (see
 *      `apps/api/src/jobs/tenantErasure.ts`). Returns 202 immediately;
 *      the cascade walks ~170 tables and can run for minutes on a
 *      large tenant.
 *
 * No org-bypass: the cascade only deletes rows where org_id = the
 * specified UUID. Cross-tenant deletion is impossible by construction.
 */

import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { organizations } from '../../db/schema';
import { requireMfa } from '../../middleware/auth';
import { enqueueTenantErasure } from '../../jobs/tenantErasure';
import { createAuditLog } from '../../services/auditService';
import { getTrustedClientIpOrUndefined } from '../../services/clientIp';

export const tenantErasureRoutes = new Hono();

const erasureSchema = z.object({
  orgId: z.string().uuid(),
  confirmEmail: z.string().email(),
});

tenantErasureRoutes.post(
  '/',
  requireMfa(),
  zValidator('json', erasureSchema),
  async (c) => {
    const auth = c.get('auth');
    const { orgId, confirmEmail } = c.req.valid('json');

    if (confirmEmail.trim().toLowerCase() !== auth.user.email.trim().toLowerCase()) {
      // Don't audit the failed attempt here — platformAdminMiddleware
      // already audited "platform_admin.tenant-erasure" with the path,
      // and emitting a second failure row on every typo would be noise.
      return c.json(
        { error: 'confirmEmail must match your account email' },
        400,
      );
    }

    // Lookup the org under system scope so we can capture its name in
    // the audit details (the cascade itself drops the org so name
    // would be unrecoverable downstream).
    const org = await withSystemDbAccessContext(async () => {
      const rows = await db
        .select({
          id: organizations.id,
          name: organizations.name,
          partnerId: organizations.partnerId,
        })
        .from(organizations)
        .where(eq(organizations.id, orgId))
        .limit(1);
      return rows[0] ?? null;
    });

    if (!org) {
      return c.json({ error: 'org not found' }, 404);
    }

    const enqueued = await enqueueTenantErasure({
      orgId,
      performedBy: auth.user.id,
      performedByEmail: auth.user.email,
    });

    // Audit the enqueue event explicitly. The cascade worker will write
    // its own `tenant.erasure.started` + `tenant.erasure.completed`
    // events; this row captures the HTTP-layer accept.
    await createAuditLog({
      orgId: null,
      actorType: 'user',
      actorId: auth.user.id,
      actorEmail: auth.user.email,
      action: 'tenant.erasure.enqueued',
      resourceType: 'organization',
      resourceId: orgId,
      resourceName: org.name,
      details: {
        jobId: enqueued.id,
        partnerId: org.partnerId,
      },
      ipAddress: getTrustedClientIpOrUndefined(c),
      userAgent: c.req.header('user-agent'),
      result: 'success',
    });

    return c.json(
      {
        status: 'accepted' as const,
        jobId: enqueued.id,
        orgId,
        orgName: org.name,
        partnerId: org.partnerId,
      },
      202,
    );
  },
);
