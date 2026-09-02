import { coreRequest } from './api';
import type { TicketCommentType } from './ticketCommentTypes';
import type { TicketAttachmentMeta } from './ticketAttachmentContract';

/**
 * Ticket surface for mobile. `/api/v1/mobile/*` has no ticket routes, so the
 * phone calls the core endpoints (`apps/api/src/routes/tickets/tickets.ts`)
 * with the token it already holds.
 *
 * These interfaces describe the SUBSET of each response the app consumes, not
 * the full server payload — the list route also returns `source`, `categoryId`,
 * the SLA-pause fields and `deletedAt`, and the detail route returns whole
 * `ticket_comments` rows. Extra fields are ignored at runtime; add one here
 * when a screen starts using it.
 */

export type TicketStatus = 'new' | 'open' | 'pending' | 'on_hold' | 'resolved' | 'closed';
export type TicketPriority = 'low' | 'normal' | 'high' | 'urgent';

/** Statuses the API groups as open. Mirrors OPEN_STATUSES in tickets.ts. */
export const OPEN_TICKET_STATUSES: readonly TicketStatus[] = [
  'new',
  'open',
  'pending',
  'on_hold',
];

export interface TicketSummary {
  id: string;
  /** Display reference shown in the web queue (nullable varchar, not numeric). */
  internalNumber: string | null;
  subject: string;
  status: TicketStatus;
  priority: TicketPriority;
  /** `tickets.org_id` is NOT NULL in the schema, so this is never absent. */
  orgId: string;
  orgName: string | null;
  deviceId: string | null;
  deviceHostname: string | null;
  assignedTo: string | null;
  assigneeName: string | null;
  dueDate: string | null;
  slaBreachedAt: string | null;
  firstResponseAt: string | null;
  createdAt: string;
  updatedAt: string;
  statusName: string | null;
  statusColor: string | null;
}

// Defined in a leaf module so pure copy/logic modules can import the VALUE
// without dragging this file's `./api` (and therefore react-native) graph into
// the Vitest runner. Re-exported here so existing importers are unaffected.
export type { TicketCommentType } from './ticketCommentTypes';
export { SYSTEM_COMMENT_TYPES } from './ticketCommentTypes';

export interface TicketComment {
  id: string;
  content: string;
  isPublic: boolean;
  authorName: string | null;
  createdAt: string;
  /**
   * `ticket_comments` is an ACTIVITY STREAM, not just user comments — the
   * detail route returns status changes, assignments and time entries through
   * the same array (web's TicketFeed branches on this). NOT NULL in the schema
   * with a `comment` default; optional here only because older cached payloads
   * may predate the field.
   */
  commentType?: TicketCommentType;
  /**
   * The detail route blanks `content` for soft-deleted comments and sets this
   * flag instead of omitting the row, so a deleted comment arrives as an empty
   * string. Render the placeholder off this rather than off `content`.
   */
  deleted?: boolean;
  /**
   * Files posted with this comment (W11, #4337). Absent on activity entries and
   * on servers predating the attachments release; the API also returns `[]` for
   * a soft-deleted comment even though the rows still exist, so an empty array
   * is never proof that nothing was attached.
   */
  attachments?: TicketAttachmentMeta[];
}

export interface TicketDetail extends TicketSummary {
  description: string | null;
  comments: TicketComment[];
}

export interface TicketPage {
  tickets: TicketSummary[];
  total: number;
  page: number;
  limit: number;
}

interface ListResponse {
  data: TicketSummary[];
  pagination?: { page: number; limit: number; total: number };
}

export type TicketAssigneeFilter = 'me' | 'all';

export interface ListTicketsParams {
  /** Server-side grouping; omit to list every status. */
  statusGroup?: 'open' | 'closed';
  assignee?: TicketAssigneeFilter;
  page?: number;
  limit?: number;
}

const DEFAULT_LIMIT = 50;

/**
 * `assignee=all` is a client-side concept — the API treats any non-`me`,
 * non-`unassigned` value as a user id to filter by, so "all" must be sent as
 * no parameter at all rather than as the literal string.
 */
export function buildTicketListQuery(params: ListTicketsParams): string {
  const page = params.page ?? 1;
  const limit = params.limit ?? DEFAULT_LIMIT;
  const search = new URLSearchParams({ page: String(page), limit: String(limit) });
  if (params.statusGroup) search.set('statusGroup', params.statusGroup);
  if (params.assignee === 'me') search.set('assignee', 'me');
  return search.toString();
}

