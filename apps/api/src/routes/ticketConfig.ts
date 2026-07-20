import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { zValidator } from '../lib/validation';
import { z } from 'zod';
import { authMiddleware, requireScope, requirePermission } from '../middleware/auth';
import type { AuthContext } from '../middleware/auth';
import { PERMISSIONS, hasPermission, type UserPermissions } from '../services/permissions';
import {
  createTicketStatusSchema, updateTicketStatusSchema, reorderTicketStatusesSchema,
  prioritySettingsSchema,
  createCustomerEmailDomainSchema, updateCustomerEmailDomainSchema
} from '@breeze/shared';
import {
  getTicketConfig, createTicketStatus, updateTicketStatus, reorderTicketStatuses,
  upsertPrioritySettings, TicketConfigServiceError,
  listEmailInboundQueue, convertEmailInbound, dismissEmailInbound,
  listCustomerEmailDomains, createCustomerEmailDomain, updateCustomerEmailDomain, deleteCustomerEmailDomain,
} from '../services/ticketConfigService';
import { canManagePartnerWidePolicies } from '../services/partnerWideAccess';
import { writeRouteAudit } from '../services/auditEvents';

export const ticketConfigRoutes = new Hono();

// Hub auth (ticketCategories.ts pattern): requireScope/requirePermission below
// depend on c.get('auth') being populated.
ticketConfigRoutes.use('*', authMiddleware);

const idParam = z.object({ id: z.string().guid() });

const scopes = requireScope('partner', 'system');
const readPerm = requirePermission(PERMISSIONS.TICKETS_READ.resource, PERMISSIONS.TICKETS_READ.action);
const writePerm = requirePermission(PERMISSIONS.TICKETS_WRITE.resource, PERMISSIONS.TICKETS_WRITE.action);
const partnerGlobalDeniedMessage = 'Full partner organization access is required to manage partner-wide ticket configuration';

const requirePartnerGlobalAccess = async (c: Context, next: Next) => {
  if (!canManagePartnerWidePolicies(c.get('auth') as AuthContext)) {
    return c.json({ error: partnerGlobalDeniedMessage }, 403);
  }
  return next();
};

function handleServiceError(c: { json: (b: unknown, s: number) => Response }, err: unknown): Response {
  if (err instanceof TicketConfigServiceError) {
    return c.json({ error: err.message, code: err.code }, err.status);
  }
  throw err;
}

// Ticket configuration is partner-scoped: every status/priority row keys on
// partner_id. The caller must carry a partnerId (partner scope always does;
// system callers must too, since there's no global config). Mutating config is
// an admin action — v1 admin proxy (mirrors timeEntries' manageAll): platform
// admins or wildcard-permission roles only.
function requirePartnerId(c: { get: (k: 'auth') => unknown; json: (b: unknown, s: number) => Response }): string | Response {
  const auth = c.get('auth') as AuthContext;
  if (!auth.partnerId) return c.json({ error: 'Partner context required' }, 403);
  return auth.partnerId;
}

// Middleware version of the admin check — runs after writePerm (which populates
// c.get('permissions')) and gates mutating routes so a non-admin gets a clear
// admin-403 rather than a generic permission-denied message. Full-partner
// capability is checked first so wildcard/platform-admin status cannot bypass
// selected/none organization access.
const adminMiddleware = async (c: Context, next: Next) => {
  const auth = c.get('auth') as AuthContext;
  if (!canManagePartnerWidePolicies(auth)) {
    return c.json({ error: partnerGlobalDeniedMessage }, 403);
  }
  const perms = c.get('permissions') as UserPermissions | undefined;
  const isAdmin = auth.user.isPlatformAdmin || (perms ? hasPermission(perms, '*', '*') : false);
  if (!isAdmin) return c.json({ error: 'Managing ticket configuration requires an admin role' }, 403);
  return next();
};

// GET / — full partner ticketing config (statuses + priority settings).
ticketConfigRoutes.get('/', scopes, readPerm, requirePartnerGlobalAccess, async (c) => {
  const partnerId = requirePartnerId(c);
  if (partnerId instanceof Response) return partnerId;
  const data = await getTicketConfig(partnerId);
  return c.json({ data });
});

// Literal paths BEFORE /:id (Hono matching is registration-ordered).

const emailInboundQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

