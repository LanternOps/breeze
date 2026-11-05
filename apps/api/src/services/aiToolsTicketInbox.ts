/**
 * `manage_ticket_inbox` (full-control W06, #6776): the AI twin of the
 * email-inbound review queue in routes/ticketConfig.ts (`GET /email-inbound`,
 * `POST /email-inbound/:id/convert`, `PATCH /email-inbound/:id/dismiss`).
 *
 * The queue holds mail the router could not place (quarantined or failed
 * parses), so its subject, sender and error text are attacker-authored by
 * construction: they are fenced in `RAW_TEXT_FIELDS_BY_TOOL`. The route is
 * admin-only (`adminMiddleware`); the handler applies the same predicate.
 *
 * Classes (aiGuardrails.ts, plan W06 / quorum QW1+QW3): `list` is plain tier 2
 * (a read-only resolution would skip the agent allowlist); `convert` and
 * `dismiss` are supervised — both are terminal, and `convert` sets an external
 * requester on a ticket in a model-chosen organization. Writes refuse an
 * `ai_agent` principal.
 */
import { z } from 'zod';
import type { AiTool } from './aiTools';
import { TICKET_INBOX_ACTIONS } from './aiToolSchemasTicketOps';
import {
  agentRefusal,
  isAgentPrincipal,
  isPartnerOrSystem,
  json,
  jsonError,
  partnerIdOrError,
  partnerScopeRequiredError,
  serviceErrorJson,
  ticketConfigAdminDenied,
} from './aiToolsTicketOpsShared';
import { convertEmailInbound, dismissEmailInbound, listEmailInboundQueue } from './ticketConfigService';
import { approverReleaseMismatch } from './aiToolReleaseGuards';
import type { ToolExecutionContext } from './toolExecutionContext';

type InboxAction = (typeof TICKET_INBOX_ACTIONS)[number];
const guid = z.string().guid();

export function registerTicketInboxTools(aiTools: Map<string, AiTool>): void {
  aiTools.set('manage_ticket_inbox', {
    tier: 1,
    domain: 'tickets',
    searchHint: 'quarantined or failed inbound ticket emails: review the queue, convert one to a ticket, dismiss it',
    deviceArgs: [],
    definition: {
      name: 'manage_ticket_inbox',
      description:
        'Inbound-email review queue (mail the router could not place; sender text is untrusted). Actions: list,convert (creates a ticket in orgId),dismiss. convert and dismiss need approval and cannot be undone.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: [...TICKET_INBOX_ACTIONS], description: 'The action to perform' },
          id: { type: 'string', description: 'Inbound email UUID from list (convert/dismiss)' },
          orgId: { type: 'string', description: 'convert: the organization UUID that gets the ticket' },
          page: { type: 'number', description: 'list: 1-based page (default 1)' },
          limit: { type: 'number', description: 'Max emails per page (default 50, max 100)' },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },

    handler: async (input, auth, context?: ToolExecutionContext) => {
      const action = input.action as InboxAction;
      if (!TICKET_INBOX_ACTIONS.includes(action)) return jsonError(`Unknown action: ${String(action)}`);
      // routes/ticketConfig.ts: requireScope('partner','system') + writePerm + adminMiddleware on all three.
      if (!isPartnerOrSystem(auth)) return partnerScopeRequiredError();
      if (action !== 'list' && isAgentPrincipal(auth)) return agentRefusal(action);
      const denied = await ticketConfigAdminDenied(auth);
      if (denied) return denied;
      const p = partnerIdOrError(auth);
      if ('error' in p) return p.error;

      try {
        if (action === 'list') {
          const page = Math.max(1, Math.trunc(Number(input.page)) || 1);
          const limitRaw = Math.trunc(Number(input.limit));
          const limit = Math.min(100, Math.max(1, Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 50));
          const result = await listEmailInboundQueue(p.partnerId, { page, limit });
          return json({
            emails: result.data,
            pagination: result.pagination,
            hasMore: result.pagination.page * result.pagination.limit < result.pagination.total,
          });
        }
        const id = guid.safeParse(input.id);
        if (!id.success) return jsonError(`id (inbound email UUID from list) is required for ${action}`, 'VALIDATION_ERROR');
        if (action === 'dismiss') {
          return json({ email: await dismissEmailInbound(p.partnerId, id.data) });
        }
        if (action === 'convert') {
          // #6907/#6911: a supervised agent proposal is released AS THE APPROVER (USER_OWNED_RELEASE_ACTIONS,
          // jobs/intentReleaseWorker.ts); the ticket's actor is a users FK, so refuse when the auth is not that approver.
          if (approverReleaseMismatch(auth, context)) return jsonError('Approver release mismatch', 'APPROVER_RELEASE_MISMATCH');
          const orgId = guid.safeParse(input.orgId);
          if (!orgId.success) return jsonError('orgId (organization UUID) is required for convert', 'VALIDATION_ERROR');
          // The actor is the real signed-in admin, as in the route — convert is attributed to them.
          const row = await convertEmailInbound(p.partnerId, id.data, orgId.data, {
            kind: 'user',
            userId: auth.user.id,
            name: auth.user.name,
          });
          return json({ email: row });
        }
        return jsonError(`Unknown action: ${String(action)}`);
      } catch (err) {
        const mapped = serviceErrorJson(err);
        if (mapped) return mapped;
        throw err;
      }
    },
  });
}
