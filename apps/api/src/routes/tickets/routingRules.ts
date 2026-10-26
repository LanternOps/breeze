/**
 * Ticket routing rules (#8883 W5, spec §5.4, §5.5). Mounted at
 * /api/v1/ticket-routing-rules (not under /tickets, where it would collide
 * with /:id).
 *
 * Reads and the dry run (POST /test): organization, partner or system scope.
 * Writes: partner or system scope only — an organization-scope token reads
 * rules, never edits them (the ticket-config precedent). Every PARTNER-WIDE
 * write is additionally gated in the service on canManagePartnerWidePolicies
 * (PartnerWideWriteDeniedError → 403), which is also what the
 * manage_ticket_routing_rules AI tool calls; an org-owned rule needs
 * canAccessOrg on its org.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { zValidator } from '../../lib/validation';
import {
  ERROR_CODES,
  createTicketRoutingRuleSchema,
  listTicketRoutingRulesQuerySchema,
  reorderTicketRoutingRulesSchema,
  testTicketRoutingRuleSchema,
  updateTicketRoutingRuleSchema,
} from '@breeze/shared';
import { authMiddleware, requirePermission, requireScope, type AuthContext } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { writeRouteAudit } from '../../services/auditEvents';
import { PartnerWideWriteDeniedError } from '../../services/partnerWideAccess';
import {
  TicketRoutingError,
  createRoutingRule,
  deleteRoutingRule,
  listRoutingRules,
  reorderRoutingRules,
  testRoutingRules,
  updateRoutingRule,
} from '../../services/ticketRouting/service';

export const ticketRoutingRuleRoutes = new Hono();

ticketRoutingRuleRoutes.use('*', authMiddleware);

const readScopes = requireScope('organization', 'partner', 'system');
const writeScopes = requireScope('partner', 'system');
const readPerm = requirePermission(PERMISSIONS.TICKETS_READ.resource, PERMISSIONS.TICKETS_READ.action);
const writePerm = requirePermission(PERMISSIONS.TICKETS_WRITE.resource, PERMISSIONS.TICKETS_WRITE.action);

const idParam = z.object({ id: z.string().guid() });

function handleError(c: Context, err: unknown): Response {
  if (err instanceof TicketRoutingError) {
    return c.json({ error: err.message, code: err.code }, err.status);
  }
  if (err instanceof PartnerWideWriteDeniedError) {
    return c.json({ error: err.message, code: ERROR_CODES.ACCESS_DENIED }, 403);
  }
  throw err;
}

const authOf = (c: Context) => c.get('auth') as AuthContext;

function audit(c: Context, action: string, rule: { id: string; orgId?: string | null; partnerId?: string | null; name?: string }, details: Record<string, unknown> = {}) {
  writeRouteAudit(c as never, {
    orgId: rule.orgId ?? null,
    ...(rule.orgId ? {} : { partnerId: rule.partnerId ?? authOf(c).partnerId }),
    action,
    resourceType: 'ticket_routing_rule',
    resourceId: rule.id,
    resourceName: rule.name,
    details,
  });
}

// ---- reads + dry run (literal paths before /:id) ----------------------------

ticketRoutingRuleRoutes.get('/', readScopes, readPerm, zValidator('query', listTicketRoutingRulesQuerySchema), async (c) => {
  try {
    return c.json({ data: await listRoutingRules(authOf(c), { orgId: c.req.valid('query').orgId }) });
  } catch (err) {
    return handleError(c, err);
  }
});

// Read-only: the same evaluator as createTicket, writes nothing, so no audit.
ticketRoutingRuleRoutes.post('/test', readScopes, readPerm, zValidator('json', testTicketRoutingRuleSchema), async (c) => {
  try {
    return c.json({ data: await testRoutingRules(authOf(c), c.req.valid('json')) });
  } catch (err) {
    return handleError(c, err);
  }
});

// ---- writes ----------------------------------------------------------------

ticketRoutingRuleRoutes.post('/reorder', writeScopes, writePerm, zValidator('json', reorderTicketRoutingRulesSchema), async (c) => {
  try {
    const { ids } = c.req.valid('json');
    const data = await reorderRoutingRules(authOf(c), ids);
    writeRouteAudit(c as never, {
      orgId: null,
      partnerId: authOf(c).partnerId,
      action: 'ticket_routing_rule.reorder',
      resourceType: 'ticket_routing_rule',
      details: { ids, updated: data.updated },
    });
    return c.json({ data });
  } catch (err) {
    return handleError(c, err);
  }
});

ticketRoutingRuleRoutes.post('/', writeScopes, writePerm, zValidator('json', createTicketRoutingRuleSchema), async (c) => {
  try {
    const body = c.req.valid('json');
    const data = await createRoutingRule(authOf(c), body);
    audit(c, 'ticket_routing_rule.create', data, { ownerScope: body.ownerScope, orgScoped: data.orgIds !== null });
    return c.json({ data }, 201);
  } catch (err) {
    return handleError(c, err);
  }
});

ticketRoutingRuleRoutes.patch('/:id', writeScopes, writePerm, zValidator('param', idParam), zValidator('json', updateTicketRoutingRuleSchema), async (c) => {
  try {
    const body = c.req.valid('json');
    const data = await updateRoutingRule(authOf(c), c.req.valid('param').id, body);
    audit(c, 'ticket_routing_rule.update', data, { changedFields: Object.keys(body) });
    return c.json({ data });
  } catch (err) {
    return handleError(c, err);
  }
});

ticketRoutingRuleRoutes.delete('/:id', writeScopes, writePerm, zValidator('param', idParam), async (c) => {
  try {
    const deleted = await deleteRoutingRule(authOf(c), c.req.valid('param').id);
    audit(c, 'ticket_routing_rule.delete', deleted);
    return c.json({ data: { deleted: true } });
  } catch (err) {
    return handleError(c, err);
  }
});