// GET /email-inbound — review queue (quarantined + failed). Admin-only surface,
// so it carries writePerm + adminMiddleware like the mutations beside it. The
// list query runs under the request partner context (RLS auto-scopes the rows)
// and is additionally filtered by the resolved partnerId in the service.
ticketConfigRoutes.get('/email-inbound', scopes, writePerm, adminMiddleware, zValidator('query', emailInboundQuerySchema), async (c) => {
  const partnerId = requirePartnerId(c);
  if (partnerId instanceof Response) return partnerId;
  const { page, limit } = c.req.valid('query');
  const result = await listEmailInboundQueue(partnerId, { page, limit });
  return c.json(result);
});

const convertEmailInboundSchema = z.object({ orgId: z.string().guid() });

// POST /email-inbound/:id/convert — create a source:'email' ticket in the chosen
// org and link the inbound row. The actor is the REAL authenticated admin (built
// from c.get('auth').user), so convert is correctly attributed in the audit/event
// trail — no synthetic sentinel.
ticketConfigRoutes.post('/email-inbound/:id/convert', scopes, writePerm, adminMiddleware, zValidator('param', idParam), zValidator('json', convertEmailInboundSchema), async (c) => {
  const partnerId = requirePartnerId(c);
  if (partnerId instanceof Response) return partnerId;
  const auth = c.get('auth') as AuthContext;
  try {
    const { id } = c.req.valid('param');
    const { orgId } = c.req.valid('json');
    const row = await convertEmailInbound(partnerId, id, orgId, { userId: auth.user.id, name: auth.user.name });
    writeRouteAudit(c, {
      orgId: null,
      action: 'ticket_email_inbound.convert',
      resourceType: 'ticket_email_inbound',
      resourceId: id,
      details: {
        partnerId,
        orgId,
        ticketId: row.ticketId,
        changedFields: ['parseStatus', 'ticketId']
      }
    });
    return c.json({ data: row });
  } catch (err) {
    return handleServiceError(c, err);
  }
});

// PATCH /email-inbound/:id/dismiss — drop a quarantined/failed row out of the
// review queue (parse_status='ignored'). No ticket created.
ticketConfigRoutes.patch('/email-inbound/:id/dismiss', scopes, writePerm, adminMiddleware, zValidator('param', idParam), async (c) => {
  const partnerId = requirePartnerId(c);
  if (partnerId instanceof Response) return partnerId;
  try {
    const { id } = c.req.valid('param');
    const row = await dismissEmailInbound(partnerId, id);
    writeRouteAudit(c, {
      orgId: null,
      action: 'ticket_email_inbound.dismiss',
      resourceType: 'ticket_email_inbound',
      resourceId: id,
      details: { partnerId, changedFields: ['parseStatus'] }
    });
    return c.json({ data: row });
  } catch (err) {
    return handleServiceError(c, err);
  }
});

// --- Phase 5: customer email-domain routing (sender domain -> customer org) ---

// GET /inbound-domains — list this partner's sender-domain mappings (joined org name).
ticketConfigRoutes.get('/inbound-domains', scopes, readPerm, adminMiddleware, async (c) => {
  const partnerId = requirePartnerId(c);
  if (partnerId instanceof Response) return partnerId;
  const data = await listCustomerEmailDomains(partnerId);
  return c.json({ data });
});

// POST /inbound-domains — map a customer sender domain to one of the partner's orgs.
ticketConfigRoutes.post('/inbound-domains', scopes, writePerm, adminMiddleware, zValidator('json', createCustomerEmailDomainSchema), async (c) => {
  const partnerId = requirePartnerId(c);
  if (partnerId instanceof Response) return partnerId;
  const auth = c.get('auth') as AuthContext;
  try {
    const data = c.req.valid('json');
    const row = await createCustomerEmailDomain(partnerId, data, { userId: auth.user.id });
    writeRouteAudit(c, {
      orgId: null,
      action: 'ticket_customer_email_domain.create',
      resourceType: 'ticket_customer_email_domain',
      resourceId: row.id,
      resourceName: row.domain,
      details: { partnerId, orgId: data.orgId, changedFields: Object.keys(data) }
    });
    return c.json({ data: row });
  } catch (err) {
    return handleServiceError(c, err);
  }
});

