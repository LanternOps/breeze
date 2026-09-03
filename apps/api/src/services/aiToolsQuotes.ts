/**
 * AI Quote/Proposal Tools
 *
 * AI tools over the quote engine:
 *  - `list_quotes`  — list quotes for the caller's accessible orgs, with
 *    optional org/status filters, newest first (mirrors `list_contracts`).
 *  - `get_quote`    — full view (header with derived totals + blocks + lines)
 *    for one quote, reusing the same `getQuote` service the web UI reads
 *    (mirrors `get_contract`).
 *  - `manage_quotes` — action multiplexer for quote draft edits, proposal
 *    blocks, lines, lifecycle send/decline, and pay links.
 *
 * Org-scope guarded AT THE TOOL LAYER (do not rely on the route scanner — the
 * known aiTools site/org-scope gap): the tool builds a `QuoteActor` from the AI
 * session's auth context (partnerId + accessibleOrgIds) and calls quote services,
 * which already enforce org access through `assertOrg`/`getQuote`. A thrown
 * `QuoteServiceError` (e.g. ORG_DENIED, QUOTE_NOT_FOUND, NOT_A_DRAFT) is
 * converted to a JSON error string rather than propagated.
 *
 * Input validation (#2362): the flat `toolInputSchemas.manage_quotes` layer
 * marks every id/payload optional because required-ness depends on the action.
 * The handler therefore (1) presence-checks each action's required params
 * BEFORE any `String(...)` coercion, and (2) parses the `input`/`patch`/
 * `block`/`line` payloads with the same shared Zod schemas the HTTP routes
 * use, so a malformed call returns a structured
 * `{ error, code: 'VALIDATION_ERROR' }` instead of escaping as a raw 500.
 */

import { z } from 'zod';
import {
  createQuoteSchema,
  updateQuoteSchema,
  quoteBlockInputSchema,
  quoteLineInputSchema,
  updateQuoteLineSchema,
  catalogQuoteLineSchema,
  reorderBlocksSchema,
  reorderLinesSchema,
  listQuotesQuerySchema,
} from '@breeze/shared';
import type { AuthContext } from '../middleware/auth';
import type { AiTool, AiToolTier } from './aiTools';
import { missingParamsJson, validationErrorJson, zodErrorToJson } from './aiToolValidation';
import {
  createQuote,
  getQuote,
  listQuotes,
  updateQuote,
  deleteDraftQuote,
  addBlock,
  updateBlock,
  deleteBlock,
  reorderBlocks,
  addManualLine,
  addCatalogLine,
  updateLine,
  removeLine,
  moveLineToBlock,
  reorderLines,
} from './quoteService';
import { sendQuote, declineQuoteByActor } from './quoteLifecycle';
import { createQuotePayLink } from './quotePay';
import { QuoteServiceError, type QuoteActor } from './quoteTypes';
import { requestLikeFromSnapshot } from './auditEvents';
import { writeAuditEvent } from './auditEvents';
import { supersededAuditEvent } from './quoteSupersedeAudit';

type UpdateQuoteLinePatch = Parameters<typeof updateLine>[2];

function actorFromAuth(auth: AuthContext): QuoteActor {
  return {
    userId: auth.user.id,
    partnerId: auth.partnerId ?? null,
    accessibleOrgIds: auth.accessibleOrgIds,
    // Thread the caller's site-axis restriction so a site-limited AI session can't
    // read/mutate out-of-site quotes. undefined (partner/system, all-sites org
    // users) stays unrestricted, preserving prior behavior.
    allowedSiteIds: auth.allowedSiteIds
  };
}

function serviceErrorToJson(err: unknown): string | null {
  if (err instanceof QuoteServiceError) {
    return JSON.stringify({ error: err.message, code: err.code });
  }
  return null;
}

/**
 * Params each action requires. Checked before any coercion so a missing id can
 * never become the literal string "undefined" (which used to reach the DB and
 * die as an opaque uuid-parse 500 — #2362).
 */
const REQUIRED_PARAMS: Record<string, readonly string[]> = {
  create_draft: ['input'],
  update: ['quoteId', 'patch'],
  delete_draft: ['quoteId'],
  add_block: ['quoteId', 'block'],
  update_block: ['quoteId', 'blockId', 'block'],
  delete_block: ['quoteId', 'blockId'],
  reorder_blocks: ['quoteId', 'blockIds'],
  add_manual_line: ['quoteId', 'line'],
  add_catalog_line: ['quoteId', 'catalogItemId', 'quantity'],
  update_line: ['quoteId', 'lineId', 'patch'],
  remove_line: ['quoteId', 'lineId'],
  move_line: ['quoteId', 'lineId', 'blockId'],
  reorder_lines: ['quoteId', 'blockId', 'lineIds'],
  send: ['quoteId'],
  decline: ['quoteId'],
  create_pay_link: ['quoteId'],
};

