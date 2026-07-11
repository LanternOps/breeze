import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { requireScope, requirePermission, dbAccessContextFromAuth, type AuthContext } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { bulkQuoteIdsSchema } from '@breeze/shared';
import { runBulkIsolated } from '../../lib/bulkOps';
import { deleteDraftQuote } from '../../services/quoteService';
import { sendQuote } from '../../services/quoteLifecycle';
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
    return c.json({ data: await runBulkIsolated(ctx, ids, (id) => sendQuote(id, actor)) });
  } catch (err) { return handleServiceError(c, err); }
});
