/**
 * Ticket checklist template routes (#5783 W02), mounted at
 * `/ticket-checklist-templates`:
 *
 *   /ticket-checklist-templates[/:id[/items[/reorder]]]
 *   /ticket-checklist-templates/items/:itemId
 *
 * Gated on `tickets:read` (GET) / `tickets:write` (mutations), the same
 * permission family as the checklists themselves. A template is org-owned OR
 * partner-wide; partner-wide WRITES are additionally gated in the service on
 * `canManagePartnerWidePolicies`, which surfaces here as a 403. A template the
 * caller cannot see is 404 (never 403) so existence never leaks.
 *
 * Internal-only, like W01's checklist router: `requireScope('partner',
 * 'system')` means no org-scoped token and no portal surface reaches these at
 * all.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { zValidator } from '../lib/validation';
import {
  authMiddleware,
  requireScope,
  requirePermission,
  type AuthContext,
} from '../middleware/auth';
import { PERMISSIONS } from '../services/permissions';
import {
  createChecklistTemplateSchema,
  updateChecklistTemplateSchema,
  listChecklistTemplatesQuerySchema,
  createChecklistTemplateItemSchema,
  updateChecklistTemplateItemSchema,
  checklistTemplateItemReorderSchema,
} from '@breeze/shared';
import {
  listChecklistTemplates,
  getChecklistTemplate,
  createChecklistTemplate,
  updateChecklistTemplate,
  deleteChecklistTemplate,
  addChecklistTemplateItem,
  updateChecklistTemplateItem,
  removeChecklistTemplateItem,
  reorderChecklistTemplateItems,
  type ChecklistTemplateActor,
} from '../services/ticketChecklistTemplateService';
import {
  PartnerWideWriteDeniedError,
  PARTNER_WIDE_WRITE_DENIED_MESSAGE,
} from '../services/partnerWideAccess';

export const ticketChecklistTemplateRoutes = new Hono();
ticketChecklistTemplateRoutes.use('*', authMiddleware);

const scopes = requireScope('partner', 'system');
const readPerm = requirePermission(
  PERMISSIONS.TICKETS_READ.resource,
  PERMISSIONS.TICKETS_READ.action,
);
const writePerm = requirePermission(
  PERMISSIONS.TICKETS_WRITE.resource,
  PERMISSIONS.TICKETS_WRITE.action,
);

const templateParam = z.object({ id: z.string().guid() });
const itemParam = z.object({ itemId: z.string().guid() });

/** Carries `scope` and `partnerOrgAccess` through — the service needs BOTH. */
export function templateActorFrom(c: { get: (k: string) => unknown }): ChecklistTemplateActor {
  const auth = c.get('auth') as AuthContext;
  return {
    userId: auth.user?.id ?? null,
    scope: auth.scope,
    partnerId: auth.partnerId ?? null,
    partnerOrgAccess: auth.partnerOrgAccess ?? null,
    accessibleOrgIds: auth.accessibleOrgIds,
  };
}

/**
 * Maps `PartnerWideWriteDeniedError` (403) and `ChecklistTemplateServiceError`
 * (status + code + optional details) onto the `{ error, code, details? }`
 * envelope. The service-error match is STRUCTURAL, like `handleTemplateError`,
 * so it survives module mocking in the route tests. Anything else is rethrown
 * for the global error handler.
 */
export function handleChecklistTemplateError(
  c: { json: (b: unknown, s: number) => Response },
  err: unknown,
): Response {
  if (err instanceof PartnerWideWriteDeniedError) {
    return c.json(
      { error: PARTNER_WIDE_WRITE_DENIED_MESSAGE, code: 'PARTNER_WIDE_WRITE_DENIED' },
      403,
    );
  }
  if (
    err &&
    typeof err === 'object' &&
    'status' in err &&
    'code' in err &&
    typeof (err as { status: unknown }).status === 'number' &&
    typeof (err as { code: unknown }).code === 'string'
  ) {
    const e = err as { status: number; code: string; message?: string; details?: unknown };
    return c.json(
      {
        error: e.message ?? e.code,
        code: e.code,
        ...(e.details !== undefined ? { details: e.details } : {}),
      },
      e.status as ContentfulStatusCode,
    );
  }
  throw err;
}

// ── Items (LITERAL `/items/...` paths first, before the `/:id` param routes —
//    the same registration-order rule routes/tickets/index.ts documents) ──────

