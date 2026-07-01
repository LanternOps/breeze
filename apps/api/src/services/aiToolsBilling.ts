/**
 * AI Billing/Invoice Tools
 *
 * AI tools over the invoice engine:
 *  - `list_invoices` — list invoices for the caller's accessible orgs, with
 *    optional org/status filters.
 *  - `get_invoice`   — full accounting view (invoice + all lines) for one invoice.
 *  - `manage_invoices` — action multiplexer for draft edits, issuance, voids,
 *    payments, assembly, and pay links.
 *
 * Org-scope guarded AT THE TOOL LAYER (do not rely on the route scanner — the
 * known aiTools site/org-scope gap): each tool builds an `InvoiceActor` from the
 * AI session's auth context (partnerId + accessibleOrgIds) and calls
 * `listInvoices` / `getInvoice`, which already enforce `requireOrgAccess`. A
 * thrown `InvoiceServiceError` (e.g. ORG_DENIED, INVOICE_NOT_FOUND) is converted
 * to a JSON error string rather than propagated. `manage_invoices` is a write
 * action-multiplexer; issue/void/record_payment/void_payment are approval-gated
 * Tier 3 actions.
 */

import { INVOICE_STATUSES } from '@breeze/shared';
import type { ManualLineInput, RecordPaymentInput } from '@breeze/shared';
import type { AuthContext } from '../middleware/auth';
import type { AiTool, AiToolTier } from './aiTools';
import {
  listInvoices,
  getInvoice,
  createManualInvoice,
  addManualLine,
  addCatalogLine,
  addBundleLine,
  addContractLine,
  updateLine,
  removeLine,
  updateInvoice,
  deleteDraftInvoice,
  assembleDraftFromOrg,
  assembleDraftFromTicket,
  issueInvoice,
  recordPayment,
  voidPayment,
  voidInvoice
} from './invoiceService';
import { createInvoicePayLink } from './invoiceCheckout';
import { InvoiceServiceError, type InvoiceActor } from './invoiceTypes';
import { computeContractEstimate, getContract } from './contractService';

