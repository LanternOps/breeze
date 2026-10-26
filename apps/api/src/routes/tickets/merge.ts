import { Hono } from 'hono';
import { z } from 'zod';
import { ERROR_CODES, mergePreviewQuerySchema, mergeTicketSchema } from '@breeze/shared';
import { zValidator } from '../../lib/validation';
import { requireMfa, requirePermission, requireScope } from '../../middleware/auth';
import { db } from '../../db';
import { PERMISSIONS } from '../../services/permissions';
import type { AuthContext } from '../../middleware/auth';
import type { MergeEligibilityContext, MergeTicketRow } from '../../services/ticketMerge/eligibility';
import { MergeRefusedError } from '../../services/ticketMerge/errors';
import { mergeTickets } from '../../services/ticketMerge/execute';
import { previewMerge } from '../../services/ticketMerge/preview';
import { actorFrom, getScopedTicketOr404, handleServiceError } from './tickets';
import { deviceInSiteScope } from './siteScope';

/**
 * Ticket merge (#8972, spec §3.4). The source is `:id`; the survivor is
 * `into` / `intoTicketId`. Both tickets must be visible to the caller
 * (`getScopedTicketOr404`: org scope, partner org list, site axis) or the
 * answer is 404. Org-scope tokens merge inside their own org (spec §2), unlike
 * move-org. The merge is irreversible (D4) and takes MFA, as move-org does;
 * the preview is read-only and does not.
 */
export const ticketMergeRoutes = new Hono();

const idParam = z.object({ id: z.string().guid() });
const scopes = requireScope('organization', 'partner', 'system');
const writePerm = requirePermission(PERMISSIONS.TICKETS_WRITE.resource, PERMISSIONS.TICKETS_WRITE.action);

/** The caller's site/device rule, re-applied under the merge's locks (MERGE_SCOPE_DENIED). */
function scopeContext(auth: AuthContext): MergeEligibilityContext {
  return {
    canAccessTicket: async (t: Pick<MergeTicketRow, 'deviceId'>) => (t.deviceId ? deviceInSiteScope(auth, t.deviceId) : true),
  };
}

type Resolved = { src: MergeTicketRow; dst: MergeTicketRow } | Response;

async function resolvePair(
  c: { json: (b: unknown, s: number) => Response; get: (k: 'auth') => AuthContext },
  srcId: string,
  dstId: string,
): Promise<Resolved> {
  const auth = c.get('auth');
  if (auth.scope === 'organization' && !auth.orgId) {
    return c.json({ error: 'Organization context required', code: ERROR_CODES.ACCESS_DENIED }, 403);
  }
  const src = await getScopedTicketOr404(auth, srcId);
  const dst = srcId === dstId ? src : await getScopedTicketOr404(auth, dstId);
  if (!src || !dst) return c.json({ error: 'Ticket not found', code: ERROR_CODES.NOT_FOUND }, 404);
  return { src: src as MergeTicketRow, dst: dst as MergeTicketRow };
}

function refusalResponse(c: { json: (b: unknown, s: number) => Response }, err: MergeRefusedError): Response {
  return c.json({ error: err.message, code: err.code, details: { side: err.side } }, 409);
}

// GET /tickets/:id/merge-preview?into=<uuid> — read-only (spec §3.4).
ticketMergeRoutes.get(
  '/:id/merge-preview',
  scopes,
  writePerm,
  zValidator('param', idParam),
  zValidator('query', mergePreviewQuerySchema),
  async (c) => {
    const { id } = c.req.valid('param');
    const { into } = c.req.valid('query');
    const pair = await resolvePair(c, id, into);
    if (pair instanceof Response) return pair;
    const preview = await previewMerge(db, pair.src, pair.dst, scopeContext(c.get('auth')));
    return c.json({ data: preview });
  },
);

// POST /tickets/:id/merge { intoTicketId, notifyRequester? } — irreversible (D4).
ticketMergeRoutes.post(
  '/:id/merge',
  scopes,
  writePerm,
  requireMfa(),
  zValidator('param', idParam),
  zValidator('json', mergeTicketSchema),
  async (c) => {
    const { id } = c.req.valid('param');
    const { intoTicketId, notifyRequester } = c.req.valid('json');
    const pair = await resolvePair(c, id, intoTicketId);
    if (pair instanceof Response) return pair;
    try {
      const result = await mergeTickets(
        { sourceTicketId: id, intoTicketId, notifyRequester },
        actorFrom(c),
        scopeContext(c.get('auth')),
      );
      return c.json({ data: { survivorId: result.survivorId, counts: result.counts, droppedLinks: result.droppedLinks } });
    } catch (err) {
      if (err instanceof MergeRefusedError) return refusalResponse(c, err);
      return handleServiceError(c, err);
    }
  },
);
