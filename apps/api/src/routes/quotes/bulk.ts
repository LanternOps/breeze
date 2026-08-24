import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { requireScope, requirePermission, dbAccessContextFromAuth, type AuthContext } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { bulkQuoteIdsSchema } from '@breeze/shared';
import { runBulkIsolated } from '../../lib/bulkOps';
import { deleteDraftQuote } from '../../services/quoteService';
import { sendQuote } from '../../services/quoteLifecycle';
import { writeRouteAudit, type AuthContext as AuditAuthContext } from '../../services/auditEvents';
import { supersededAuditEvent } from '../../services/quoteSupersedeAudit';
import { quoteActorFrom, handleServiceError } from './quotes';

export const quoteBulkRoutes = new Hono();
const scopes = requireScope('partner', 'system');
const writePerm = requirePermission(PERMISSIONS.QUOTES_WRITE.resource, PERMISSIONS.QUOTES_WRITE.action);
const sendPerm = requirePermission(PERMISSIONS.QUOTES_SEND.resource, PERMISSIONS.QUOTES_SEND.action);

quoteBulkRoutes.post('/bulk-delete', scopes, writePerm, zValidator('json', bulkQuoteIdsSchema), async (c) => {
  try {
    const ctx = dbAccessContextFromAuth(c.get('auth') as AuthContext);
    const actor = quoteActorFrom(c);
    const { ids } = c.req.valid('json');
    return c.json({ data: await runBulkIsolated(ctx, ids, (id) => deleteDraftQuote(id, actor)) });
  } catch (err) { return handleServiceError(c, err); }
});

quoteBulkRoutes.post('/bulk-send', scopes, sendPerm, zValidator('json', bulkQuoteIdsSchema), async (c) => {
  try {
    const ctx = dbAccessContextFromAuth(c.get('auth') as AuthContext);
    const actor = quoteActorFrom(c);
    const { ids } = c.req.valid('json');
    const supersedeAudits: Array<{
      childQuoteId: string;
      orgId: string;
      parentQuoteId: string;
      previousStatus: string;
      revisionNumber: number;
      emailed: boolean;
    }> = [];
    const result = await runBulkIsolated(ctx, ids, async (id) => {
      const sent = await sendQuote(id, actor);
      if (sent.superseded) {
        supersedeAudits.push({
          childQuoteId: id,
          orgId: sent.quote.orgId,
          parentQuoteId: sent.superseded.parentQuoteId,
          previousStatus: sent.superseded.previousStatus,
          revisionNumber: sent.quote.revisionNumber,
          emailed: sent.emailed,
        });
      }
      return sent;
    });
    // Emit after runBulkIsolated resolves so successful items are committed.
    // As the runBulkIsolated header in bulkOps documents, an item whose commit
    // fails after sendQuote returns can still be audited in that narrow window.
    // writeRouteAudit so each retire is attributed to the tech who bulk-sent.
    for (const audit of supersedeAudits) {
      writeRouteAudit(c as unknown as AuditAuthContext, supersededAuditEvent(audit));
    }
    return c.json({ data: result });
  } catch (err) { return handleServiceError(c, err); }
});
