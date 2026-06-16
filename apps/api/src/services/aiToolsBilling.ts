/**
 * AI Billing/Invoice Tools
 *
 * Read-only AI tools over the invoice engine:
 *  - `list_invoices` — list invoices for the caller's accessible orgs, with
 *    optional org/status filters.
 *  - `get_invoice`   — full accounting view (invoice + all lines) for one invoice.
 *
 * Org-scope guarded AT THE TOOL LAYER (do not rely on the route scanner — the
 * known aiTools site/org-scope gap): each tool builds an `InvoiceActor` from the
 * AI session's auth context (partnerId + accessibleOrgIds) and calls
 * `listInvoices` / `getInvoice`, which already enforce `requireOrgAccess`. A
 * thrown `InvoiceServiceError` (e.g. ORG_DENIED, INVOICE_NOT_FOUND) is converted
 * to a JSON error string rather than propagated. Write tools are deferred.
 */

import type { AuthContext } from '../middleware/auth';
import type { AiTool, AiToolTier } from './aiTools';
import { listInvoices, getInvoice } from './invoiceService';
import { InvoiceServiceError, type InvoiceActor } from './invoiceTypes';

function actorFromAuth(auth: AuthContext): InvoiceActor {
  return {
    userId: auth.user.id,
    partnerId: auth.partnerId ?? null,
    accessibleOrgIds: auth.accessibleOrgIds
  };
}

function serviceErrorToJson(err: unknown): string | null {
  if (err instanceof InvoiceServiceError) {
    return JSON.stringify({ error: err.message, code: err.code });
  }
  return null;
}

export function registerBillingTools(aiTools: Map<string, AiTool>): void {
  aiTools.set('list_invoices', {
    tier: 2 as AiToolTier,
    deviceArgs: [],
    definition: {
      name: 'list_invoices',
      description:
        'List invoices for the orgs the caller can access, newest first. Optionally filter by org or status. Read-only.',
      input_schema: {
        type: 'object' as const,
        properties: {
          orgId: { type: 'string', description: 'Filter to a single organization (UUID)' },
          status: {
            type: 'string',
            enum: ['draft', 'sent', 'partially_paid', 'overdue', 'paid', 'void'],
            description: 'Filter by invoice status'
          },
          limit: { type: 'number', description: 'Max results (default 25, max 100)' }
        },
        required: []
      }
    },
    handler: async (input, auth) => {
      const limit = Math.min(Math.max(1, Number(input.limit) || 25), 100);
      try {
        const rows = await listInvoices(
          {
            orgId: input.orgId ? String(input.orgId) : undefined,
            status: input.status ? String(input.status) : undefined,
            limit
          },
          actorFromAuth(auth)
        );
        return JSON.stringify({ invoices: rows, showing: rows.length });
      } catch (err) {
        const json = serviceErrorToJson(err);
        if (json) return json;
        throw err;
      }
    }
  });

  aiTools.set('get_invoice', {
    tier: 2 as AiToolTier,
    deviceArgs: [],
    definition: {
      name: 'get_invoice',
      description:
        'Get the full accounting view of one invoice (header plus all lines) by id. Read-only.',
      input_schema: {
        type: 'object' as const,
        properties: {
          invoiceId: { type: 'string', description: 'Invoice UUID' }
        },
        required: ['invoiceId']
      }
    },
    handler: async (input, auth) => {
      try {
        const result = await getInvoice(String(input.invoiceId), actorFromAuth(auth));
        return JSON.stringify(result);
      } catch (err) {
        const json = serviceErrorToJson(err);
        if (json) return json;
        throw err;
      }
    }
  });
}
