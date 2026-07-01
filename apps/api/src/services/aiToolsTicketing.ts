/**
 * AI Ticketing Tools
 *
 * Provides the `manage_tickets` AI tool for searching, viewing, creating,
 * commenting on, assigning, and changing the status of support tickets.
 * All mutations delegate to ticketService — this file is a thin adapter.
 */

import { and, desc, eq, type SQL } from 'drizzle-orm';
import { db } from '../db';
import { alerts, tickets } from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import { deviceInSiteScope, ticketSiteScopeCondition } from '../routes/tickets/siteScope';
import type { AiTool, AiToolTier } from './aiTools';
import {
  createTicket,
  changeTicketStatus,
  assignTicket,
  addTicketComment,
  TicketServiceError,
  updateTicketFields,
  linkAlertToTicket,
  unlinkAlertFromTicket,
  createTicketFromAlert,
  editTicketComment,
  deleteTicketComment,
  moveTicketOrg,
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
import { getUserPermissions, hasPermission, PERMISSIONS } from './permissions';

type ParseResult<T> = { value: T } | { error: string };

function actorFrom(auth: AuthContext) {
  return { userId: auth.user.id, name: auth.user.name };
}

function serviceErrorToJson(err: unknown): string | null {
  if (err instanceof TicketServiceError) {
    return JSON.stringify({ error: err.message, code: err.code });
  }
  return null;
}

function timeEntryActorFrom(auth: AuthContext) {
  return {
    userId: auth.user.id,
    name: auth.user.name,
    partnerId: auth.partnerId,
    accessibleOrgIds: auth.accessibleOrgIds,
    // AI tools always operate on the calling user's own entries — never admin-manage others'.
    manageAll: false as const
  };
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
 * a device-bound ticket is resolved only when its device's site is in the
 * caller's allowlist (deviceInSiteScope); deviceless (org-level) tickets stay
 * accessible at org scope — matching getScopedTicketOr404 in the HTTP route.
 *
 * Returns the ticket row, or null when not found / out of the caller's scope.
 */
async function findTicketWithAccess(ticketId: string, auth: AuthContext) {
  const conditions: SQL[] = [eq(tickets.id, ticketId)];
  const orgCond = auth.orgCondition(tickets.orgId);
  if (orgCond) conditions.push(orgCond);
  const [ticket] = await db.select().from(tickets).where(and(...conditions)).limit(1);
  if (!ticket) return null;
  if (ticket.deviceId && !(await deviceInSiteScope(auth, ticket.deviceId))) {
    return null;
  }
  return ticket;
}

async function findAlertWithAccess(alertId: string, auth: AuthContext) {
  const conditions: SQL[] = [eq(alerts.id, alertId)];
  const orgCond = auth.orgCondition(alerts.orgId);
  if (orgCond) conditions.push(orgCond);
  const [alert] = await db.select().from(alerts).where(and(...conditions)).limit(1);
  if (!alert) return null;
  if (alert.deviceId && !(await deviceInSiteScope(auth, alert.deviceId))) {
    return null;
  }
  return alert;
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
    definition: {
      name: 'manage_tickets',
      description:
        'Search, view, create, comment on, assign, update fields, change status, link/unlink alerts, create from alerts, edit/delete comments, move tickets between orgs with approval, and log time against support tickets. ' +
        'Use action "list" to search, "get" for full detail, "create" to open a new ticket, ' +
        '"comment" to add a reply or internal note, "assign" to set the assignee, ' +
        '"update_status" to move the lifecycle (resolving requires resolutionNote), ' +
        '"log_time_entry" to record a completed time block (requires startedAt + endedAt), ' +
        '"start_timer" to start a running timer (auto-stops any existing timer), ' +
        '"stop_timer" to stop the currently running timer.',
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
              'log_time_entry',
              'start_timer',
              'stop_timer',
              'update_fields',
              'link_alert',
              'unlink_alert',
              'create_from_alert',
              'edit_comment',
              'delete_comment',
              'move_org'
            ],
            description: 'The action to perform'
          },
          ticketId: {
            type: 'string',
            description: 'Ticket UUID (required for get/comment/assign/update_status/update_fields/link_alert/unlink_alert/move_org)'
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
          hourlyRate: {
            type: 'number',
            description: 'Override hourly rate in currency units (log_time_entry; defaults from ticket category)'
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
          const ticket = await moveTicketOrg(String(input.ticketId), String(input.targetOrgId), actor);
          return JSON.stringify({ ticket });
        } catch (err) {
          const json = serviceErrorToJson(err);
          if (json) return json;
          throw err;
        }
      }

      // ── log_time_entry ────────────────────────────────────────────────────
      if (action === 'log_time_entry') {
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
              ticketId: input.ticketId ? String(input.ticketId) : undefined,
              startedAt: new Date(String(input.startedAt)),
              endedAt: new Date(String(input.endedAt)),
              description: input.description ? String(input.description) : undefined,
              isBillable: typeof input.isBillable === 'boolean' ? input.isBillable : undefined,
              hourlyRate: typeof input.hourlyRate === 'number' ? input.hourlyRate : undefined
            },
            timeEntryActorFrom(auth)
          );
          return JSON.stringify({ timeEntry: entry });
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
              ticketId: input.ticketId ? String(input.ticketId) : undefined,
              description: input.description ? String(input.description) : undefined
            },
            timeEntryActorFrom(auth)
          );
          return JSON.stringify({ timeEntry: entry });
        } catch (err) {
          if (err instanceof TimeEntryServiceError) {
            return JSON.stringify({ error: err.message });
          }
          throw err;
        }
      }

      // ── stop_timer ────────────────────────────────────────────────────────
      if (action === 'stop_timer') {
        try {
          const entry = await stopTimer(
            {
              description: input.description ? String(input.description) : undefined,
              isBillable: typeof input.isBillable === 'boolean' ? input.isBillable : undefined
            },
            timeEntryActorFrom(auth)
          );
          return JSON.stringify({ timeEntry: entry });
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
