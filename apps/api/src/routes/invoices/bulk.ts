import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requireScope, requirePermission, dbAccessContextFromAuth, type AuthContext } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { bulkInvoiceIdsSchema, bulkVoidInvoicesSchema } from '@breeze/shared';
import { runBulkIsolated } from '../../lib/bulkOps';
import { deleteDraftInvoice, issueInvoice, voidInvoice } from '../../services/invoiceService';
import { invoiceActorFrom, handleServiceError } from './invoices';

export const invoiceBulkRoutes = new Hono();
const scopes = requireScope('partner', 'system');
const writePerm = requirePermission(PERMISSIONS.INVOICES_WRITE.resource, PERMISSIONS.INVOICES_WRITE.action);
const sendPerm = requirePermission(PERMISSIONS.INVOICES_SEND.resource, PERMISSIONS.INVOICES_SEND.action);

invoiceBulkRoutes.post('/bulk-delete', scopes, writePerm, zValidator('json', bulkInvoiceIdsSchema), async (c) => {
  try {
    const ctx = dbAccessContextFromAuth(c.get('auth') as AuthContext);
    const actor = invoiceActorFrom(c);
    const { ids } = c.req.valid('json');
    return c.json({ data: await runBulkIsolated(ctx, ids, (id) => deleteDraftInvoice(id, actor)) });
  } catch (err) { return handleServiceError(c, err); }
});

invoiceBulkRoutes.post('/bulk-issue', scopes, sendPerm, zValidator('json', bulkInvoiceIdsSchema), async (c) => {
  try {
    const ctx = dbAccessContextFromAuth(c.get('auth') as AuthContext);
    const actor = invoiceActorFrom(c);
    const { ids } = c.req.valid('json');
    return c.json({ data: await runBulkIsolated(ctx, ids, (id) => issueInvoice(id, actor)) });
  } catch (err) { return handleServiceError(c, err); }
});

invoiceBulkRoutes.post('/bulk-void', scopes, sendPerm, zValidator('json', bulkVoidInvoicesSchema), async (c) => {
  try {
    const ctx = dbAccessContextFromAuth(c.get('auth') as AuthContext);
    const actor = invoiceActorFrom(c);
    const { ids, reason } = c.req.valid('json');
    return c.json({ data: await runBulkIsolated(ctx, ids, (id) => voidInvoice(id, reason, { reissue: false }, actor)) });
  } catch (err) { return handleServiceError(c, err); }
});
