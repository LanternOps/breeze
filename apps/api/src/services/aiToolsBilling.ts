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

import { z } from 'zod';
import {
  INVOICE_STATUSES,
  manualLineSchema,
  updateLineSchema,
  updateInvoiceSchema,
  recordPaymentSchema
} from '@breeze/shared';
import type { AuthContext } from '../middleware/auth';
import type { AiTool, AiToolTier } from './aiTools';
import {
  listInvoices,
  getInvoice,
  createManualInvoice,
  addManualLine,
  addCatalogLine,
  addBundleLine,
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
import { db } from '../db';
import type { DeviceSnapshotRow } from './contractQuantities';
import { computeContractEstimate, getContract, lockContractRow, materializeContractLineOntoInvoice } from './contractService';
import { toCents } from './invoiceMath';
import { missingParamsJson, zodErrorToJson } from './aiToolValidation';

function actorFromAuth(auth: AuthContext): InvoiceActor {
  return {
    userId: auth.user.id,
    partnerId: auth.partnerId ?? null,
    accessibleOrgIds: auth.accessibleOrgIds,
    // Thread the caller's site-axis restriction so a site-limited AI session can't
    // read/mutate out-of-site invoices. undefined (partner/system, all-sites org
    // users) stays unrestricted, preserving prior behavior.
    allowedSiteIds: auth.allowedSiteIds
  };
}

/** Same shape as the HTTP invoice error handler (routes/invoices/invoices.ts):
 *  `details` rides along when present so structured recovery data (e.g. the
 *  ALL_BLOCKED_BY_CURRENCY per-currency groups, #3776) reaches the model. */
function serviceErrorToJson(err: unknown): string | null {
  if (err instanceof InvoiceServiceError) {
    return JSON.stringify({ error: err.message, code: err.code, ...(err.details ? { details: err.details } : {}) });
  }
  return null;
}

// Payload parsers wrap the value under its param name so ZodError paths are
// self-describing ("line.quantity: ...", "payment.receivedAt: ..."). These
// are the SAME schemas the HTTP invoice routes validate with — one source of
// truth. Without this, a malformed manage_invoices call skipped validation
// entirely (the type-cast reached invoiceService with no Zod layer at all)
// and died as an opaque DB constraint 500 instead of a structured
// VALIDATION_ERROR the model could act on.
const manualLinePayload = z.object({ line: manualLineSchema });
const lineUpdatePayload = z.object({ patch: updateLineSchema });
const headerUpdatePayload = z.object({ patch: updateInvoiceSchema });
const paymentPayload = z.object({ payment: recordPaymentSchema });

/**
 * Adds a derived `depositPaid` boolean (amountPaid >= depositDue, compared in
 * integer cents to avoid float/string drift) to a read-only invoice payload.
 * When no deposit is configured (`depositDue` null/undefined), `depositPaid`
 * is omitted entirely rather than emitted as `false` — there's no deposit
 * state to report, and `false` would misleadingly read as "deposit unpaid".
 */
function withDepositPaid<T extends { depositDue?: string | null; amountPaid: string }>(
  inv: T
): T & { depositPaid?: boolean } {
  if (inv.depositDue == null) return inv;
  return { ...inv, depositPaid: toCents(inv.amountPaid) >= toCents(inv.depositDue) };
}

/**
 * Params each manage_invoices action requires, presence-checked BEFORE any
 * `String(...)` coercion so a missing id can't become the literal string
 * "undefined" and die downstream as an opaque uuid/DB 500 (#2362 sweep).
 */
const MANAGE_INVOICES_REQUIRED: Record<string, readonly string[]> = {
  create_draft: ['orgId'],
  add_manual_line: ['invoiceId', 'line'],
  add_catalog_line: ['invoiceId', 'catalogItemId', 'quantity'],
  add_bundle_line: ['invoiceId', 'bundleId', 'quantity'],
  add_contract_line: ['invoiceId', 'contractId', 'contractLineId'],
  update_line: ['invoiceId', 'lineId', 'patch'],
  remove_line: ['invoiceId', 'lineId'],
  update_header: ['invoiceId', 'patch'],
  delete_draft: ['invoiceId'],
  assemble_from_org: ['orgId', 'from', 'to'],
  assemble_from_ticket: ['ticketId'],
  issue: ['invoiceId'],
  void: ['invoiceId', 'reason'],
  record_payment: ['invoiceId', 'payment'],
  void_payment: ['paymentId'],
  create_pay_link: ['invoiceId'],
};

export function registerBillingTools(aiTools: Map<string, AiTool>): void {
  aiTools.set('list_invoices', {
    tier: 2 as AiToolTier,
    deviceArgs: [],
    definition: {
      name: 'list_invoices',
      description:
        'List invoices for the orgs the caller can access, newest first. Optionally filter by org or status. ' +
        'Each invoice includes depositDue and, when a deposit is configured, a derived depositPaid boolean. Read-only.' +
        ' Every document carries a 3-letter currencyCode and all of its amounts (subtotal, tax, total, balance, line totals) are in that currency. NEVER add amounts from documents with different currencyCode values — group by currencyCode first and report one total per currency.',
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
        return JSON.stringify({ invoices: rows.map(withDepositPaid), showing: rows.length });
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
        'Get the full accounting view of one invoice (header plus all lines) by id. Includes depositDue and, ' +
        'when a deposit is configured, a derived depositPaid boolean. Read-only.' +
        ' Every document carries a 3-letter currencyCode and all of its amounts (subtotal, tax, total, balance, line totals) are in that currency. NEVER add amounts from documents with different currencyCode values — group by currencyCode first and report one total per currency.',
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
        return JSON.stringify({ ...result, invoice: withDepositPaid(result.invoice) });
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
        'actions finalize financial state and require approval. Assembly responses carry `blockedByCurrency` ' +
        'listing unbilled work in other currencies — assemble a separate draft with `currencyCode` set; never ' +
        'sum across currencies.' +
        ' Money inputs (line unitPrice, payment amount) are in the invoice\'s currencyCode. create_pay_link may return a `warning` (code CURRENCY_DIFFERS_FROM_STRIPE_ACCOUNT) when the invoice currency differs from the partner\'s Stripe account currency — relay it to the user; it does not block the link.' +
        ' Catalog/bundle lines are priced from the ' +
        'catalog price book in the INVOICE\'s currency — never converted: add_catalog_line fails with ' +
        'NO_PRICE_FOR_CURRENCY (409) when the item has no price in that currency, add_bundle_line with ' +
        'NO_PRICE_FOR_CURRENCY (bundle headline missing) or PRICE_BOOK_INCOMPLETE (409, a component is ' +
        'missing a price). Use add_manual_line instead, or fill the price book. add_contract_line returns ' +
        '{ line, pricedFrom, overages }; pricedFrom "contract_snapshot" on a catalog line means the price book had a ' +
        'gap and the contract line\'s stamped price was billed. overages reports bill/flag allowance overages and ' +
        'the bill-mode sibling invoiceLineId.',
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
          catalogItemId: { type: 'string', description: 'Catalog item UUID for add_catalog_line (priced in the invoice currency; NO_PRICE_FOR_CURRENCY on a gap)' },
          bundleId: { type: 'string', description: 'Bundle item UUID for add_bundle_line (NO_PRICE_FOR_CURRENCY / PRICE_BOOK_INCOMPLETE on a gap)' },
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
          currencyCode: { type: 'string', description: 'Header currency override for assemble_from_org / assemble_from_ticket (ISO 4217). Defaults to the org currency; set it to assemble a separate draft for work snapshotted in another currency' },
          line: { type: 'object', description: 'Manual line fields for add_manual_line' },
          patch: { type: 'object', description: 'Line or header patch fields' },
          payment: { type: 'object', description: 'Payment fields (amount in the invoice\'s currencyCode, method, ...)' },
        },
        required: ['action'],
      },
    },
    handler: async (input, auth) => {
      const actor = actorFromAuth(auth);
      const s = (k: string) => (input[k] == null ? undefined : String(input[k]));

      const action = String(input.action);
      const required = MANAGE_INVOICES_REQUIRED[action];
      if (!required) {
        return JSON.stringify({ error: `Unknown action: ${action}`, code: 'VALIDATION_ERROR' });
      }
      const missing = missingParamsJson(input, action, required);
      if (missing) return missing;

      try {
        switch (action) {
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
            return JSON.stringify(await addManualLine(
              String(input.invoiceId),
              manualLinePayload.parse({ line: input.line }).line,
              actor
            ));
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
            // The tool executes inside the request's ambient DB transaction.
            // Hold the producer lock before re-reading both the line and its
            // resolved quantity so an allowance edit cannot race materialization.
            await lockContractRow(db, contractId);
            const { contract, lines } = await getContract(contractId, contractActor);
            const line = lines.find((candidate) => candidate.id === contractLineId);
            if (!line) return JSON.stringify({ error: 'Contract line not found for this contract' });

            const deviceEvidence = new Map<string, readonly DeviceSnapshotRow[]>();
            const estimate = await computeContractEstimate(contractId, contractActor, deviceEvidence);
            const est = estimate.lines.find((candidate) => candidate.lineId === line.id);
            if (!est) return JSON.stringify({ error: 'Contract line estimate not found for this contract' });

            const materialized = await materializeContractLineOntoInvoice(actor, {
              invoiceId: String(input.invoiceId),
              contract,
              line,
              resolved: {
                counted: est.counted,
                billed: est.quantity,
                included: est.included,
                overage: est.overage,
                overageMode: est.overageMode,
              },
              deviceEvidence: deviceEvidence.get(line.id),
              currencyCode: estimate.currencyCode,
            });
            return JSON.stringify({
              line: materialized.baseLine,
              pricedFrom: materialized.pricedFrom,
              overages: materialized.overage ? [materialized.overage] : [],
            });
          }
          case 'update_line':
            return JSON.stringify(await updateLine(
              String(input.invoiceId),
              String(input.lineId),
              lineUpdatePayload.parse({ patch: input.patch }).patch,
              actor
            ));
          case 'remove_line':
            return JSON.stringify(await removeLine(String(input.invoiceId), String(input.lineId), actor));
          case 'update_header':
            return JSON.stringify(await updateInvoice(
              String(input.invoiceId),
              headerUpdatePayload.parse({ patch: input.patch }).patch,
              actor
            ));
          case 'delete_draft':
            // deleteDraftInvoice returns Promise<void>; stringifying the await
            // directly produced the string "undefined" (not JSON), which the
            // MCP layer rejected as a tool failure AFTER the delete already
            // committed — matches aiToolsContracts.ts's delete_draft/remove_line
            // and aiToolsQuotes.ts's delete_draft/delete_block pattern.
            await deleteDraftInvoice(String(input.invoiceId), actor);
            return JSON.stringify({ ok: true });
          case 'assemble_from_org':
            return JSON.stringify(await assembleDraftFromOrg(
              { orgId: String(input.orgId), siteId: s('siteId'), from: String(input.from), to: String(input.to), currencyCode: s('currencyCode') },
              actor
            ));
          case 'assemble_from_ticket':
            return JSON.stringify(await assembleDraftFromTicket(String(input.ticketId), actor, { currencyCode: s('currencyCode') }));
          case 'issue':
            return JSON.stringify(await issueInvoice(String(input.invoiceId), actor));
          case 'void':
            return JSON.stringify(await voidInvoice(String(input.invoiceId), String(input.reason), { reissue: Boolean(input.reissue) }, actor));
          case 'record_payment':
            return JSON.stringify(await recordPayment(
              String(input.invoiceId),
              paymentPayload.parse({ payment: input.payment }).payment,
              actor
            ));
          case 'void_payment':
            return JSON.stringify(await voidPayment(String(input.paymentId), actor));
          case 'create_pay_link':
            return JSON.stringify(await createInvoicePayLink(String(input.invoiceId), actor));
          default:
            return JSON.stringify({ error: `Unknown action: ${action}`, code: 'VALIDATION_ERROR' });
        }
      } catch (err) {
        const json = serviceErrorToJson(err) ?? zodErrorToJson(err);
        if (json) return json;
        throw err;
      }
    },
  });
}