ticketChecklistTemplateRoutes.patch(
  '/items/:itemId',
  scopes,
  writePerm,
  zValidator('param', itemParam),
  zValidator('json', updateChecklistTemplateItemSchema),
  async (c) => {
    try {
      return c.json({
        data: await updateChecklistTemplateItem(
          c.req.valid('param').itemId,
          c.req.valid('json'),
          templateActorFrom(c),
        ),
      });
    } catch (err) {
      return handleChecklistTemplateError(c, err);
    }
  },
);

ticketChecklistTemplateRoutes.delete(
  '/items/:itemId',
  scopes,
  writePerm,
  zValidator('param', itemParam),
  async (c) => {
    try {
      await removeChecklistTemplateItem(c.req.valid('param').itemId, templateActorFrom(c));
      return c.json({ data: { ok: true } });
    } catch (err) {
      return handleChecklistTemplateError(c, err);
    }
  },
);

// ── Templates ───────────────────────────────────────────────────────────────

ticketChecklistTemplateRoutes.get(
  '/',
  scopes,
  readPerm,
  zValidator('query', listChecklistTemplatesQuerySchema),
  async (c) => {
    const q = c.req.valid('query');
    try {
      return c.json({
        data: await listChecklistTemplates(templateActorFrom(c), {
          orgId: q.orgId,
          includeInactive: q.includeInactive,
        }),
      });
    } catch (err) {
      return handleChecklistTemplateError(c, err);
    }
  },
);

ticketChecklistTemplateRoutes.post(
  '/',
  scopes,
  writePerm,
  zValidator('json', createChecklistTemplateSchema),
  async (c) => {
    try {
      return c.json({
        data: await createChecklistTemplate(c.req.valid('json'), templateActorFrom(c)),
      });
    } catch (err) {
      return handleChecklistTemplateError(c, err);
    }
  },
);

ticketChecklistTemplateRoutes.get(
  '/:id',
  scopes,
  readPerm,
  zValidator('param', templateParam),
  async (c) => {
    try {
      return c.json({
        data: await getChecklistTemplate(c.req.valid('param').id, templateActorFrom(c)),
      });
    } catch (err) {
      return handleChecklistTemplateError(c, err);
    }
  },
);

ticketChecklistTemplateRoutes.patch(
  '/:id',
  scopes,
  writePerm,
  zValidator('param', templateParam),
  // `.strict()` on updateChecklistTemplateSchema is what turns a PATCH carrying
  // ownerScope into a 400 rather than a silent no-op: ownership is create-only.
  zValidator('json', updateChecklistTemplateSchema),
  async (c) => {
    try {
      return c.json({
        data: await updateChecklistTemplate(
          c.req.valid('param').id,
          c.req.valid('json'),
          templateActorFrom(c),
        ),
      });
    } catch (err) {
      return handleChecklistTemplateError(c, err);
    }
  },
);

ticketChecklistTemplateRoutes.delete(
  '/:id',
  scopes,
  writePerm,
  zValidator('param', templateParam),
  async (c) => {
    try {
      await deleteChecklistTemplate(c.req.valid('param').id, templateActorFrom(c));
      return c.json({ data: { ok: true } });
    } catch (err) {
      return handleChecklistTemplateError(c, err);
    }
  },
);

ticketChecklistTemplateRoutes.post(
  '/:id/items',
  scopes,
  writePerm,
  zValidator('param', templateParam),
  zValidator('json', createChecklistTemplateItemSchema),
  async (c) => {
    try {
      return c.json({
        data: await addChecklistTemplateItem(
          c.req.valid('param').id,
          c.req.valid('json'),
          templateActorFrom(c),
        ),
      });
    } catch (err) {
      return handleChecklistTemplateError(c, err);
    }
  },
);

ticketChecklistTemplateRoutes.post(
  '/:id/items/reorder',
  scopes,
  writePerm,
  zValidator('param', templateParam),
  zValidator('json', checklistTemplateItemReorderSchema),
  async (c) => {
    try {
      return c.json({
        data: await reorderChecklistTemplateItems(
          c.req.valid('param').id,
          c.req.valid('json').itemIds,
          templateActorFrom(c),
        ),
      });
    } catch (err) {
      return handleChecklistTemplateError(c, err);
    }
  },
);
