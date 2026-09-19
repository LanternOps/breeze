import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { zValidator } from '../../lib/validation';
import { requireMfa } from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';
import {
  SendingDomainServiceError, forceReleaseSendingDomain, listAllSendingDomainsWithMetrics,
  suspendSendingDomain, unsuspendSendingDomain,
} from '../../services/emailDomains/sendingDomainService';

/**
 * Platform-admin surface for sending domains (spec §7, §9.1 kill switch).
 *
 * The platform-admin gate is deliberately NOT applied here — routes/admin/index.ts
 * applies it to everything it mounts, and applying it twice would authenticate
 * and audit-log the same request twice (the note at routes/admin/index.ts:20).
 * MFA is per mutating route, the same posture as tenantErasureRoutes. The name
 * of that middleware is left unwritten on purpose: sendingDomains.test.ts scans
 * this file for it, and a substring scan cannot tell a comment from a call.
 *
 * Like the partner routes, nothing here calls the provider: suspend/unsuspend
 * move the row and enqueue, and force-release writes the release outbox row the
 * worker drains.
 */
export const adminSendingDomainsRoutes = new Hono();

const MAX_LIST = 200;
const DEFAULT_LIST = 50;

const idParamSchema = z.object({ id: z.string().guid() });
// No `.max(MAX_LIST)` here on purpose: an oversized `?limit=` is CLAMPED by the
// Math.min below, not refused. An admin paging through a long list should get
// the largest page this endpoint will serve, not a 400 they have to decode.
const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).optional(),
});

function fail(c: Context, err: unknown): Response {
  if (err instanceof SendingDomainServiceError) {
    return c.json({ error: err.code, message: err.message }, err.status);
  }
  throw err;
}

adminSendingDomainsRoutes.get('/', zValidator('query', listQuerySchema), async (c) => {
  const { limit } = c.req.valid('query');
  const data = await listAllSendingDomainsWithMetrics({ limit: Math.min(limit ?? DEFAULT_LIST, MAX_LIST) });
  return c.json({ data });
});

adminSendingDomainsRoutes.post('/:id/suspend', requireMfa(), zValidator('param', idParamSchema), async (c) => {
  const { id } = c.req.valid('param');
  try {
    await suspendSendingDomain(id);
  } catch (err) {
    return fail(c, err);
  }
  writeRouteAudit(c as never, {
    orgId: null, action: 'partner_sending_domain.admin_suspend',
    resourceType: 'partner_sending_domain', resourceId: id,
  });
  return c.json({ success: true, status: 'suspended' });
});

adminSendingDomainsRoutes.post('/:id/unsuspend', requireMfa(), zValidator('param', idParamSchema), async (c) => {
  const { id } = c.req.valid('param');
  try {
    await unsuspendSendingDomain(id);
  } catch (err) {
    return fail(c, err);
  }
  writeRouteAudit(c as never, {
    orgId: null, action: 'partner_sending_domain.admin_unsuspend',
    resourceType: 'partner_sending_domain', resourceId: id,
  });
  return c.json({ success: true });
});

adminSendingDomainsRoutes.post('/:id/force-release', requireMfa(), zValidator('param', idParamSchema), async (c) => {
  const { id } = c.req.valid('param');
  try {
    await forceReleaseSendingDomain(id);
  } catch (err) {
    return fail(c, err);
  }
  writeRouteAudit(c as never, {
    orgId: null, action: 'partner_sending_domain.admin_force_release',
    resourceType: 'partner_sending_domain', resourceId: id,
  });
  return c.json({ success: true });
});