export async function getTickets(params: ListTicketsParams = {}): Promise<TicketPage> {
  const response = await coreRequest<ListResponse>(
    `/tickets?${buildTicketListQuery(params)}`
  );
  const tickets = Array.isArray(response.data) ? response.data : [];
  return {
    tickets,
    total: response.pagination?.total ?? tickets.length,
    page: response.pagination?.page ?? params.page ?? 1,
    limit: response.pagination?.limit ?? params.limit ?? DEFAULT_LIMIT,
  };
}

export async function getTicket(id: string): Promise<TicketDetail> {
  const response = await coreRequest<{ data: TicketDetail }>(`/tickets/${id}`);
  const ticket = response.data;
  return { ...ticket, comments: Array.isArray(ticket.comments) ? ticket.comments : [] };
}

/**
 * Post a comment, optionally claiming attachments uploaded beforehand.
 *
 * `attachmentIds` are ids from `uploadTicketAttachment` — pending rows the
 * server claims inside this comment's transaction. The field is OMITTED rather
 * than sent as `[]` when empty: the API defaults it, and sending an empty array
 * to a server predating the attachments release would be an unknown key.
 *
 * `content` may be empty when at least one attachment is present —
 * `addTicketCommentSchema` refines "text or at least one attachment", so a
 * photo-only comment is legal and the caller must not gate on text alone.
 */
export async function addTicketComment(
  id: string,
  content: string,
  isPublic: boolean,
  attachmentIds?: string[]
): Promise<TicketComment> {
  const body: { content: string; isPublic: boolean; attachmentIds?: string[] } = {
    content,
    isPublic,
  };
  if (attachmentIds && attachmentIds.length > 0) body.attachmentIds = attachmentIds;

  const response = await coreRequest<{ data: TicketComment }>(`/tickets/${id}/comments`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return response.data;
}

/**
 * The API rejects `status: 'resolved'` without a non-empty `resolutionNote`
 * (`changeTicketStatusSchema.superRefine`), so callers must collect one first.
 * Sending the field on other transitions is harmless but pointless, so it is
 * only included when resolving.
 *
 * Returns the updated ticket the endpoint responds with, so callers apply the
 * server's authoritative status (custom-status mapping can make it differ from
 * the requested one) rather than echoing their own request back into state.
 *
 * Note what it does NOT carry: this route returns the raw `tickets` row, so
 * `statusName`/`statusColor` are absent — those come from a join present only
 * on the list and detail GET routes. Callers needing the display label must
 * refetch.
 */
export async function changeTicketStatus(
  id: string,
  status: TicketStatus,
  resolutionNote?: string
): Promise<TicketSummary> {
  const body: { status: TicketStatus; resolutionNote?: string } = { status };
  if (status === 'resolved' && resolutionNote) body.resolutionNote = resolutionNote;
  const response = await coreRequest<{ data: TicketSummary }>(`/tickets/${id}/status`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return response.data;
}

export function statusRequiresResolutionNote(status: TicketStatus): boolean {
  return status === 'resolved';
}

/**
 * Mirrors TICKET_STATUS_TRANSITIONS in `apps/api/src/services/ticketService.ts`.
 * The API throws 409 INVALID_TRANSITION for anything not listed, so offering an
 * unreachable target in the UI produces a guaranteed error rather than a
 * refused action. Resolved reopens only to open/closed; closed only to open.
 */
export const TICKET_STATUS_TRANSITIONS: Record<TicketStatus, readonly TicketStatus[]> = {
  new: ['open', 'pending', 'on_hold', 'resolved', 'closed'],
  open: ['pending', 'on_hold', 'resolved', 'closed'],
  pending: ['open', 'on_hold', 'resolved', 'closed'],
  on_hold: ['open', 'pending', 'resolved', 'closed'],
  resolved: ['open', 'closed'],
  closed: ['open'],
};

export function canTransition(from: TicketStatus, to: TicketStatus): boolean {
  return TICKET_STATUS_TRANSITIONS[from]?.includes(to) ?? false;
}

/** The quick-action targets to show for a ticket, filtered to legal moves. */
export function allowedQuickStatuses(
  from: TicketStatus,
  candidates: readonly TicketStatus[]
): TicketStatus[] {
  return candidates.filter((s) => s !== from && canTransition(from, s));
}
