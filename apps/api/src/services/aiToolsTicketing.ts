/**
 * AI Ticketing Tools
 *
 * Provides the `manage_tickets` AI tool for searching, viewing, creating,
 * commenting on, assigning, and changing the status of support tickets.
 * All mutations delegate to ticketService — this file is a thin adapter.
 */

import { and, desc, eq, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../db';
import { deviceHardware, devices, ticketDrafts, tickets } from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import { isAiAgentPrincipal } from '../middleware/auth';
import { deviceInSiteScope, ticketSiteScopeCondition } from '../routes/tickets/siteScope';
import { deviceIdSiteDenied, deviceScopeCondition } from './aiToolsSiteScope';
// One implementation of alert-by-id access, not a twin (#6096 I6). aiToolsAlerts
// does not import this module, so the edge is acyclic.
import { findAlertWithAccess } from './aiToolsAlerts';
import type { AiTool, AiToolTier } from './aiTools';
import type { ToolExecutionContext } from './toolExecutionContext';
import {
  createTicket,
  changeTicketStatus,
  assignTicket,
  addTicketComment,
  addAiTriageNote,
  applyAiFieldUpdates,
  TicketServiceError,
  updateTicketFields,
  linkAlertToTicket,
  unlinkAlertFromTicket,
  createTicketFromAlert,
  editTicketComment,
  deleteTicketComment,
  moveTicketOrg,
  revalidateTicketAssignee,
  type CreateTicketInput,
  type TicketStatus,
  type UpdateTicketFieldsInput
} from './ticketService';
import {
  createTimeEntry,
  startTimer,
  stopTimer,
  TimeEntryServiceError
} from './timeEntryService';
import { findStatusByName, listActiveStatusNames } from './ticketConfigService';
import { TicketMoveCurrencyBlockedError } from './ticketMoveCurrencyGuard';
import { getUserPermissions, hasPermission, PERMISSIONS } from './permissions';
import { canManageTimeEntryBilling } from './timeEntryBillingPermission';
import { listChecklist } from './ticketChecklistService';
import { listWorkTypes } from './workTypeService';

type ParseResult<T> = { value: T } | { error: string };

function actorFrom(auth: AuthContext) {
  return { userId: auth.user.id, name: auth.user.name };
}

/**
 * P2-4 (#4191): the run id behind an autonomous ai_agent-principal call —
 * the ONLY reliable signal that this manage_tickets invocation is executing
 * under the ticket-triage release path (durable Tier-3 release, or an
 * inline Tier-2 auto-exec dispatch) rather than a live human's attended-chat
 * session. An attended-chat session always executes as the human's own
 * `user_session` AuthContext (auth.user.id is a real users.id row) even when
 * the AI proposed the values — `actorFrom`'s userId is only ever safe to
 * write into `ticket_comments.user_id` (an FK to `users`) for that case.
 * `principal.kind === 'ai_agent'` means `auth.user.id` is the AGENT's
 * synthetic id (agentAuthContext.ts), never a real users row, which is
 * exactly why update_fields/comment route to the dedicated AI-safe
 * executors below instead of the shared human-actor ticketService functions.
 */
function agentRunIdFrom(auth: AuthContext): string | null {
  return isAiAgentPrincipal(auth) && auth.principal.kind === 'ai_agent' ? auth.principal.runId : null;
}

/**
 * #4209 (W03): the refusal the three users-FK actions return for an ai_agent
 * principal.
 *
 * `assign` writes `tickets.assigned_to`; `update_status` and `create` write
 * `created_by`/actor columns and emit `actorUserId`. All three go through
 * `actorFrom(auth)`, whose `auth.user.id` for an ai_agent principal is an
 * `aiAgents.id` — attribution only, never a `users` row (agentAuthContext.ts).
 * Writing it into any of those columns forges a foreign key and fails at
 * runtime with a 23503 the agent cannot interpret.
 *
 * The `comment`, `update_fields` and `draft` branches each got a real
 * agent-principal design (addAiTriageNote, applyAiFieldUpdates, ticket_drafts);
 * these three did not, so they refuse rather than guess. Supporting them means
 * designing agent attribution for assignment, status and creation — a product
 * decision, tracked separately. A stable, typed error code is what lets the
 * agent's tool loop relay the limitation instead of retrying a 23503.
 *
 * Review finding: the payload carries NO `success` key, on purpose. The SDK's
 * error classifier (`aiAgentSdkTools.ts`, "Detect error responses returned as
 * JSON strings by tool handlers") flags a result as a tool error only when
 * `'error' in parsed && !('success' in parsed) && !('data' in parsed) &&
 * !('configured' in parsed)`. Adding `success: false` would EXEMPT the refusal
 * from that check, so it would be recorded by `safePostToolUse` as an ordinary
 * successful tool call and the MCP content block would omit `isError: true` —
 * a policy refusal indistinguishable from a success in the execution log,
 * which is precisely the observability this wave exists to add. The bare
 * `{ error, … }` shape is also what every other refusal in this file uses.
 */
function refuseAgentPrincipal(action: string): string {
  return JSON.stringify({ error: 'agent_principal_unsupported_action', action });
}

/** Postgres unique-violation, however the driver happens to wrap it (mirrors ticketService.ts's isUniqueViolation). */
function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  if (code === '23505') return true;
  return isUniqueViolation((err as { cause?: unknown }).cause);
}

function serviceErrorToJson(err: unknown): string | null {
  if (err instanceof TicketServiceError) {
    return JSON.stringify({ error: err.message, code: err.code });
  }
  // Cross-currency move block (#3776). The AI never passes
  // acceptCurrencyMismatch — a human accepts a mismatch, with invoices:write.
  if (err instanceof TicketMoveCurrencyBlockedError) {
    return JSON.stringify({ error: err.message, code: err.code, details: err.details });
  }
  return null;
}

