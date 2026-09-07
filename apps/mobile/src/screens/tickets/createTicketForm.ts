// Type-only import: erased at runtime, so it does not pull services/tickets'
// react-native graph into this node-testable module (same as ticketCopy.ts).
import type { TicketPriority } from '../../services/tickets';

// Leaf module: imports no react-native, so it stays node-testable (same rule
// as ticketCopy.ts and commentMode.ts).

/** Every API priority, in escalation order, for the chip row. */
export const TICKET_PRIORITY_OPTIONS: readonly TicketPriority[] = ['low', 'normal', 'high', 'urgent'];

/** Matches the service-side fallback when priority is absent. */
export const DEFAULT_TICKET_PRIORITY: TicketPriority = 'normal';

/** The API's subject limit (`createTicketSchema`: max 255). */
export const SUBJECT_MAX_LENGTH = 255;

export interface OrgOption {
  id: string;
  name: string;
}

export interface CreateTicketBody {
  orgId: string;
  subject: string;
  description?: string;
  priority: TicketPriority;
  assigneeId?: string;
}

export type BuildResult =
  | { ok: true; body: CreateTicketBody }
  | { ok: false; reason: 'org' | 'subject' };

/**
 * The exact JSON the screen POSTs to `/tickets`, or the first reason it must
 * not. Priority is always sent: the server falls back to 'normal' when absent,
 * but the chip row shows a selection, so what is on screen is what is sent.
 * `assigneeId` is omitted (not sent as null) for "Unassigned" — the server
 * only ever sees the field when a real user id was picked.
 */
export function buildCreateTicketBody(input: {
  orgId: string | null;
  subject: string;
  description: string;
  priority: TicketPriority;
  assigneeId?: string | null;
}): BuildResult {
  if (!input.orgId) return { ok: false, reason: 'org' };
  const subject = input.subject.trim();
  if (!subject || subject.length > SUBJECT_MAX_LENGTH) return { ok: false, reason: 'subject' };
  const description = input.description.trim();
  const body: CreateTicketBody = { orgId: input.orgId, subject, priority: input.priority };
  if (description) body.description = description;
  if (input.assigneeId) body.assigneeId = input.assigneeId;
  return { ok: true, body };
}

export function canSubmitTicket(input: { orgId: string | null; subject: string; busy: boolean }): boolean {
  if (input.busy) return false;
  return buildCreateTicketBody({ ...input, description: '', priority: DEFAULT_TICKET_PRIORITY }).ok;
}

/**
 * Which organization to start on: the signed-in user's own org when it is in
 * the list (org-scoped technicians only ever see one), else the only org when
 * there is exactly one, else nothing — a partner user with several customers
 * has to choose, and a silent default would file tickets against the wrong
 * customer.
 */
export function preselectOrg(orgs: readonly OrgOption[], userOrgId: string | undefined): string | null {
  if (userOrgId && orgs.some((o) => o.id === userOrgId)) return userOrgId;
  if (orgs.length === 1) return orgs[0].id;
  return null;
}

/** A row from `GET /users`, trimmed to what the assignee picker needs. */
export interface AssigneeUser {
  id: string;
  name: string | null;
  email: string;
}

export interface AssigneeOption {
  /** `null` is the "Unassigned" row — sent as an omitted field, not literal null. */
  id: string | null;
  label: string;
}

/** Display name for a user row: the name, or the email when it is blank. */
export function assigneeDisplayName(user: { name: string | null | undefined; email: string }): string {
  const name = user.name?.trim();
  return name ? name : user.email;
}

/** #5188: the signed-in tech is the default assignee on a new ticket. */
export function defaultAssigneeId(me: { id: string } | null | undefined): string | null {
  return me?.id ?? null;
}

/**
 * Whether a failed `GET /users` is the EXPECTED case for this screen — a tech
 * whose role lacks `users:read` gets a 403 every time they open New ticket.
 * That is a permission model working as designed, not a defect, so it must
 * not become a Sentry event per screen open (same precedent as
 * `DEVICE_BLOCKED_CODE` in `lib/errorReporting.ts`). Anything else — 5xx,
 * network failure, a non-ApiError throw — is still worth reporting.
 */
export function isExpectedAssigneeLoadFailure(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  return (err as { statusCode?: unknown }).statusCode === 403;
}

/**
 * Assignee sheet contents: "Unassigned" first, the signed-in tech pinned
 * second labeled "(you)", then the rest of `staff` sorted by display name.
 * `staff` may be empty — the `GET /users` fetch failed (403 for a tech without
 * `users:read`, network error, …) — in which case the sheet still offers
 * Unassigned + you rather than erroring.
 */
export function assigneeOptions(
  staff: readonly AssigneeUser[],
  me: AssigneeUser | null | undefined
): AssigneeOption[] {
  const options: AssigneeOption[] = [{ id: null, label: 'Unassigned' }];
  if (me) options.push({ id: me.id, label: `${assigneeDisplayName(me)} (you)` });

  const seen = new Set<string>(me ? [me.id] : []);
  const rest: AssigneeOption[] = [];
  for (const user of staff) {
    if (!user.id || seen.has(user.id)) continue;
    seen.add(user.id);
    rest.push({ id: user.id, label: assigneeDisplayName(user) });
  }
  rest.sort((a, b) => a.label.localeCompare(b.label));

  return [...options, ...rest];
}