type UpdateInvoiceLinePatch = Parameters<typeof updateLine>[2];
type UpdateInvoiceHeaderPatch = Parameters<typeof updateInvoice>[1];

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
            enum: [...INVOICE_STATUSES],
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

  aiTools.set('manage_invoices', {
    tier: 2 as AiToolTier,
    deviceArgs: [],
    definition: {
      name: 'manage_invoices',
      description:
        'Create and manage invoices for orgs the caller can access: build drafts, add/edit/remove lines, ' +
        'issue (finalize), void, record or void payments, and create a Stripe pay link. Issue/void/payment ' +
        'actions finalize financial state and require approval.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: {
            type: 'string',
            enum: [
              'create_draft', 'add_manual_line', 'add_catalog_line', 'add_bundle_line', 'add_contract_line',
              'update_line', 'remove_line', 'update_header', 'delete_draft',
              'assemble_from_org', 'assemble_from_ticket',
              'issue', 'void', 'record_payment', 'void_payment', 'create_pay_link',
            ],
          },
          orgId: { type: 'string', description: 'Organization UUID (create_draft, assemble_from_org)' },
          siteId: { type: 'string' },
          invoiceId: { type: 'string', description: 'Invoice UUID; required for add_contract_line with contractId and contractLineId' },
          lineId: { type: 'string' },
          paymentId: { type: 'string' },
          catalogItemId: { type: 'string' },
          bundleId: { type: 'string' },
          contractId: { type: 'string', description: 'Contract UUID for add_contract_line' },
          contractLineId: { type: 'string', description: 'Contract line UUID for add_contract_line' },
          ticketId: { type: 'string' },
          quantity: { type: 'number' },
          notes: { type: 'string' },
          termsAndConditions: { type: 'string' },
          reason: { type: 'string', description: 'Void reason (required for void)' },
          reissue: { type: 'boolean' },
          from: { type: 'string', description: 'ISO date (assemble_from_org)' },
          to: { type: 'string', description: 'ISO date (assemble_from_org)' },
          line: { type: 'object', description: 'Manual line fields for add_manual_line' },
          patch: { type: 'object', description: 'Line or header patch fields' },
          payment: { type: 'object', description: 'Payment fields (amount, method, ...)' },
        },
        required: ['action'],
      },
    },
    handler: async (input, auth) => {
      const actor = actorFromAuth(auth);
      const s = (k: string) => (input[k] == null ? undefined : String(input[k]));

      try {
        switch (input.action) {
          case 'create_draft':
            return JSON.stringify(await createManualInvoice(
              {
                orgId: String(input.orgId),
                siteId: s('siteId'),
                notes: s('notes'),
                termsAndConditions: s('termsAndConditions')
              },
              actor
            ));
          case 'add_manual_line':
            return JSON.stringify(await addManualLine(String(input.invoiceId), input.line as ManualLineInput, actor));
          case 'add_catalog_line':
            return JSON.stringify(await addCatalogLine(String(input.invoiceId), String(input.catalogItemId), Number(input.quantity), actor));
          case 'add_bundle_line':
            return JSON.stringify(await addBundleLine(String(input.invoiceId), String(input.bundleId), Number(input.quantity), actor));
          case 'add_contract_line': {
            const contractActor = {
              userId: auth.user.id,
              partnerId: actor.partnerId,
              accessibleOrgIds: actor.accessibleOrgIds,
            };
            const contractId = String(input.contractId);
            const contractLineId = String(input.contractLineId);
            const { lines } = await getContract(contractId, contractActor);
            const line = lines.find((candidate) => candidate.id === contractLineId);
            if (!line) return JSON.stringify({ error: 'Contract line not found for this contract' });

            const estimate = await computeContractEstimate(contractId, contractActor);
            const est = estimate.lines.find((candidate) => candidate.lineId === line.id);
            if (!est) return JSON.stringify({ error: 'Contract line estimate not found for this contract' });

            return JSON.stringify(await addContractLine(String(input.invoiceId), {
              description: line.description,
              quantity: String(est.quantity),
              unitPrice: line.unitPrice,
              taxable: line.taxable,
              catalogItemId: line.catalogItemId,
              sourceId: line.id,
            }, actor));
          }
          case 'update_line':
            return JSON.stringify(await updateLine(String(input.invoiceId), String(input.lineId), input.patch as UpdateInvoiceLinePatch, actor));
          case 'remove_line':
            return JSON.stringify(await removeLine(String(input.invoiceId), String(input.lineId), actor));
          case 'update_header':
            return JSON.stringify(await updateInvoice(String(input.invoiceId), input.patch as UpdateInvoiceHeaderPatch, actor));
          case 'delete_draft':
            return JSON.stringify(await deleteDraftInvoice(String(input.invoiceId), actor));
          case 'assemble_from_org':
            return JSON.stringify(await assembleDraftFromOrg(
              { orgId: String(input.orgId), siteId: s('siteId'), from: String(input.from), to: String(input.to) },
              actor
            ));
          case 'assemble_from_ticket':
            return JSON.stringify(await assembleDraftFromTicket(String(input.ticketId), actor));
          case 'issue':
            return JSON.stringify(await issueInvoice(String(input.invoiceId), actor));
          case 'void':
            return JSON.stringify(await voidInvoice(String(input.invoiceId), String(input.reason), { reissue: Boolean(input.reissue) }, actor));
          case 'record_payment':
            return JSON.stringify(await recordPayment(String(input.invoiceId), input.payment as RecordPaymentInput, actor));
          case 'void_payment':
            return JSON.stringify(await voidPayment(String(input.paymentId), actor));
          case 'create_pay_link':
            return JSON.stringify(await createInvoicePayLink(String(input.invoiceId), actor));
          default:
            return JSON.stringify({ error: `Unknown action: ${String(input.action)}` });
        }
      } catch (err) {
        const json = serviceErrorToJson(err);
        if (json) return json;
        throw err;
      }
    },
  });
}