// PATCH /inbound-domains/:id — update org/auto-create/active for a mapping.
ticketConfigRoutes.patch('/inbound-domains/:id', scopes, writePerm, adminMiddleware, zValidator('param', idParam), zValidator('json', updateCustomerEmailDomainSchema), async (c) => {
  const partnerId = requirePartnerId(c);
  if (partnerId instanceof Response) return partnerId;
  try {
    const { id } = c.req.valid('param');
    const data = c.req.valid('json');
    const row = await updateCustomerEmailDomain(partnerId, id, data);
    writeRouteAudit(c, {
      orgId: null,
      action: 'ticket_customer_email_domain.update',
      resourceType: 'ticket_customer_email_domain',
      resourceId: id,
      resourceName: row.domain,
      details: { partnerId, changedFields: Object.keys(data) }
    });
    return c.json({ data: row });
  } catch (err) {
    return handleServiceError(c, err);
  }
});

// DELETE /inbound-domains/:id — remove a mapping.
ticketConfigRoutes.delete('/inbound-domains/:id', scopes, writePerm, adminMiddleware, zValidator('param', idParam), async (c) => {
  const partnerId = requirePartnerId(c);
  if (partnerId instanceof Response) return partnerId;
  try {
    const { id } = c.req.valid('param');
    await deleteCustomerEmailDomain(partnerId, id);
    writeRouteAudit(c, {
      orgId: null,
      action: 'ticket_customer_email_domain.delete',
      resourceType: 'ticket_customer_email_domain',
      resourceId: id,
      details: { partnerId, changedFields: ['deleted'] }
    });
    return c.json({ data: { ok: true } });
  } catch (err) {
    return handleServiceError(c, err);
  }
});

ticketConfigRoutes.post('/statuses/reorder', scopes, writePerm, adminMiddleware, zValidator('json', reorderTicketStatusesSchema), async (c) => {
  const partnerId = requirePartnerId(c);
  if (partnerId instanceof Response) return partnerId;
  try {
    const { ids } = c.req.valid('json');
    const result = await reorderTicketStatuses(partnerId, ids);
    writeRouteAudit(c, {
      orgId: null,
      action: 'ticket_status.reorder',
      resourceType: 'ticket_status',
      resourceId: partnerId,
      resourceName: 'Ticket status order',
      details: { partnerId, statusIds: ids, changedFields: ['sortOrder'] }
    });
    return c.json({ data: result });
  } catch (err) {
    return handleServiceError(c, err);
  }
});

ticketConfigRoutes.post('/statuses', scopes, writePerm, adminMiddleware, zValidator('json', createTicketStatusSchema), async (c) => {
  const partnerId = requirePartnerId(c);
  if (partnerId instanceof Response) return partnerId;
  try {
    const data = c.req.valid('json');
    const row = await createTicketStatus(partnerId, data);
    writeRouteAudit(c, {
      orgId: null,
      action: 'ticket_status.create',
      resourceType: 'ticket_status',
      resourceId: row.id,
      resourceName: row.name,
      details: { partnerId, changedFields: Object.keys(data) }
    });
    return c.json({ data: row }, 201);
  } catch (err) {
    return handleServiceError(c, err);
  }
});

ticketConfigRoutes.patch('/statuses/:id', scopes, writePerm, adminMiddleware, zValidator('param', idParam), zValidator('json', updateTicketStatusSchema), async (c) => {
  const partnerId = requirePartnerId(c);
  if (partnerId instanceof Response) return partnerId;
  try {
    const { id } = c.req.valid('param');
    const data = c.req.valid('json');
    const row = await updateTicketStatus(partnerId, id, data);
    writeRouteAudit(c, {
      orgId: null,
      action: 'ticket_status.update',
      resourceType: 'ticket_status',
      resourceId: id,
      resourceName: row.name,
      details: { partnerId, changedFields: Object.keys(data) }
    });
    return c.json({ data: row });
  } catch (err) {
    return handleServiceError(c, err);
  }
});

ticketConfigRoutes.put('/priorities', scopes, writePerm, adminMiddleware, zValidator('json', prioritySettingsSchema), async (c) => {
  const partnerId = requirePartnerId(c);
  if (partnerId instanceof Response) return partnerId;
  try {
    const data = c.req.valid('json');
    const priorities = await upsertPrioritySettings(partnerId, data);
    writeRouteAudit(c, {
      orgId: null,
      action: 'ticket_priority_settings.update',
      resourceType: 'ticket_priority_settings',
      resourceId: partnerId,
      resourceName: 'Ticket priority settings',
      details: { partnerId, changedFields: Object.keys(data) }
    });
    return c.json({ data: { priorities } });
  } catch (err) {
    return handleServiceError(c, err);
  }
});
