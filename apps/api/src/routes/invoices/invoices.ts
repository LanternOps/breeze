import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { requireScope, requirePermission, type AuthContext } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import {
  createManualInvoiceSchema, updateInvoiceSchema, manualLineSchema, catalogLineSchema,
  bundleLineSchema, updateLineSchema, listInvoicesQuerySchema
} from '@breeze/shared';
import {
  createManualInvoice, getInvoice, listInvoices, addManualLine, addCatalogLine, addBundleLine,
  updateLine, removeLine, deleteDraftInvoice, updateInvoice
} from '../../services/invoiceService';
import { InvoiceServiceError, type InvoiceActor } from '../../services/invoiceTypes';

export const invoiceCrudRoutes = new Hono();
const scopes = requireScope('partner', 'system');
const readPerm = requirePermission(PERMISSIONS.INVOICES_READ.resource, PERMISSIONS.INVOICES_READ.action);
const writePerm = requirePermission(PERMISSIONS.INVOICES_WRITE.resource, PERMISSIONS.INVOICES_WRITE.action);
const idParam = z.object({ id: z.string().guid() });
const lineParam = z.object({ id: z.string().guid(), lineId: z.string().guid() });

export function invoiceActorFrom(c: { get: (k: string) => unknown }): InvoiceActor {
  const auth = c.get('auth') as AuthContext;
  return { userId: auth.user.id, partnerId: auth.partnerId ?? null, accessibleOrgIds: auth.accessibleOrgIds };
}
export function handleServiceError(c: { json: (b: unknown, s: number) => Response }, err: unknown): Response {
  if (err instanceof InvoiceServiceError) return c.json({ error: err.message, code: err.code }, err.status);
  throw err;
}

invoiceCrudRoutes.get('/', scopes, readPerm, zValidator('query', listInvoicesQuerySchema), async (c) => {
  try { return c.json({ data: await listInvoices(c.req.valid('query'), invoiceActorFrom(c)) }); }
  catch (err) { return handleServiceError(c, err); }
});
invoiceCrudRoutes.post('/', scopes, writePerm, zValidator('json', createManualInvoiceSchema), async (c) => {
  try { return c.json({ data: await createManualInvoice(c.req.valid('json'), invoiceActorFrom(c)) }); }
  catch (err) { return handleServiceError(c, err); }
});
invoiceCrudRoutes.get('/:id', scopes, readPerm, zValidator('param', idParam), async (c) => {
  try { return c.json({ data: await getInvoice(c.req.valid('param').id, invoiceActorFrom(c)) }); }
  catch (err) { return handleServiceError(c, err); }
});
invoiceCrudRoutes.patch('/:id', scopes, writePerm, zValidator('param', idParam), zValidator('json', updateInvoiceSchema), async (c) => {
  try { return c.json({ data: await updateInvoice(c.req.valid('param').id, c.req.valid('json'), invoiceActorFrom(c)) }); }
  catch (err) { return handleServiceError(c, err); }
});
invoiceCrudRoutes.delete('/:id', scopes, writePerm, zValidator('param', idParam), async (c) => {
  try { await deleteDraftInvoice(c.req.valid('param').id, invoiceActorFrom(c)); return c.json({ data: { ok: true } }); }
  catch (err) { return handleServiceError(c, err); }
});
invoiceCrudRoutes.post('/:id/lines', scopes, writePerm, zValidator('param', idParam), zValidator('json', manualLineSchema), async (c) => {
  try { return c.json({ data: await addManualLine(c.req.valid('param').id, c.req.valid('json'), invoiceActorFrom(c)) }); }
  catch (err) { return handleServiceError(c, err); }
});
invoiceCrudRoutes.post('/:id/lines/catalog', scopes, writePerm, zValidator('param', idParam), zValidator('json', catalogLineSchema), async (c) => {
  try { const b = c.req.valid('json'); return c.json({ data: await addCatalogLine(c.req.valid('param').id, b.catalogItemId, b.quantity, invoiceActorFrom(c)) }); }
  catch (err) { return handleServiceError(c, err); }
});
invoiceCrudRoutes.post('/:id/lines/bundle', scopes, writePerm, zValidator('param', idParam), zValidator('json', bundleLineSchema), async (c) => {
  try { const b = c.req.valid('json'); return c.json({ data: await addBundleLine(c.req.valid('param').id, b.bundleId, b.quantity, invoiceActorFrom(c)) }); }
  catch (err) { return handleServiceError(c, err); }
});
invoiceCrudRoutes.patch('/:id/lines/:lineId', scopes, writePerm, zValidator('param', lineParam), zValidator('json', updateLineSchema), async (c) => {
  try { const p = c.req.valid('param'); return c.json({ data: await updateLine(p.id, p.lineId, c.req.valid('json'), invoiceActorFrom(c)) }); }
  catch (err) { return handleServiceError(c, err); }
});
invoiceCrudRoutes.delete('/:id/lines/:lineId', scopes, writePerm, zValidator('param', lineParam), async (c) => {
  try { const p = c.req.valid('param'); return c.json({ data: await removeLine(p.id, p.lineId, invoiceActorFrom(c)) }); }
  catch (err) { return handleServiceError(c, err); }
});