// Payload parsers wrap the value under its param name so ZodError paths are
// self-describing ("line.sourceType: ...", "input.orgId: ..."). These are the
// SAME schemas the HTTP quote routes validate with — one source of truth.
const createPayload = z.object({ input: createQuoteSchema });
const headerPatchPayload = z.object({ patch: updateQuoteSchema });
const blockPayload = z.object({ block: quoteBlockInputSchema });
const linePayload = z.object({ line: quoteLineInputSchema });
const linePatchPayload = z.object({ patch: updateQuoteLineSchema });

export function registerQuoteTools(aiTools: Map<string, AiTool>): void {
  aiTools.set('list_quotes', {
    tier: 2 as AiToolTier,
    deviceArgs: [],
    definition: {
      name: 'list_quotes',
      description:
        'List quotes/proposals for the orgs the caller can access, newest first. Optionally filter by org or status. Read-only.' +
        ' Every document carries a 3-letter currencyCode and all of its amounts (subtotal, tax, total, balance, line totals) are in that currency. NEVER add amounts from documents with different currencyCode values — group by currencyCode first and report one total per currency.',
      input_schema: {
        type: 'object' as const,
        properties: {
          orgId: { type: 'string', description: 'Filter to a single organization (UUID)' },
          status: {
            type: 'string',
            enum: ['draft', 'sent', 'viewed', 'accepted', 'declined', 'expired', 'converted', 'superseded'],
            description: 'Filter by quote status'
          },
          limit: { type: 'number', description: 'Max results (default 25, max 100)' }
        },
        required: []
      }
    },
    handler: async (input, auth) => {
      try {
        // Same schema the GET /quotes route validates with (status enum, limit
        // bounds); an out-of-range/unknown filter returns a structured
        // VALIDATION_ERROR via zodErrorToJson instead of throwing.
        const query = listQuotesQuerySchema.parse({
          orgId: input.orgId ?? undefined,
          status: input.status ?? undefined,
          limit: input.limit ?? 25,
        });
        const rows = await listQuotes(query, actorFromAuth(auth));
        return JSON.stringify({ quotes: rows, showing: rows.length });
      } catch (err) {
        const json = serviceErrorToJson(err) ?? zodErrorToJson(err);
        if (json) return json;
        throw err;
      }
    }
  });

  aiTools.set('get_quote', {
    tier: 2 as AiToolTier,
    deviceArgs: [],
    definition: {
      name: 'get_quote',
      description:
        'Get the full view of one quote/proposal by id: header (with derived totals, deposit and category ' +
        'breakdown), content blocks, and line items — the same view the web UI shows. Read-only. ' +
        'Large quotes can exceed the output limit: page the content blocks with blocksOffset/blocksLimit, ' +
        'or pass includeBlockContent:false first for a lightweight block overview (types + order, no content). ' +
        'A blocksPagination object reports total/returned/hasMore.' +
        ' Every document carries a 3-letter currencyCode and all of its amounts (subtotal, tax, total, balance, line totals) are in that currency. NEVER add amounts from documents with different currencyCode values — group by currencyCode first and report one total per currency.',
      input_schema: {
        type: 'object' as const,
        properties: {
          quoteId: { type: 'string', description: 'Quote UUID' },
          blocksOffset: { type: 'number', description: 'Index of the first content block to return (default 0)' },
          blocksLimit: { type: 'number', description: 'Max content blocks to return (1-100). Omit for all from the offset.' },
          includeBlockContent: {
            type: 'boolean',
            description: 'Default true. false returns block metadata only (id/type/order, no content) — a compact overview of a large quote.'
          }
        },
        required: ['quoteId']
      }
    },
    handler: async (input, auth) => {
      if (input.quoteId == null) {
        return validationErrorJson('Missing required parameter: quoteId');
      }
      try {
        const full = await getQuote(String(input.quoteId), actorFromAuth(auth));
        const allBlocks = full.blocks;
        const offset = typeof input.blocksOffset === 'number' ? input.blocksOffset : 0;
        const limit = typeof input.blocksLimit === 'number' ? input.blocksLimit : undefined;
        const pagedBlocks =
          limit != null ? allBlocks.slice(offset, offset + limit) : allBlocks.slice(offset);
        // Default keeps the full block content (backward compatible); false drops
        // the heavy `content` field for a compact metadata overview.
        const includeBlockContent = input.includeBlockContent !== false;
        const blocks = includeBlockContent
          ? pagedBlocks
          : pagedBlocks.map((block) => {
              const withoutContent: Record<string, unknown> = { ...block };
              delete withoutContent.content;
              return withoutContent;
            });
        return JSON.stringify({
          ...full,
          blocks,
          blocksPagination: {
            total: allBlocks.length,
            offset,
            limit: limit ?? null,
            returned: pagedBlocks.length,
            hasMore: offset + pagedBlocks.length < allBlocks.length,
            includeBlockContent,
          },
        });
      } catch (err) {
        const json = serviceErrorToJson(err) ?? zodErrorToJson(err);
        if (json) return json;
        throw err;
      }
    }
  });

  aiTools.set('manage_quotes', {
    tier: 2 as AiToolTier,
    deviceArgs: [],
    definition: {
      name: 'manage_quotes',
      description:
        'Create and manage quotes/proposals for orgs the caller can access: draft header edits, blocks, lines, ' +
        'send/decline lifecycle actions, and accepted-quote pay links. Sending a quote requires approval. ' +
        'Read-only access: use list_quotes / get_quote. ' +
        'Required params per action — create_draft: input; update: quoteId, patch; delete_draft/send/decline/' +
        'create_pay_link: quoteId; add_block: quoteId, block; update_block: quoteId, blockId, block; delete_block: ' +
        'quoteId, blockId; reorder_blocks: quoteId, blockIds; add_manual_line: quoteId, line; add_catalog_line: ' +
        'quoteId, catalogItemId, quantity (blockId optional); update_line: quoteId, lineId, patch; remove_line: ' +
        'quoteId, lineId; move_line: quoteId, lineId, blockId (the TARGET line_items block); ' +
        'reorder_lines: quoteId, blockId, lineIds.' +
        ' Money inputs (line unitPrice) are in the quote\'s currencyCode; totals in the response are in that currency.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: {
            type: 'string',
            enum: [
              'create_draft',
              'update',
              'delete_draft',
              'add_block',
              'update_block',
              'delete_block',
              'reorder_blocks',
              'add_manual_line',
              'add_catalog_line',
              'update_line',
              'remove_line',
              'move_line',
              'reorder_lines',
              'send',
              'decline',
              'create_pay_link',
            ],
          },
          quoteId: { type: 'string', description: 'Quote UUID' },
          blockId: {
            type: 'string',
            description:
              'Block UUID. For move_line this is the TARGET line_items block the line moves into; ' +
              'for reorder_lines, the block whose lines are being reordered.',
          },
          lineId: { type: 'string' },
          catalogItemId: {
            type: 'string',
            description:
              'Catalog item UUID — REQUIRED for add_catalog_line. The item must be looked up by UUID ' +
              '(use search_catalog); partNumber is NOT a lookup key.',
          },
          quantity: {
            type: 'number',
            description:
              'Line quantity (> 0) — required for add_catalog_line. add_catalog_line prices the line from the ' +
              'catalog price book in the QUOTE\'s currency and fails with NO_PRICE_FOR_CURRENCY (409) when the ' +
              'item has no price in that currency — never converted. Add a manual line (add_manual_line) instead.',
          },
          partNumber: {
            type: 'string',
            description:
              'Optional part-number override STORED on the created line (add_catalog_line only). ' +
              'Not a lookup key — the catalog item is always selected by catalogItemId.',
          },
          reason: { type: 'string', description: 'Decline reason' },
          input: {
            type: 'object',
            description:
              'Create-quote payload (create_draft). Required: orgId (UUID). Optional: siteId (UUID), ' +
              'title, currencyCode (3-letter; defaults to the organization\'s currency), expiryDate (YYYY-MM-DD), introNotes, terms, ' +
              'termsAndConditions.',
          },
          patch: {
            type: 'object',
            description:
              'Quote header or line patch fields. Header (update): depositType (\'none\'|\'percent\'|\'selected_lines\', ' +
              'omit to leave unchanged), depositPercent (0-100 exclusive, 2dp; null clears — only used when depositType ' +
              'is \'percent\'); coverPage (null clears a previously-set cover page; omit to leave untouched) — ' +
              '{enabled (boolean), title?, coverImageId? (quote image UUID, or null to clear — must be an image on ' +
              'this SAME quote), preparedForName?, showPreparedBy? (default true)}. Line (update_line): ' +
              'depositEligible (boolean; whether this line counts toward the deposit-due calculation when ' +
              'depositType is \'selected_lines\').',
            properties: {
              depositType: { type: 'string', enum: ['none', 'percent', 'selected_lines'] },
              depositPercent: { type: ['number', 'null'] },
              depositEligible: { type: 'boolean' },
            },
          },
          block: {
            type: 'object',
            description:
              'Quote block input (add_block/update_block). Required: blockType (\'heading\'|\'rich_text\'|\'image\'|' +
              '\'line_items\'|\'contract\'|\'table\'|\'callout\') plus a matching content object — heading: {text, ' +
              'level? (1-3)}; rich_text: {html}; image: {imageId (quote image UUID), caption?, width?}; line_items: ' +
              '{label?}; contract: {templateId (contract template UUID), templateVersionId (must be a PUBLISHED ' +
              'version of that template, visible to the quote\'s org/partner — otherwise rejected with ' +
              'INVALID_CONTRACT_TEMPLATE), variableValues? (manual fill-ins keyed by variable name), label?}; ' +
              'table: {columns (1-8, each {label, align?, weight?}), rows (1-100, each {cells: string[] matching ' +
              'columns.length}), caption?, zebra?, headerStyle? (\'accent\'|\'plain\')}; callout: {variant ' +
              '(\'info\'|\'accent\'|\'warn\'), title?, html}. update_block must restate the existing blockType ' +
              '(the type itself cannot change).',
          },
          line: {
            type: 'object',
            description:
              'Manual quote line fields (add_manual_line). Required: sourceType (\'manual\'|\'catalog\'|\'bundle\' — ' +
              'use \'manual\' for a hand-entered line), quantity (> 0), unitPrice (in the quote\'s currencyCode), taxable (boolean), and at least ' +
              'one of name/description. Optional: name, description, customerVisible (default true), recurrence ' +
              '(\'one_time\'|\'monthly\'|\'annual\', default \'one_time\'), termMonths, billingFrequency ' +
              '(\'monthly\'|\'annual\'), unitCost, sku, partNumber, depositEligible (default false), blockId (UUID), ' +
              'catalogItemId (UUID).',
          },
          blockIds: { type: 'array', items: { type: 'string' }, description: 'Ordered block UUIDs' },
          lineIds: { type: 'array', items: { type: 'string' }, description: 'Ordered line UUIDs' },
        },
        required: ['action'],
      },
    },
    handler: async (input, auth) => {
      const actor = actorFromAuth(auth);
      const s = (k: string) => (input[k] == null ? undefined : String(input[k]));

      const action = String(input.action);
      const required = REQUIRED_PARAMS[action];
      if (!required) {
        return JSON.stringify({ error: `Unknown action: ${action}`, code: 'VALIDATION_ERROR' });
      }
      const missing = missingParamsJson(input, action, required);
      if (missing) return missing;

      try {
        switch (action) {
          case 'create_draft':
            return JSON.stringify(await createQuote(
              createPayload.parse({ input: input.input }).input,
              actor
            ));
          case 'update': {
            const quoteId = String(input.quoteId);
            const { patch } = headerPatchPayload.parse({ patch: input.patch });
            // Reject an empty patch instead of running a no-field UPDATE: it
            // used to be the only "read" workaround (#2361) and silently bumped
            // updatedAt. Now that get_quote exists, point callers at it.
            if (Object.values(patch).every((v) => v === undefined)) {
              // Note: unknown keys are stripped by updateQuoteSchema first, so a
              // patch of only unrecognized/line-level fields lands here too.
              return validationErrorJson(
                'patch contains no updatable header fields — nothing to update. ' +
                'Use get_quote to read a quote; use update_line for line fields.'
              );
            }
            await updateQuote(quoteId, patch, actor);
            // Re-read rather than return updateQuote's raw row: the raw row carries
            // depositType/depositPercent/depositAmount but not the derived
            // depositDueTotal/categoryBreakdown (computed from current lines in
            // getQuote) — surfacing them in the update response saves the model
            // a follow-up get_quote call.
            const { quote } = await getQuote(quoteId, actor);
            return JSON.stringify(quote);
          }
          case 'delete_draft':
            await deleteDraftQuote(String(input.quoteId), actor);
            return JSON.stringify({ ok: true });
          case 'add_block':
            return JSON.stringify(await addBlock(
              String(input.quoteId),
              blockPayload.parse({ block: input.block }).block,
              actor
            ));
          case 'update_block':
            return JSON.stringify(await updateBlock(
              String(input.quoteId),
              String(input.blockId),
              blockPayload.parse({ block: input.block }).block,
              actor
            ));
          case 'delete_block':
            await deleteBlock(String(input.quoteId), String(input.blockId), actor);
            return JSON.stringify({ ok: true });
          case 'reorder_blocks': {
            const { blockIds } = reorderBlocksSchema.parse({ blockIds: input.blockIds });
            await reorderBlocks(String(input.quoteId), blockIds, actor);
            return JSON.stringify({ ok: true });
          }
          case 'add_manual_line':
            return JSON.stringify(await addManualLine(
              String(input.quoteId),
              linePayload.parse({ line: input.line }).line,
              actor
            ));
          case 'add_catalog_line': {
            // Same schema the POST /:id/lines/catalog route validates with:
            // guid catalogItemId + positive quantity, optional blockId/partNumber.
            const args = catalogQuoteLineSchema.parse({
              catalogItemId: input.catalogItemId,
              quantity: input.quantity,
              blockId: input.blockId ?? undefined,
              partNumber: input.partNumber == null ? undefined : String(input.partNumber),
            });
            return JSON.stringify(await addCatalogLine(
              String(input.quoteId),
              args.catalogItemId,
              args.quantity,
              args.blockId,
              actor,
              { partNumber: args.partNumber ?? null }
            ));
          }
          case 'update_line':
            return JSON.stringify(await updateLine(
              String(input.quoteId),
              String(input.lineId),
              linePatchPayload.parse({ patch: input.patch }).patch as UpdateQuoteLinePatch,
              actor
            ));
          case 'remove_line':
            await removeLine(String(input.quoteId), String(input.lineId), actor);
            return JSON.stringify({ ok: true });
          // Re-parents a line onto another pricing table on the SAME quote. The
          // only repair path for a legacy orphan (block_id NULL) — those lines
          // count toward the totals and print on the PDF but are invisible in
          // the web editor, so without this they need raw SQL (#2553).
          case 'move_line':
            return JSON.stringify(await moveLineToBlock(
              String(input.quoteId),
              String(input.lineId),
              String(input.blockId),
              actor
            ));
          case 'reorder_lines': {
            const { lineIds } = reorderLinesSchema.parse({ lineIds: input.lineIds });
            await reorderLines(String(input.quoteId), String(input.blockId), lineIds, actor);
            return JSON.stringify({ ok: true });
          }
          case 'send': {
            const quoteId = String(input.quoteId);
            const result = await sendQuote(quoteId, actor);
            // #3905 residual, deliberate: the AI-tool dispatcher wraps this
            // whole call in ONE transaction (aiAgentSdkTools.ts) and offers no
            // post-commit seam, so the deferred is invoked here, still inside
            // it — behaviour identical to before the split, no regression. It
            // must NOT be moved onto a separate connection: sendQuote's
            // FOR UPDATE lock is still held by this transaction, so a second
            // connection writing send_email_reason would block on it forever.
            // Fixing this properly means giving executeTool a post-commit hook.
            const delivery = await result.deliverEmail();
            if (result.superseded) {
              // No Hono context on the AI-tool path, so attribute the actor
              // explicitly rather than letting the row fall back to anonymous.
              writeAuditEvent(requestLikeFromSnapshot({}), {
                ...supersededAuditEvent({
                  childQuoteId: quoteId,
                  orgId: result.quote.orgId,
                  parentQuoteId: result.superseded.parentQuoteId,
                  previousStatus: result.superseded.previousStatus,
                  revisionNumber: result.quote.revisionNumber,
                  emailed: delivery.emailed,
                }),
                actorId: actor.userId,
              });
            }
            return JSON.stringify({
              quote: delivery.quote,
              emailed: delivery.emailed,
              emailReason: delivery.emailReason,
              acceptUrl: result.acceptUrl,
              superseded: result.superseded,
            });
          }
          case 'decline':
            return JSON.stringify(await declineQuoteByActor(String(input.quoteId), s('reason'), actor));
          case 'create_pay_link':
            return JSON.stringify(await createQuotePayLink(String(input.quoteId), actor));
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
