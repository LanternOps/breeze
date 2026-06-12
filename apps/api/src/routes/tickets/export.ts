import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requireScope, requirePermission } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { billablesExportQuerySchema } from '@breeze/shared';
import { listBillables } from '../../services/timeEntryService';
import { csvRow } from '../../services/spreadsheetExport';

export const ticketExportRoutes = new Hono();

const CSV_HEADERS = ['type', 'date', 'organization', 'ticket', 'description', 'technician', 'quantity', 'rate', 'amount', 'billing_status', 'approved'];

ticketExportRoutes.get(
  '/export/billables.csv',
  requireScope('partner', 'system'),
  requirePermission(PERMISSIONS.TICKETS_READ.resource, PERMISSIONS.TICKETS_READ.action),
  requirePermission(PERMISSIONS.TIME_ENTRIES_READ.resource, PERMISSIONS.TIME_ENTRIES_READ.action),
  zValidator('query', billablesExportQuerySchema),
  async (c) => {
    const q = c.req.valid('query');
    const rows = await listBillables(q.from, q.to, q.orgId);
    const lines = [CSV_HEADERS.join(',')];
    for (const r of rows) {
      lines.push(csvRow([
        r.kind, r.date.toISOString(), r.orgName ?? '', r.ticketNumber ?? '',
        r.description ?? '', r.technician ?? '', r.quantity, r.rate ?? '',
        r.amount, r.billingStatus, r.isApproved === null ? '' : String(r.isApproved)
      ]));
    }
    c.header('Content-Type', 'text/csv');
    c.header('Content-Disposition', 'attachment; filename="billables.csv"');
    return c.body(lines.join('\n'));
  }
);
