import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '../../lib/validation';
import { requireScope, requirePermission, isInteractiveUserSession } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import {
  checklistItemCreateSchema,
  checklistItemPatchSchema,
  checklistReorderSchema,
  applyChecklistTemplateSchema,
} from '@breeze/shared';
import { applyChecklistTemplateToTicket } from '../../services/ticketChecklistTemplateService';
import { HumanWorkStepWaitingError } from '../../services/aiOperator/humanWorkService';
import {
  templateActorFrom,
  handleChecklistTemplateError,
} from '../ticketChecklistTemplates';
import {
  addChecklistItem,
  deleteChecklistItem,
  getChecklistItemOr404,
  listChecklist,
  patchChecklistItem,
  reorderChecklist,
  ChecklistServiceError,
} from '../../services/ticketChecklistService';
import { getScopedTicketOr404 } from './tickets';

const idParam = z.object({ id: z.string().guid() });
const itemIdParam = z.object({ itemId: z.string().guid() });

/**
 * Internal-only (spec #5783 §2). Checklist steps and their per-step notes are
 * MSP procedure; no org-scoped token and no portal surface ever reaches them —
 * the same posture parts.ts takes for parts and per-ticket time.
 */
export const ticketChecklistRoutes = new Hono();

const scopes = requireScope('partner', 'system');
const readPerm = requirePermission(PERMISSIONS.TICKETS_READ.resource, PERMISSIONS.TICKETS_READ.action);
const writePerm = requirePermission(PERMISSIONS.TICKETS_WRITE.resource, PERMISSIONS.TICKETS_WRITE.action);

function handleServiceError(c: { json: (b: unknown, s: number) => Response }, err: unknown): Response {
  if (err instanceof ChecklistServiceError) {
    return c.json(
      { error: err.message, code: err.code, ...(err.details ? { details: err.details } : {}) },
      err.status,
    );
  }
  // The Operator's own refusal (E3). Rendered here rather than converted into a
  // ChecklistServiceError inside humanWorkService, because that would make the
  // aiOperator tree import the ticket service's error class and close the
  // module cycle this wave deliberately keeps open in one direction.
  if (err instanceof HumanWorkStepWaitingError) {
    return c.json({ error: err.message, code: err.code }, err.status);
  }
  throw err;
}

const actorFrom = (c: { get: (k: 'auth') => { user: { id: string } } }) => ({
  userId: c.get('auth').user.id,
});

// /checklist/:itemId BEFORE the hub's /:id routes — this router mounts first.
ticketChecklistRoutes.patch(
  '/checklist/:itemId',
  scopes,
  writePerm,
  zValidator('param', itemIdParam),
  zValidator('json', checklistItemPatchSchema),
  async (c) => {
    const auth = c.get('auth');
    const patch = c.req.valid('json');

    // The `done` branch requires a human, in a session, right now. An MCP API
    // key carries its creator's real user.id, so simply not shipping a tick-off
    // AI tool would leave this reachable by an agent acting under a person's
    // identity — a falsified attestation on a compliance artifact. Covers
    // done:false too: unticking someone else's attestation is the same class of
    // write. Reads, adds, text edits, reorders and deletes are deliberately NOT
    // gated this way.
    if (patch.done !== undefined && !isInteractiveUserSession(auth)) {
      return c.json(
        {
          error: 'Ticking a checklist step requires an interactive user session',
          code: 'CHECKLIST_TICK_REQUIRES_USER',
        },
        403,
      );
    }

    try {
      const item = await getChecklistItemOr404(c.req.valid('param').itemId);
      // Re-check scope through the item's OWN ticket — the item id alone
      // carries no tenancy. A foreign or soft-deleted ticket is a bare 404.
      if (!(await getScopedTicketOr404(auth, item.ticketId))) {
        return c.json({ error: 'Checklist item not found' }, 404);
      }
      return c.json({ data: await patchChecklistItem(item.id, patch, actorFrom(c)) });
    } catch (err) {
      return handleServiceError(c, err);
    }
  },
);

ticketChecklistRoutes.delete(
  '/checklist/:itemId',
  scopes,
  writePerm,
  zValidator('param', itemIdParam),
  async (c) => {
    const auth = c.get('auth');
    try {
      const item = await getChecklistItemOr404(c.req.valid('param').itemId);
      if (!(await getScopedTicketOr404(auth, item.ticketId))) {
        return c.json({ error: 'Checklist item not found' }, 404);
      }
      await deleteChecklistItem(item.id);
      return c.json({ data: { deleted: true } });
    } catch (err) {
      return handleServiceError(c, err);
    }
  },
);

ticketChecklistRoutes.get(
  '/:id/checklist',
  scopes,
  readPerm,
  zValidator('param', idParam),
  async (c) => {
    const ticket = await getScopedTicketOr404(c.get('auth'), c.req.valid('param').id);
    if (!ticket) return c.json({ error: 'Ticket not found' }, 404);
    return c.json({ data: await listChecklist(ticket.id) });
  },
);

ticketChecklistRoutes.post(
  '/:id/checklist',
  scopes,
  writePerm,
  zValidator('param', idParam),
  zValidator('json', checklistItemCreateSchema),
  async (c) => {
    const ticket = await getScopedTicketOr404(c.get('auth'), c.req.valid('param').id);
    if (!ticket) return c.json({ error: 'Ticket not found' }, 404);
    try {
      const item = await addChecklistItem(
        { id: ticket.id, orgId: ticket.orgId },
        c.req.valid('json'),
        actorFrom(c),
      );
      return c.json({ data: item }, 201);
    } catch (err) {
      return handleServiceError(c, err);
    }
  },
);

// Registered ABOVE the bare `/:id/checklist` POST so the longer literal suffix
// is matched first.
ticketChecklistRoutes.post(
  '/:id/checklist/apply-template',
  scopes,
  writePerm,
  zValidator('param', idParam),
  zValidator('json', applyChecklistTemplateSchema),
  async (c) => {
    const auth = c.get('auth');
    const ticket = await getScopedTicketOr404(auth, c.req.valid('param').id);
    if (!ticket) return c.json({ error: 'Ticket not found' }, 404);
    try {
      // Deliberately NOT gated on isInteractiveUserSession: applying a template
      // creates UNTICKED steps and asserts nothing about work performed. Only
      // the `done` branch of PATCH is a human attestation.
      const summary = await applyChecklistTemplateToTicket(
        { id: ticket.id, orgId: ticket.orgId },
        c.req.valid('json'),
        templateActorFrom(c),
      );
      return c.json({ data: summary });
    } catch (err) {
      // The templates handler, not handleServiceError: apply can also raise
      // PartnerWideWriteDeniedError-shaped errors from the template service,
      // and its match is structural so it covers ChecklistServiceError too.
      return handleChecklistTemplateError(c, err);
    }
  },
);

ticketChecklistRoutes.post(
  '/:id/checklist/reorder',
  scopes,
  writePerm,
  zValidator('param', idParam),
  zValidator('json', checklistReorderSchema),
  async (c) => {
    const ticket = await getScopedTicketOr404(c.get('auth'), c.req.valid('param').id);
    if (!ticket) return c.json({ error: 'Ticket not found' }, 404);
    try {
      return c.json({ data: await reorderChecklist(ticket.id, c.req.valid('json').itemIds) });
    } catch (err) {
      return handleServiceError(c, err);
    }
  },
);