async function timeEntryActorFrom(auth: AuthContext) {
  const userBacked = auth.principal?.kind === 'user_session' || auth.principal?.kind === 'oauth_grant';
  const permissions = userBacked && !auth.user.isPlatformAdmin ? await getUserPermissions(auth.user.id, {
    partnerId: auth.partnerId ?? undefined,
    orgId: auth.orgId ?? undefined,
    scope: auth.scope,
  }) : null;
  return {
    userId: auth.user.id,
    name: auth.user.name,
    partnerId: auth.partnerId,
    accessibleOrgIds: auth.accessibleOrgIds,
    // AI tools always operate on the calling user's own entries — never admin-manage others'.
    manageAll: false as const,
    manageBilling: canManageTimeEntryBilling(auth, permissions),
  };
}

/**
 * Preserve undefined on omission so the service applies the category default.
 *
 * A well-formed UUID is NOT trusted. It used to short-circuit the lookup, but a
 * model hallucinates syntactically valid ids as readily as names, and an id the
 * partner does not own reached the composite FK `(work_type_id, partner_id)`
 * unchecked -- a 23503 raised inside the request transaction, which aborts it,
 * so this function's own caller could only surface a raw 500. Both an id and a
 * name are now matched against the partner's ACTIVE list and a miss returns the
 * same enumerated refusal, which is also what steers the model to a real value.
 */
async function resolveWorkTypeId(raw: string | undefined, partnerId: string): Promise<string | undefined> {
  if (!raw) return undefined;
  const active = await listWorkTypes(partnerId, { includeInactive: false });
  const needle = raw.trim().toLowerCase();
  const match = active.find((w) => w.id.toLowerCase() === needle || w.name.toLowerCase() === needle);
  if (!match) {
    throw new TimeEntryServiceError(
      `Unknown work type "${raw}". Valid work types: ${active.map((w) => w.name).join(', ') || '(none configured)'}`,
      400,
    );
  }
  return match.id;
}

/**
 * The currency an entry's money is expressed in — the row's own snapshot
 * (`time_entries.currency_code`, stamped once at creation / first money;
 * null only for a standalone entry that carries no rate).
 */
function entryCurrency(entry: { currencyCode?: string | null }): string | null {
  return entry.currencyCode ?? null;
}

/**
 * Defense-in-depth app-layer scope check for by-id ticket actions.
 * RLS is the primary isolation layer; this mirrors the house pattern from
 * aiToolsAlerts.ts (findAlertWithAccess) and the tickets route
 * (getScopedTicketOr404) — build orgCondition-scoped conditions so neither
 * a cross-org nor a cross-partner ticket ID resolves.
 *
 * Site axis: RLS enforces only the org axis, so a site-restricted
 * org user must also be gated on the SITE axis here. After the org-scoped load,
 * a device-bound ticket is resolved only when its device is in the caller's
 * exact-device allowlist AND its site is in the caller's site allowlist
 * (deviceInSiteScope enforces both axes independently, #6086 finding 6);
 * deviceless (org-level) tickets stay accessible at org scope — they are not
 * device-attributable — matching getScopedTicketOr404 in the HTTP route.
 *
 * Returns the ticket row, or null when not found / out of the caller's scope.
 */
async function findTicketWithAccess(ticketId: string, auth: AuthContext) {
  const conditions: SQL[] = [eq(tickets.id, ticketId), isNull(tickets.deletedAt)];
  const orgCond = auth.orgCondition(tickets.orgId);
  if (orgCond) conditions.push(orgCond);
  const [ticket] = await db.select().from(tickets).where(and(...conditions)).limit(1);
  if (!ticket) return null;
  if (ticket.deviceId && !(await deviceInSiteScope(auth, ticket.deviceId))) {
    return null;
  }
  return ticket;
}

