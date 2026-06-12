/**
 * AI Ticketing Tools
 *
 * Provides the `manage_tickets` AI tool for searching, viewing, creating,
 * commenting on, assigning, and changing the status of support tickets.
 * All mutations delegate to ticketService — this file is a thin adapter.
 */

import { and, desc, eq, type SQL } from 'drizzle-orm';
import { db } from '../db';
import { tickets } from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import { ticketSiteScopeCondition } from '../routes/tickets/siteScope';
import type { AiTool, AiToolTier } from './aiTools';
import {
  createTicket,
  changeTicketStatus,
  assignTicket,
  addTicketComment,
  type TicketStatus
} from './ticketService';

function actorFrom(auth: AuthContext) {
  return { userId: auth.user.id, name: auth.user.name };
}

/**
 * Defense-in-depth app-layer scope check for by-id ticket actions.
 * RLS is the primary isolation layer; this mirrors the house pattern from
 * aiToolsAlerts.ts (findAlertWithAccess) and the tickets route
 * (getScopedTicketOr404) — build orgCondition-scoped conditions so neither
 * a cross-org nor a cross-partner ticket ID resolves.
 *
 * Returns the ticket row, or null when not found in the caller's scope.
 */
async function findTicketWithAccess(ticketId: string, auth: AuthContext) {
  const conditions: SQL[] = [eq(tickets.id, ticketId)];
  const orgCond = auth.orgCondition(tickets.orgId);
  if (orgCond) conditions.push(orgCond);
  const [ticket] = await db.select().from(tickets).where(and(...conditions)).limit(1);
  return ticket ?? null;
}

