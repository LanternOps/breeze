import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { requireScope, requirePermission } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { billablesExportQuerySchema } from '@breeze/shared';
import { listBillables } from '../../services/timeEntryService';
import { csvRow } from '../../services/spreadsheetExport';
import { auditSensitiveRead } from '../../services/sensitiveReadAudit';

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
    const auth = c.get('auth');
    // A requested orgId must be in the caller's accessible set; otherwise confine
    // the export to the caller's org allowlist (time_entries is partner-axis RLS,
    // so omitting orgId would otherwise leak every org under the partner).
    if (q.orgId && !auth.canAccessOrg(q.orgId)) {
      return c.json({ error: 'Access to this organization denied' }, 403);
    }
    const rows = await listBillables(q.from, q.to, q.orgId, auth.accessibleOrgIds);
    const lines = [CSV_HEADERS.join(',')];
    for (const r of rows) {
      lines.push(csvRow([
        r.kind, r.date.toISOString(), r.orgName ?? '', r.ticketNumber ?? '',
        r.description ?? '', r.technician ?? '', r.quantity, r.rate ?? '',
        r.amount, r.billingStatus, r.isApproved === null ? '' : String(r.isApproved)
      ]));
    }
    const body = lines.join('\n');
    c.header('Content-Type', 'text/csv');
    c.header('Content-Disposition', 'attachment; filename="billables.csv"');
    auditSensitiveRead(c, {
      action: 'billing.billables.download',
      orgId: q.orgId ?? null,
      resourceType: 'billing_export',
      resourceId: 'billables',
      format: 'csv',
      rowCount: rows.length,
      byteCount: Buffer.byteLength(body, 'utf8'),
    });
    return c.body(body);
  }
);