async function canManageAnyTicketComment(auth: AuthContext): Promise<boolean> {
  const userPerms = await getUserPermissions(auth.user.id, {
    partnerId: auth.partnerId || undefined,
    orgId: auth.orgId || undefined,
  });
  if (!userPerms) return false;
  return hasPermission(userPerms, PERMISSIONS.TICKETS_MANAGE.resource, PERMISSIONS.TICKETS_MANAGE.action);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function stringField(record: Record<string, unknown>, key: string, label: string): ParseResult<string | undefined> {
  if (!hasOwn(record, key)) return { value: undefined };
  const value = record[key];
  if (typeof value === 'string') return { value };
  return { error: `${label} must be a string` };
}

function stringOrNullField(record: Record<string, unknown>, key: string, label: string): ParseResult<string | null | undefined> {
  if (!hasOwn(record, key)) return { value: undefined };
  const value = record[key];
  if (value === null) return { value: null };
  if (typeof value === 'string') return { value };
  return { error: `${label} must be a string or null` };
}

function numberOrNullField(record: Record<string, unknown>, key: string, label: string): ParseResult<number | null | undefined> {
  if (!hasOwn(record, key)) return { value: undefined };
  const value = record[key];
  if (value === null) return { value: null };
  if (typeof value === 'number' && Number.isFinite(value)) return { value };
  return { error: `${label} must be a number or null` };
}

function priorityField(record: Record<string, unknown>, label: string): ParseResult<UpdateTicketFieldsInput['priority'] | undefined> {
  if (!hasOwn(record, 'priority')) return { value: undefined };
  const value = record.priority;
  if (value === 'low' || value === 'normal' || value === 'high' || value === 'urgent') {
    return { value };
  }
  return { error: `${label} must be one of low, normal, high, urgent` };
}

function dueDateField(record: Record<string, unknown>, label: string): ParseResult<Date | null | undefined> {
  if (!hasOwn(record, 'dueDate')) return { value: undefined };
  const value = record.dueDate;
  if (value === null) return { value: null };
  if (value instanceof Date && !Number.isNaN(value.getTime())) return { value };
  if (typeof value === 'string') {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return { value: date };
  }
  return { error: `${label} must be an ISO datetime string or null` };
}

function parseUpdateFields(value: unknown): ParseResult<UpdateTicketFieldsInput> {
  if (!isRecord(value)) return { error: 'fields object is required for update_fields action' };
  const fields: UpdateTicketFieldsInput = {};

  for (const key of ['subject', 'description'] as const) {
    const parsed = stringField(value, key, `fields.${key}`);
    if ('error' in parsed) return { error: parsed.error };
    if (parsed.value !== undefined) fields[key] = parsed.value;
  }

  for (const key of ['categoryId', 'deviceId', 'submittedBy', 'submitterName', 'submitterEmail'] as const) {
    const parsed = stringOrNullField(value, key, `fields.${key}`);
    if ('error' in parsed) return { error: parsed.error };
    if (parsed.value !== undefined) fields[key] = parsed.value;
  }

  const priority = priorityField(value, 'fields.priority');
  if ('error' in priority) return { error: priority.error };
  if (priority.value !== undefined) fields.priority = priority.value;

  const dueDate = dueDateField(value, 'fields.dueDate');
  if ('error' in dueDate) return { error: dueDate.error };
  if (dueDate.value !== undefined) fields.dueDate = dueDate.value;

  const responseSlaMinutes = numberOrNullField(value, 'responseSlaMinutes', 'fields.responseSlaMinutes');
  if ('error' in responseSlaMinutes) return { error: responseSlaMinutes.error };
  if (responseSlaMinutes.value !== undefined) fields.responseSlaMinutes = responseSlaMinutes.value;

  const resolutionSlaMinutes = numberOrNullField(value, 'resolutionSlaMinutes', 'fields.resolutionSlaMinutes');
  if ('error' in resolutionSlaMinutes) return { error: resolutionSlaMinutes.error };
  if (resolutionSlaMinutes.value !== undefined) fields.resolutionSlaMinutes = resolutionSlaMinutes.value;

  if (hasOwn(value, 'tags')) {
    if (!Array.isArray(value.tags) || !value.tags.every((tag): tag is string => typeof tag === 'string')) {
      return { error: 'fields.tags must be an array of strings' };
    }
    fields.tags = value.tags;
  }

  if (Object.keys(fields).length === 0) return { error: 'At least one update field is required' };
  return { value: fields };
}

function parseAlertOverrides(value: unknown): ParseResult<Partial<Pick<CreateTicketInput, 'subject' | 'description' | 'categoryId' | 'priority' | 'assigneeId'>>> {
  if (value === undefined) return { value: {} };
  if (!isRecord(value)) return { error: 'overrides must be an object' };

  const overrides: Partial<Pick<CreateTicketInput, 'subject' | 'description' | 'categoryId' | 'priority' | 'assigneeId'>> = {};
  const subject = stringField(value, 'subject', 'overrides.subject');
  if ('error' in subject) return { error: subject.error };
  if (subject.value !== undefined) overrides.subject = subject.value;
  const description = stringField(value, 'description', 'overrides.description');
  if ('error' in description) return { error: description.error };
  if (description.value !== undefined) overrides.description = description.value;
  const categoryId = stringField(value, 'categoryId', 'overrides.categoryId');
  if ('error' in categoryId) return { error: categoryId.error };
  if (categoryId.value !== undefined) overrides.categoryId = categoryId.value;
  const assigneeId = stringField(value, 'assigneeId', 'overrides.assigneeId');
  if ('error' in assigneeId) return { error: assigneeId.error };
  if (assigneeId.value !== undefined) overrides.assigneeId = assigneeId.value;
  const priority = priorityField(value, 'overrides.priority');
  if ('error' in priority) return { error: priority.error };
  if (priority.value !== undefined) overrides.priority = priority.value;
  return { value: overrides };
}

export function registerTicketingTools(aiTools: Map<string, AiTool>): void {
  aiTools.set('manage_tickets', {
    tier: 1 as AiToolTier,
    deviceArgs: ['deviceId'],
    domain: 'tickets',
    searchHint: 'tickets: list, get, create, update, assign, comment, link alerts or devices, log time, start/stop timer',
    definition: {
      name: 'manage_tickets',
      description:
        'Search, view, create, comment on, assign, update fields, change status, link/unlink alerts, create from alerts, edit/delete comments, move tickets between orgs with approval, and log time against support tickets. ' +
        'Use action "list" to search, "get" for full detail, "create" to open a new ticket, ' +
        '"comment" to add a reply or internal note, "assign" to set the assignee, ' +
        '"update_status" to move the lifecycle (resolving requires resolutionNote), ' +
        '"list_work_types" to list active work types (id and name), ' +
        '"log_time_entry" to record a completed time block (requires startedAt + endedAt), ' +
        '"start_timer" to start a running timer (auto-stops any existing timer), ' +
        '"stop_timer" to stop the currently running timer, ' +
        '"link_device" to link a device to a ticket by exact hostname or serial number, ' +
        '"draft" to store a proposed reply or resolution-note draft for human review.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: {
            type: 'string',
            enum: [
              'list',
              'get',
              'create',
              'comment',
              'assign',
              'update_status',
              'list_work_types',
              'log_time_entry',
              'start_timer',
              'stop_timer',
              'update_fields',
              'link_alert',
              'unlink_alert',
              'create_from_alert',
              'edit_comment',
              'delete_comment',
              'move_org',
              'link_device',
              'draft'
            ],
            description: 'The action to perform'
          },
          ticketId: {
            type: 'string',
            description: 'Ticket UUID (required for get/comment/assign/update_status/update_fields/link_alert/unlink_alert/move_org/link_device/draft)'
          },
          alertId: {
            type: 'string',
            description: 'Alert UUID (required for link_alert/unlink_alert/create_from_alert)'
          },
          commentId: {
            type: 'string',
            description: 'Comment UUID (required for edit_comment/delete_comment)'
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
            description: 'Target core status (update_status) or filter (list). Mutually exclusive with statusName — provide only one.'
          },
          statusName: {
            type: 'string',
            description: 'A custom status name configured by the partner (e.g. "Waiting on vendor"); alternative to status for update_status. Mutually exclusive with status — provide only one.'
          },
          resolutionNote: {
            type: 'string',
            description: 'Required when resolving a ticket'
          },
          content: { type: 'string', description: 'Comment body (comment/edit_comment)' },
          expectedTicketId: {
            type: 'string',
            description: 'Parent ticket UUID for edit_comment/delete_comment scope verification'
          },
          targetOrgId: {
            type: 'string',
            description: 'Target organization UUID for move_org'
          },
          fields: {
            type: 'object',
            description: 'Field patch for update_fields'
          },
          hostname: {
            type: 'string',
            description: 'Exact device hostname to link (link_device) — resolved within the ticket\'s org'
          },
          serial: {
            type: 'string',
            description: 'Exact device serial number to link (link_device) — resolved within the ticket\'s org'
          },
          kind: {
            type: 'string',
            enum: ['reply', 'resolution_note'],
            description: 'Which draft kind to store (draft): a customer-facing reply or an internal resolution note'
          },
          overrides: {
            type: 'object',
            description: 'Optional create_from_alert ticket overrides (subject, description, categoryId, priority, assigneeId)'
          },
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
          },
          startedAt: {
            type: 'string',
            description: 'ISO 8601 datetime — start of the time block (required for log_time_entry; optional for start_timer)'
          },
          endedAt: {
            type: 'string',
            description: 'ISO 8601 datetime — end of the time block (required for log_time_entry)'
          },
          isBillable: {
            type: 'boolean',
            description: 'Whether this time is billable to the customer (log_time_entry / stop_timer; defaults from ticket category)'
          },
          workType: {
            type: 'string',
            description:
              'Work type for log_time_entry / start_timer — the NAME (e.g. "On-site", "Remote", "After-hours") or its id. ' +
              'Says WHAT the work was. Omit it to let the ticket category default apply. ' +
              'Use list_work_types to see the options. Cannot be changed at stop_timer; edit the time entry instead.',
          },
          hourlyRate: {
            type: 'number',
            description: 'Override hourly rate in the ticket organization\'s currency (log_time_entry; defaults from org/category settings only when their rate currency matches the org)'
          }
        },
        required: ['action']
      }
    },

    handler: async (input, auth, context?: ToolExecutionContext) => {
      const action = input.action as string;
      const actor = actorFrom(auth);

      // ── list ──────────────────────────────────────────────────────────────
      if (action === 'list') {
        const conditions: SQL[] = [isNull(tickets.deletedAt)]; // never surface soft-deleted tickets to the AI
        const orgCond = auth.orgCondition(tickets.orgId);
        if (orgCond) conditions.push(orgCond);
        // Site axis: mirror the HTTP list route (routes/tickets/tickets.ts) —
        // a site-restricted caller must not see device-bound tickets outside
        // their allowed sites (deviceless org-level tickets stay visible).
        const siteCondition = ticketSiteScopeCondition(auth);
        if (siteCondition) conditions.push(siteCondition);
        // Exact-device axis (#6086 finding 6): a device-bound agent run must not
        // enumerate a SIBLING device's tickets. Independent of the site axis —
        // a device-less analysis run carries allowedDeviceIds with no
        // allowedSiteIds, so the site condition above is undefined for it.
        // Deviceless (org-level) tickets stay visible: they are not
        // device-attributable (same carve-out as findTicketWithAccess).
        const deviceCondition = deviceScopeCondition(auth, tickets.deviceId);
        if (deviceCondition) conditions.push(or(isNull(tickets.deviceId), deviceCondition)!);
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
        // #5808 W03 — READ ONLY. Labels and progress, so "summarise where this
        // ticket stands" works. No per-step detail and no doneByUserId: the
        // attestation is a compliance record, not context for a summary. There
        // is deliberately NO tick-off action (spec §6.5, OD-7 A) — an agent
        // ticking a box it did not perform is a falsified record. The control
        // that actually enforces that is W01's isInteractiveUserSession gate on
        // the `done` branch, not the absence of a tool here: an MCP API key
        // carries its creator's real user id.
        const checklist = await listChecklist(ticket.id);
        return JSON.stringify({
          ticket,
          checklist: checklist.total === 0 ? null : {
            done: checklist.done,
            total: checklist.total,
            items: checklist.items.map((i) => ({ label: i.label, done: i.done })),
          },
        });
      }

      // ── create ────────────────────────────────────────────────────────────
      if (action === 'create') {
        if (agentRunIdFrom(auth)) return refuseAgentPrincipal(action);
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
        try {
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
        } catch (err) {
          // #5075 W04 — Service Management 'off' refuses new-ticket creation with
          // a TicketServiceError(409, 'service_management_off'). Every other
          // mutating action in this file converts a thrown TicketServiceError to
          // JSON via serviceErrorToJson instead of letting it escape as an
          // unhandled rejection; create previously did not, which meant the AI's
          // tool-call loop received a raw thrown error instead of a message it
          // could relay to the user.
          const json = serviceErrorToJson(err);
          if (json) return json;
          throw err;
        }
      }

      // ── comment ───────────────────────────────────────────────────────────
      if (action === 'comment') {
        if (!input.ticketId) return JSON.stringify({ error: 'ticketId is required for comment action' });
        if (!input.content) return JSON.stringify({ error: 'content is required for comment action' });
        // Scoped pre-check: ensure ticket is visible in caller's org scope before mutating.
        const found = await findTicketWithAccess(String(input.ticketId), auth);
        if (!found) return JSON.stringify({ error: 'Ticket not found' });
        // P2-4 (#4191): an ai_agent-principal call is the first real writer of
        // the 6.3 loop-guard columns — route through addAiTriageNote, never
        // addTicketComment (whose userId FK would reject the agent's
        // synthetic id). Always internal/private, regardless of `isPublic`.
        const agentRunId = agentRunIdFrom(auth);
        if (agentRunId) {
          const result = await addAiTriageNote(String(input.ticketId), agentRunId, String(input.content), found.orgId);
          return JSON.stringify({ comment: result.comment });
        }
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
        if (agentRunIdFrom(auth)) return refuseAgentPrincipal(action);
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
        if (agentRunIdFrom(auth)) return refuseAgentPrincipal(action);
        if (!input.ticketId) return JSON.stringify({ error: 'ticketId is required for update_status action' });
        if (!input.status && !input.statusName) return JSON.stringify({ error: 'status or statusName is required for update_status action' });
        // Exactly one of status / statusName must be provided.
        if (input.status && input.statusName) {
          return JSON.stringify({ error: 'Provide only one of status or statusName, not both' });
        }
        // Scoped pre-check: ensure ticket is visible in caller's org scope before mutating.
        const found = await findTicketWithAccess(String(input.ticketId), auth);
        if (!found) return JSON.stringify({ error: 'Ticket not found' });

        let changeTarget: { status: TicketStatus } | { statusId: string };

        if (input.statusName) {
          // Resolve custom status name to a statusId. auth.partnerId may be null for
          // org-scope callers — fall back to the ticket's partner via found.partnerId
          // (tickets row has a partnerId column set at create time).
          const partnerId = auth.partnerId ?? found.partnerId;
          if (!partnerId) {
            return JSON.stringify({ error: 'Cannot resolve statusName: partner context unavailable' });
          }
          const statusRow = await findStatusByName(partnerId, String(input.statusName));
          if (!statusRow) {
            const activeNames = await listActiveStatusNames(partnerId);
            let nameList: string;
            if (activeNames.length === 0) {
              nameList = '(none)';
            } else {
              const names = activeNames.slice(0, 20).map((n) => `"${n}"`).join(', ');
              nameList = activeNames.length > 20
                ? `${names}, …and ${activeNames.length - 20} more`
                : names;
            }
            return JSON.stringify({
              error: `Unknown status name "${input.statusName}". Active status names for this partner: ${nameList}`
            });
          }
          changeTarget = { statusId: statusRow.id };
        } else {
          changeTarget = { status: input.status as TicketStatus };
        }

        const ticket = await changeTicketStatus(
          String(input.ticketId),
          changeTarget,
          {
            resolutionNote: input.resolutionNote ? String(input.resolutionNote) : undefined,
            pendingReason: input.pendingReason ? String(input.pendingReason) : undefined
          },
          actor
        );
        return JSON.stringify({ ticket });
      }

      // ── update_fields ────────────────────────────────────────────────────
      if (action === 'update_fields') {
        if (!input.ticketId) return JSON.stringify({ error: 'ticketId is required for update_fields action' });
        const parsedFields = parseUpdateFields(input.fields);
        if ('error' in parsedFields) return JSON.stringify({ error: parsedFields.error });
        // Scoped pre-check: ensure ticket is visible before the service mutates by id.
        const found = await findTicketWithAccess(String(input.ticketId), auth);
        if (!found) return JSON.stringify({ error: 'Ticket not found' });
        if (typeof parsedFields.value.deviceId === 'string' && !(await deviceInSiteScope(auth, parsedFields.value.deviceId))) {
          return JSON.stringify({ error: 'Device not found or access denied' });
        }
        // P2-4 (#4191): an ai_agent-principal call routes through the
        // CAS-guarded applyAiFieldUpdates — never updateTicketFields, whose
        // audit-comment insert writes actor.userId into ticket_comments'
        // users-FK column (the agent's synthetic id is not a users.id row).
        // Attended-chat (a live human's user_session) is unaffected — this
        // branch is unreachable for it.
        const agentRunId = agentRunIdFrom(auth);
        if (agentRunId) {
          const updates: Parameters<typeof applyAiFieldUpdates>[2] = {};
          if (typeof parsedFields.value.categoryId === 'string') {
            updates.categoryId = { value: parsedFields.value.categoryId, expectedCurrent: found.categoryId };
          }
          if (parsedFields.value.priority !== undefined) {
            updates.priority = { value: parsedFields.value.priority, expectedCurrent: found.priority };
          }
          if (Object.keys(updates).length === 0) {
            return JSON.stringify({ error: 'An AI agent may only update categoryId and priority via update_fields' });
          }
          try {
            const result = await applyAiFieldUpdates(String(input.ticketId), found.orgId, updates, agentRunId);
            return JSON.stringify({ fields: result });
          } catch (err) {
            const json = serviceErrorToJson(err);
            if (json) return json;
            throw err;
          }
        }
        try {
          const ticket = await updateTicketFields(String(input.ticketId), parsedFields.value, actor);
          return JSON.stringify({ ticket });
        } catch (err) {
          const json = serviceErrorToJson(err);
          if (json) return json;
          throw err;
        }
      }

      // ── link_alert ────────────────────────────────────────────────────────
      if (action === 'link_alert') {
        if (!input.ticketId) return JSON.stringify({ error: 'ticketId is required for link_alert action' });
        if (!input.alertId) return JSON.stringify({ error: 'alertId is required for link_alert action' });
        const found = await findTicketWithAccess(String(input.ticketId), auth);
        if (!found) return JSON.stringify({ error: 'Ticket not found' });
        const alert = await findAlertWithAccess(String(input.alertId), auth);
        if (!alert) return JSON.stringify({ error: 'Alert not found' });
        try {
          const link = await linkAlertToTicket(String(input.ticketId), String(input.alertId), actor);
          return JSON.stringify({ link });
        } catch (err) {
          const json = serviceErrorToJson(err);
          if (json) return json;
          throw err;
        }
      }

      // ── unlink_alert ──────────────────────────────────────────────────────
      if (action === 'unlink_alert') {
        if (!input.ticketId) return JSON.stringify({ error: 'ticketId is required for unlink_alert action' });
        if (!input.alertId) return JSON.stringify({ error: 'alertId is required for unlink_alert action' });
        const found = await findTicketWithAccess(String(input.ticketId), auth);
        if (!found) return JSON.stringify({ error: 'Ticket not found' });
        try {
          const result = await unlinkAlertFromTicket(String(input.ticketId), String(input.alertId), actor);
          return JSON.stringify({ unlinked: result });
        } catch (err) {
          const json = serviceErrorToJson(err);
          if (json) return json;
          throw err;
        }
      }

      // ── create_from_alert ─────────────────────────────────────────────────
      if (action === 'create_from_alert') {
        if (!input.alertId) return JSON.stringify({ error: 'alertId is required for create_from_alert action' });
        const alert = await findAlertWithAccess(String(input.alertId), auth);
        if (!alert) return JSON.stringify({ error: 'Alert not found' });
        const parsedOverrides = parseAlertOverrides(input.overrides);
        if ('error' in parsedOverrides) return JSON.stringify({ error: parsedOverrides.error });
        try {
          const ticket = await createTicketFromAlert(String(input.alertId), actor, parsedOverrides.value);
          return JSON.stringify({ ticket });
        } catch (err) {
          const json = serviceErrorToJson(err);
          if (json) return json;
          throw err;
        }
      }

      // ── edit_comment ──────────────────────────────────────────────────────
      if (action === 'edit_comment') {
        if (!input.commentId) return JSON.stringify({ error: 'commentId is required for edit_comment action' });
        if (!input.expectedTicketId) return JSON.stringify({ error: 'expectedTicketId is required for edit_comment action' });
        if (!input.content) return JSON.stringify({ error: 'content is required for edit_comment action' });
        const found = await findTicketWithAccess(String(input.expectedTicketId), auth);
        if (!found) return JSON.stringify({ error: 'Ticket not found' });
        const canManageAny = await canManageAnyTicketComment(auth);
        try {
          const comment = await editTicketComment(
            String(input.commentId),
            { content: String(input.content) },
            actor,
            { canManageAny, expectedTicketId: String(input.expectedTicketId) }
          );
          return JSON.stringify({ comment });
        } catch (err) {
          const json = serviceErrorToJson(err);
          if (json) return json;
          throw err;
        }
      }

      // ── delete_comment ────────────────────────────────────────────────────
      if (action === 'delete_comment') {
        if (!input.commentId) return JSON.stringify({ error: 'commentId is required for delete_comment action' });
        if (!input.expectedTicketId) return JSON.stringify({ error: 'expectedTicketId is required for delete_comment action' });
        const found = await findTicketWithAccess(String(input.expectedTicketId), auth);
        if (!found) return JSON.stringify({ error: 'Ticket not found' });
        const canManageAny = await canManageAnyTicketComment(auth);
        try {
          const deleted = await deleteTicketComment(
            String(input.commentId),
            actor,
            { canManageAny, expectedTicketId: String(input.expectedTicketId) }
          );
          return JSON.stringify({ deleted });
        } catch (err) {
          const json = serviceErrorToJson(err);
          if (json) return json;
          throw err;
        }
      }

      // ── move_org ──────────────────────────────────────────────────────────
      if (action === 'move_org') {
        if (!input.ticketId) return JSON.stringify({ error: 'ticketId is required for move_org action' });
        if (!input.targetOrgId) return JSON.stringify({ error: 'targetOrgId is required for move_org action' });
        const found = await findTicketWithAccess(String(input.ticketId), auth);
        if (!found) return JSON.stringify({ error: 'Ticket not found' });
        if (!auth.canAccessOrg(String(input.targetOrgId))) {
          return JSON.stringify({ error: 'Access to target organization denied' });
        }
        try {
          // P2-4 final review (C1, #4191): the scope_ticket_id tombstone AND
          // the ticket_drafts cleanup now live INSIDE moveTicketOrg's own
          // transaction (ticketService.ts) — the one path both this AI-tool
          // executor and the HTTP route (routes/tickets/moveOrg.ts, which
          // called moveTicketOrg directly and never ran the old tombstone
          // here) go through. The tombstone previously done here covered
          // neither ticket_drafts nor terminal-status intents; both were
          // fixed at the source instead of patched here.
          const ticket = await moveTicketOrg(String(input.ticketId), String(input.targetOrgId),
            auth.principal.kind === 'ai_agent'
              ? { kind: 'ai_agent', agentId: auth.principal.agentId, name: auth.user.name }
              : actor);
          return JSON.stringify({ ticket });
        } catch (err) {
          const json = serviceErrorToJson(err);
          if (json) return json;
          throw err;
        }
      }

      // ── link_device (P2-4, #4191) ────────────────────────────────────────
      if (action === 'link_device') {
        if (!input.ticketId) return JSON.stringify({ error: 'ticketId is required for link_device action' });
        const hostname = typeof input.hostname === 'string' ? input.hostname : undefined;
        const serial = typeof input.serial === 'string' ? input.serial : undefined;
        if (!hostname && !serial) {
          return JSON.stringify({ error: 'hostname or serial is required for link_device action' });
        }
        const found = await findTicketWithAccess(String(input.ticketId), auth);
        if (!found) return JSON.stringify({ error: 'Ticket not found' });

        // Resolve by exact hostname OR serial number, within the ticket's org,
        // never an ephemeral (Quick Support) device, never decommissioned
        // (devices carries no deleted_at — offboarding retires a device via
        // status='decommissioned' rather than a soft-delete column, and a
        // decommissioned device is not a sane link target). Zero or multiple
        // matches is a completed no-op, never an error — the agent's
        // proposal was ambiguous, not malformed.
        const identityConditions: SQL[] = [];
        if (hostname) identityConditions.push(eq(devices.hostname, hostname));
        if (serial) identityConditions.push(eq(deviceHardware.serialNumber, serial));
        const matches = await db
          .select({ id: devices.id })
          .from(devices)
          .leftJoin(deviceHardware, eq(deviceHardware.deviceId, devices.id))
          .where(and(
            eq(devices.orgId, found.orgId),
            eq(devices.isEphemeral, false),
            ne(devices.status, 'decommissioned'),
            or(...identityConditions)
          ))
          .limit(2);

        if (matches.length === 0) return JSON.stringify({ linked: false, reason: 'no_match' });
        if (matches.length > 1) return JSON.stringify({ linked: false, reason: 'multiple_matches' });
        if (found.deviceId !== null) return JSON.stringify({ linked: false, reason: 'already_linked' });

        const deviceId = matches[0]!.id;
        // Exact-device/site axes (#6086 finding 6): the identity match above is
        // org-only, so without this a device-bound run could link (and then
        // pivot through) a device outside its allowlist. Fails closed on an
        // unresolvable device; a no-op for unrestricted callers.
        if (await deviceIdSiteDenied(auth, deviceId)) {
          return JSON.stringify({ linked: false, reason: 'device_out_of_scope' });
        }
        // The `device_id IS NULL` guard in the WHERE (not just the read above)
        // is the actual CAS — closes the race between two concurrent
        // link_device calls both passing the "not yet linked" read.
        const updated = await db
          .update(tickets)
          .set({
            deviceId,
            fieldProvenance: sql`${tickets.fieldProvenance} || '{"deviceId":"ai_agent"}'::jsonb`,
            updatedAt: new Date()
          })
          .where(and(eq(tickets.id, String(input.ticketId)), eq(tickets.orgId, found.orgId), isNull(tickets.deviceId)))
          .returning({ id: tickets.id });

        if (updated.length === 0) {
          return JSON.stringify({ linked: false, reason: 'already_linked' });
        }
        await revalidateTicketAssignee(String(input.ticketId), {
          ...actor,
          principalKind: isAiAgentPrincipal(auth) ? 'ai_agent' : 'user',
        });
        return JSON.stringify({ linked: true, deviceId });
      }

      // ── draft (P2-4, #4191) ───────────────────────────────────────────────
      if (action === 'draft') {
        if (!input.ticketId) return JSON.stringify({ error: 'ticketId is required for draft action' });
        const kind = input.kind === 'reply' || input.kind === 'resolution_note' ? input.kind : undefined;
        if (!kind) return JSON.stringify({ error: 'kind (reply or resolution_note) is required for draft action' });
        if (!input.content) return JSON.stringify({ error: 'content is required for draft action' });
        const found = await findTicketWithAccess(String(input.ticketId), auth);
        if (!found) return JSON.stringify({ error: 'Ticket not found' });

        const ticketId = String(input.ticketId);
        const content = String(input.content);
        const runId = agentRunIdFrom(auth);

        // One transaction: SELECT ... FOR UPDATE the current active draft of
        // this kind (serializes concurrent writers on the SAME ticket+kind —
        // ticket_drafts_active_uq is a plain, non-deferrable partial unique on
        // (ticket_id, kind) WHERE state='active'), SUPERSEDE it first, THEN
        // insert the new active row — never the reverse. Superseding first is
        // load-bearing: inserting the new active row before flipping the old
        // one off 'active' collides with ticket_drafts_active_uq on every
        // normal supersession (there would be TWO 'active' rows for an
        // instant), not just the genuine concurrent race below. The new
        // row's id is minted client-side (crypto.randomUUID(), matching the
        // house pattern — see clientAiTools.ts/streamingSessionManager.ts)
        // so the UPDATE can stamp `supersededBy` before the row exists.
        const insertDraft = async (): Promise<{ id: string }> =>
          db.transaction(async (tx) => {
            const [existingActive] = await tx
              .select({ id: ticketDrafts.id })
              .from(ticketDrafts)
              .where(and(
                eq(ticketDrafts.ticketId, ticketId),
                eq(ticketDrafts.kind, kind),
                eq(ticketDrafts.state, 'active')
              ))
              .limit(1)
              .for('update');

            const newDraftId = crypto.randomUUID();

            if (existingActive) {
              await tx.update(ticketDrafts)
                .set({ state: 'superseded', supersededBy: newDraftId })
                .where(eq(ticketDrafts.id, existingActive.id));
            }

            const [inserted] = await tx.insert(ticketDrafts).values({
              id: newDraftId,
              orgId: found.orgId,
              ticketId,
              runId,
              content,
              kind
            }).returning({ id: ticketDrafts.id });
            if (!inserted) throw new TicketServiceError('Failed to store draft', 500);

            return inserted;
          });

        try {
          const draft = await insertDraft();
          return JSON.stringify({ draft });
        } catch (err) {
          // Two concurrent writers both read "no active row" under FOR UPDATE
          // serialization and both tried to insert — the partial unique index
          // (ticket_drafts_active_uq) catches the loser; retry once so it
          // supersedes the winner instead of erroring out.
          if (isUniqueViolation(err)) {
            const draft = await insertDraft();
            return JSON.stringify({ draft });
          }
          throw err;
        }
      }

      if (action === 'list_work_types' ||
          ((action === 'log_time_entry' || action === 'start_timer') && input.workType !== undefined)) {
        if (auth.scope !== 'partner' || !auth.partnerId) {
          return JSON.stringify({ error: 'Work types require partner scope' });
        }
      }

      if (action === 'list_work_types') {
        const rows = await listWorkTypes(auth.partnerId!, { includeInactive: false });
        return JSON.stringify({ workTypes: rows.map(({ id, name }) => ({ id, name })) });
      }

      // ── log_time_entry ────────────────────────────────────────────────────
      if (action === 'log_time_entry') {
        // #4177 (W04): an agent may PROPOSE a time entry (an action_intents
        // row, see services/aiTimeEntryProposal.ts) but never create one
        // inline — the row needs a real `users` owner, which only the release
        // path (executing as `decided_by_user_id`) can supply. Distinct code
        // from `agent_principal_unsupported_action` because the correct route
        // EXISTS; the agent's loop should relay "propose it", not "can't".
        if (agentRunIdFrom(auth)) {
          return JSON.stringify({ error: 'agent_principal_requires_intent_release', action });
        }
        // A released proposal arrives with the APPROVER's auth and their id
        // in the context bag (intentReleaseWorker.ts). Refuse rather than
        // trust if the two ever disagree — the entry's owner is the one
        // thing this branch must never get wrong.
        if (context?.approverRelease && context.approverRelease.approverUserId !== auth.user.id) {
          return JSON.stringify({ error: 'approver_auth_mismatch', action });
        }
        if (!input.startedAt) return JSON.stringify({ error: 'startedAt is required for log_time_entry action' });
        if (!input.endedAt) return JSON.stringify({ error: 'endedAt is required for log_time_entry action' });
        // Site-scope parity: if a ticketId is given, pre-check the ticket is in scope
        // (mirrors the #1261 pattern used by comment/assign/update_status above).
        if (input.ticketId) {
          const found = await findTicketWithAccess(String(input.ticketId), auth);
          if (!found) return JSON.stringify({ error: 'Ticket not found' });
        }
        try {
          const entry = await createTimeEntry(
            {
              workTypeId: await resolveWorkTypeId(
                typeof input.workType === 'string' ? input.workType : undefined,
                auth.partnerId!,
              ),
              ticketId: input.ticketId ? String(input.ticketId) : undefined,
              startedAt: new Date(String(input.startedAt)),
              endedAt: new Date(String(input.endedAt)),
              description: input.description ? String(input.description) : undefined,
              isBillable: typeof input.isBillable === 'boolean' ? input.isBillable : undefined,
              hourlyRate: typeof input.hourlyRate === 'number' ? input.hourlyRate : undefined
            },
            await timeEntryActorFrom(auth),
            // Provenance: a released AI proposal is `ai_suggested` (#4177) so
            // invoiceAssembly / time-saved reporting can tell it apart; a
            // human's own tool call stays the column default.
            { source: context?.approverRelease ? 'ai_suggested' : 'manual' }
          );
          return JSON.stringify({ timeEntry: entry, currencyCode: entryCurrency(entry) });
        } catch (err) {
          if (err instanceof TimeEntryServiceError) {
            return JSON.stringify({ error: err.message });
          }
          throw err;
        }
      }

      // ── start_timer ───────────────────────────────────────────────────────
      if (action === 'start_timer') {
        // Site-scope parity: if a ticketId is given, pre-check the ticket is in scope.
        if (input.ticketId) {
          const found = await findTicketWithAccess(String(input.ticketId), auth);
          if (!found) return JSON.stringify({ error: 'Ticket not found' });
        }
        try {
          const entry = await startTimer(
            {
              workTypeId: await resolveWorkTypeId(
                typeof input.workType === 'string' ? input.workType : undefined,
                auth.partnerId!,
              ),
              ticketId: input.ticketId ? String(input.ticketId) : undefined,
              description: input.description ? String(input.description) : undefined
            },
            await timeEntryActorFrom(auth)
          );
          return JSON.stringify({ timeEntry: entry, currencyCode: entryCurrency(entry) });
        } catch (err) {
          if (err instanceof TimeEntryServiceError) {
            return JSON.stringify({ error: err.message });
          }
          throw err;
        }
      }

      // ── stop_timer ────────────────────────────────────────────────────────
      if (action === 'stop_timer') {
        // Spec §3.7: work types are stamped at start; stopping does not take
        // the ticket lock needed for a work-type edit and its pricing changes.
        if (input.workType !== undefined) {
          return JSON.stringify({
            error: 'Work type is set at timer start. Stop without workType, then edit the time entry to change it.',
          });
        }
        try {
          const entry = await stopTimer(
            {
              description: input.description ? String(input.description) : undefined,
              isBillable: typeof input.isBillable === 'boolean' ? input.isBillable : undefined
            },
            await timeEntryActorFrom(auth)
          );
          return JSON.stringify({ timeEntry: entry, currencyCode: entryCurrency(entry) });
        } catch (err) {
          if (err instanceof TimeEntryServiceError) {
            return JSON.stringify({ error: err.message });
          }
          throw err;
        }
      }

      throw new Error(`Unknown action: ${action}`);
    }
  });
}
