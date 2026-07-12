/**
 * AI Quote/Proposal Tools
 *
 * AI write tool over the quote engine:
 *  - `manage_quotes` — action multiplexer for quote draft edits, proposal
 *    blocks, lines, lifecycle send/decline, and pay links.
 *
 * Org-scope guarded AT THE TOOL LAYER (do not rely on the route scanner — the
 * known aiTools site/org-scope gap): the tool builds a `QuoteActor` from the AI
 * session's auth context (partnerId + accessibleOrgIds) and calls quote services,
 * which already enforce org access through `assertOrg`/`getQuote`. A thrown
 * `QuoteServiceError` (e.g. ORG_DENIED, QUOTE_NOT_FOUND, NOT_A_DRAFT) is
 * converted to a JSON error string rather than propagated.
 */

import type {
  CreateQuoteInput,
  QuoteBlockInput,
  QuoteLineInput,
  UpdateQuoteInput,
} from '@breeze/shared';
import type { AuthContext } from '../middleware/auth';
import type { AiTool, AiToolTier } from './aiTools';
import {
  createQuote,
  getQuote,
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
  reorderLines,
} from './quoteService';
import { sendQuote, declineQuoteByActor } from './quoteLifecycle';
import { createQuotePayLink } from './quotePay';
import { QuoteServiceError, type QuoteActor } from './quoteTypes';

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

export function registerQuoteTools(aiTools: Map<string, AiTool>): void {
  aiTools.set('manage_quotes', {
    tier: 2 as AiToolTier,
    deviceArgs: [],
    definition: {
      name: 'manage_quotes',
      description:
        'Create and manage quotes/proposals for orgs the caller can access: draft header edits, blocks, lines, ' +
        'send/decline lifecycle actions, and accepted-quote pay links. Sending a quote requires approval.',
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
              'reorder_lines',
              'send',
              'decline',
              'create_pay_link',
            ],
          },
          quoteId: { type: 'string', description: 'Quote UUID' },
          blockId: { type: 'string' },
          lineId: { type: 'string' },
          catalogItemId: { type: 'string' },
          quantity: { type: 'number' },
          partNumber: { type: 'string' },
          reason: { type: 'string', description: 'Decline reason' },
          input: { type: 'object', description: 'Full create-quote payload including orgId and siteId' },
          patch: {
            type: 'object',
            description:
              'Quote header or line patch fields. Header (update): depositType (\'none\'|\'percent\'|\'selected_lines\', ' +
              'omit to leave unchanged), depositPercent (0-100 exclusive, 2dp; null clears — only used when depositType ' +
              'is \'percent\'). Line (update_line): depositEligible (boolean; whether this line counts toward the ' +
              'deposit-due calculation when depositType is \'selected_lines\').',
            properties: {
              depositType: { type: 'string', enum: ['none', 'percent', 'selected_lines'] },
              depositPercent: { type: ['number', 'null'] },
              depositEligible: { type: 'boolean' },
            },
          },
          block: { type: 'object', description: 'Quote block input fields' },
          line: { type: 'object', description: 'Manual quote line fields' },
          blockIds: { type: 'array', items: { type: 'string' }, description: 'Ordered block UUIDs' },
          lineIds: { type: 'array', items: { type: 'string' }, description: 'Ordered line UUIDs' },
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
            return JSON.stringify(await createQuote(input.input as CreateQuoteInput, actor));
          case 'update': {
            const quoteId = String(input.quoteId);
            await updateQuote(quoteId, input.patch as UpdateQuoteInput, actor);
            // Re-read rather than return updateQuote's raw row: the raw row carries
            // depositType/depositPercent/depositAmount but not the derived
            // depositDueTotal/categoryBreakdown (computed from current lines in
            // getQuote) — there's no separate read tool for the AI to fetch those,
            // so the update response has to surface them itself.
            const { quote } = await getQuote(quoteId, actor);
            return JSON.stringify(quote);
          }
          case 'delete_draft':
            await deleteDraftQuote(String(input.quoteId), actor);
            return JSON.stringify({ ok: true });
          case 'add_block':
            return JSON.stringify(await addBlock(
              String(input.quoteId),
              input.block as QuoteBlockInput,
              actor
            ));
          case 'update_block':
            return JSON.stringify(await updateBlock(
              String(input.quoteId),
              String(input.blockId),
              input.block as QuoteBlockInput,
              actor
            ));
          case 'delete_block':
            await deleteBlock(String(input.quoteId), String(input.blockId), actor);
            return JSON.stringify({ ok: true });
          case 'reorder_blocks':
            await reorderBlocks(String(input.quoteId), input.blockIds as string[], actor);
            return JSON.stringify({ ok: true });
          case 'add_manual_line':
            return JSON.stringify(await addManualLine(
              String(input.quoteId),
              input.line as QuoteLineInput,
              actor
            ));
          case 'add_catalog_line':
            return JSON.stringify(await addCatalogLine(
              String(input.quoteId),
              String(input.catalogItemId),
              Number(input.quantity),
              s('blockId'),
              actor,
              { partNumber: input.partNumber == null ? null : String(input.partNumber) }
            ));
          case 'update_line':
            return JSON.stringify(await updateLine(
              String(input.quoteId),
              String(input.lineId),
              input.patch as UpdateQuoteLinePatch,
              actor
            ));
          case 'remove_line':
            await removeLine(String(input.quoteId), String(input.lineId), actor);
            return JSON.stringify({ ok: true });
          case 'reorder_lines':
            await reorderLines(String(input.quoteId), String(input.blockId), input.lineIds as string[], actor);
            return JSON.stringify({ ok: true });
          case 'send':
            return JSON.stringify(await sendQuote(String(input.quoteId), actor));
          case 'decline':
            return JSON.stringify(await declineQuoteByActor(String(input.quoteId), s('reason'), actor));
          case 'create_pay_link':
            return JSON.stringify(await createQuotePayLink(String(input.quoteId), actor));
          default:
            return JSON.stringify({ error: `Unknown action: ${s('action')}` });
        }
      } catch (err) {
        const json = serviceErrorToJson(err);
        if (json) return json;
        throw err;
      }
    },
  });
}
