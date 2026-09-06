import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '../../lib/validation';
import { requireScope, requirePermission } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { listActiveTicketDrafts, sendTicketDraft, discardTicketDraft } from '../../services/ticketService';
import { getScopedTicketOr404, actorFrom, handleServiceError } from './tickets';

// P2-4 (#4191), Task A10 — human draft routes: list a ticket's active AI
// drafts, "send as me" a reply draft, or discard one (either kind — discard
// has no kind restriction). A `resolution_note` draft is NEVER SENDABLE
// here (sendTicketDraft 409s on kind !== 'reply') — it is consumed only via
// the resolve flow (`POST /:id/status` with `aiDraftId`, tickets.ts). Same
// RBAC/org-scoping idiom as the sibling `/:id/triage-suggestion` routes in
// ./tickets.ts: tickets:read for the list, tickets:write for the mutations,
// `getScopedTicketOr404` for tenant + site-axis scoping.
export const ticketAiDraftsRoutes = new Hono();

const idParam = z.object({ id: z.string().guid() });
const draftParam = z.object({ id: z.string().guid(), draftId: z.string().guid() });
const sendDraftSchema = z.object({
  // Optional edited body — the technician may tweak the draft before sending.
  // Absent/blank falls back to the draft's own stored content.
  content: z.string().trim().min(1).max(50_000).optional()
});

ticketAiDraftsRoutes.get(
  '/:id/ai-drafts',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.TICKETS_READ.resource, PERMISSIONS.TICKETS_READ.action),
  zValidator('param', idParam),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    if (auth.scope === 'organization' && !auth.orgId) {
      return c.json({ error: 'Organization context required' }, 403);
    }
    const found = await getScopedTicketOr404(auth, id);
    if (!found) return c.json({ error: 'Ticket not found' }, 404);

    const drafts = await listActiveTicketDrafts(id);
    return c.json({ data: drafts });
  }
);

ticketAiDraftsRoutes.post(
  '/:id/ai-drafts/:draftId/send',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.TICKETS_WRITE.resource, PERMISSIONS.TICKETS_WRITE.action),
  zValidator('param', draftParam),
  zValidator('json', sendDraftSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id, draftId } = c.req.valid('param');
    const body = c.req.valid('json');
    if (auth.scope === 'organization' && !auth.orgId) {
      return c.json({ error: 'Organization context required' }, 403);
    }
    const found = await getScopedTicketOr404(auth, id);
    if (!found) return c.json({ error: 'Ticket not found' }, 404);

    try {
      const result = await sendTicketDraft(id, draftId, body.content, actorFrom(c));
      return c.json({ data: result.comment });
    } catch (err) {
      return handleServiceError(c, err);
    }
  }
);

ticketAiDraftsRoutes.post(
  '/:id/ai-drafts/:draftId/discard',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.TICKETS_WRITE.resource, PERMISSIONS.TICKETS_WRITE.action),
  zValidator('param', draftParam),
  async (c) => {
    const auth = c.get('auth');
    const { id, draftId } = c.req.valid('param');
    if (auth.scope === 'organization' && !auth.orgId) {
      return c.json({ error: 'Organization context required' }, 403);
    }
    const found = await getScopedTicketOr404(auth, id);
    if (!found) return c.json({ error: 'Ticket not found' }, 404);

    try {
      const result = await discardTicketDraft(id, draftId);
      return c.json({ data: result });
    } catch (err) {
      return handleServiceError(c, err);
    }
  }
);