export function registerTicketingTools(aiTools: Map<string, AiTool>): void {
  aiTools.set('manage_tickets', {
    tier: 1 as AiToolTier,
    deviceArgs: ['deviceId'],
    definition: {
      name: 'manage_tickets',
      description:
        'Search, view, create, comment on, assign, and change the status of support tickets. ' +
        'Use action "list" to search, "get" for full detail, "create" to open a new ticket, ' +
        '"comment" to add a reply or internal note, "assign" to set the assignee, ' +
        '"update_status" to move the lifecycle (resolving requires resolutionNote).',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'get', 'create', 'comment', 'assign', 'update_status'],
            description: 'The action to perform'
          },
          ticketId: {
            type: 'string',
            description: 'Ticket UUID (required for get/comment/assign/update_status)'
          },
          orgId: {
            type: 'string',
            description: 'Organization UUID (required for create; optional filter for list)'
          },
          deviceId: {
            type: 'string',
            description: 'Device UUID (optional create field; filter for list)'
          },
          subject: { type: 'string', description: 'Ticket subject (create)' },
          description: { type: 'string', description: 'Ticket description (create)' },
          priority: {
            type: 'string',
            enum: ['low', 'normal', 'high', 'urgent']
          },
          status: {
            type: 'string',
            enum: ['new', 'open', 'pending', 'on_hold', 'resolved', 'closed'],
            description: 'Target status (update_status) or filter (list)'
          },
          resolutionNote: {
            type: 'string',
            description: 'Required when resolving a ticket'
          },
          content: { type: 'string', description: 'Comment body (comment)' },
          isPublic: {
            type: 'boolean',
            description: 'Comment visibility — false = internal note (default true)'
          },
          assigneeId: {
            type: 'string',
            description: 'User UUID to assign; omit to unassign'
          },
          limit: {
            type: 'number',
            description: 'Max results for list (default 25, max 100)'
          },
          pendingReason: {
            type: 'string',
            description: 'Optional reason when setting status to pending (update_status)'
          }
        },
        required: ['action']
      }
    },

    handler: async (input, auth) => {
      const action = input.action as string;
      const actor = actorFrom(auth);

      // ── list ──────────────────────────────────────────────────────────────
      if (action === 'list') {
        const conditions: SQL[] = [];
        const orgCond = auth.orgCondition(tickets.orgId);
        if (orgCond) conditions.push(orgCond);
        // Site axis: mirror the HTTP list route (routes/tickets/tickets.ts) —
        // a site-restricted caller must not see device-bound tickets outside
        // their allowed sites (deviceless org-level tickets stay visible).
        const siteCondition = ticketSiteScopeCondition(auth);
        if (siteCondition) conditions.push(siteCondition);
        if (input.orgId) conditions.push(eq(tickets.orgId, input.orgId as string));
        if (input.deviceId) conditions.push(eq(tickets.deviceId, input.deviceId as string));
        if (input.status) conditions.push(eq(tickets.status, input.status as TicketStatus));

        const limit = Math.min(Math.max(1, Number(input.limit) || 25), 100);

        const results = await db
          .select({
            id: tickets.id,
            internalNumber: tickets.internalNumber,
            subject: tickets.subject,
            status: tickets.status,
            priority: tickets.priority,
            assignedTo: tickets.assignedTo,
            orgId: tickets.orgId,
            deviceId: tickets.deviceId,
            createdAt: tickets.createdAt
          })
          .from(tickets)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(desc(tickets.createdAt))
          .limit(limit);

        return JSON.stringify({ tickets: results, showing: results.length });
      }

      // ── get ───────────────────────────────────────────────────────────────
      if (action === 'get') {
        if (!input.ticketId) return JSON.stringify({ error: 'ticketId is required for get action' });

        // Org-scoped select — orgCondition adds the scope WHERE clause so RLS
        // defense-in-depth is folded into the single query (no extra round-trip).
        const ticket = await findTicketWithAccess(String(input.ticketId), auth);
        if (!ticket) return JSON.stringify({ error: 'Ticket not found' });
        return JSON.stringify({ ticket });
      }

      // ── create ────────────────────────────────────────────────────────────
      if (action === 'create') {
        if (!input.subject) return JSON.stringify({ error: 'subject is required for create action' });
        if (!input.orgId) return JSON.stringify({ error: 'orgId is required for create action' });
        // auth.canAccessOrg is pre-computed from accessibleOrgIds (system → true,
        // org → own org only, partner → partner's orgs). Mirror the tickets route's
        // POST / handler which calls auth.canAccessOrg(body.orgId).
        if (!auth.canAccessOrg(String(input.orgId))) {
          return JSON.stringify({ error: 'Access to this organization denied' });
        }
        // deviceId is centrally gated via the deviceArgs field on the tool
        // registration (aiTools.ts device gate) — no additional check needed here.
        const ticket = await createTicket(
          {
            orgId: String(input.orgId),
            subject: String(input.subject),
            description: input.description ? String(input.description) : undefined,
            deviceId: input.deviceId ? String(input.deviceId) : undefined,
            priority: input.priority as 'low' | 'normal' | 'high' | 'urgent' | undefined,
            source: 'ai'
          },
          actor
        );
        return JSON.stringify({ ticket });
      }

      // ── comment ───────────────────────────────────────────────────────────
      if (action === 'comment') {
        if (!input.ticketId) return JSON.stringify({ error: 'ticketId is required for comment action' });
        if (!input.content) return JSON.stringify({ error: 'content is required for comment action' });
        // Scoped pre-check: ensure ticket is visible in caller's org scope before mutating.
        const found = await findTicketWithAccess(String(input.ticketId), auth);
        if (!found) return JSON.stringify({ error: 'Ticket not found' });
        const result = await addTicketComment(
          String(input.ticketId),
          {
            content: String(input.content),
            isPublic: input.isPublic !== false
          },
          actor
        );
        return JSON.stringify({ comment: result.comment });
      }

      // ── assign ────────────────────────────────────────────────────────────
      if (action === 'assign') {
        if (!input.ticketId) return JSON.stringify({ error: 'ticketId is required for assign action' });
        // Scoped pre-check: ensure ticket is visible in caller's org scope before mutating.
        const found = await findTicketWithAccess(String(input.ticketId), auth);
        if (!found) return JSON.stringify({ error: 'Ticket not found' });
        const ticket = await assignTicket(
          String(input.ticketId),
          input.assigneeId ? String(input.assigneeId) : null,
          actor
        );
        return JSON.stringify({ ticket });
      }

      // ── update_status ─────────────────────────────────────────────────────
      if (action === 'update_status') {
        if (!input.ticketId) return JSON.stringify({ error: 'ticketId is required for update_status action' });
        if (!input.status) return JSON.stringify({ error: 'status is required for update_status action' });
        // Scoped pre-check: ensure ticket is visible in caller's org scope before mutating.
        const found = await findTicketWithAccess(String(input.ticketId), auth);
        if (!found) return JSON.stringify({ error: 'Ticket not found' });
        const ticket = await changeTicketStatus(
          String(input.ticketId),
          input.status as TicketStatus,
          {
            resolutionNote: input.resolutionNote ? String(input.resolutionNote) : undefined,
            pendingReason: input.pendingReason ? String(input.pendingReason) : undefined
          },
          actor
        );
        return JSON.stringify({ ticket });
      }

      throw new Error(`Unknown action: ${action}`);
    }
  });
}
