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
  /**
   * #5367: the requester CONTACT (`tickets.requester_contact_id`). Omitted —
   * never sent as null — for "No contact", matching how `assigneeId` handles
   * "Unassigned": the server only ever sees the field when a real id was picked.
   */
  requesterContactId?: string;
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
  requesterContactId?: string | null;
}): BuildResult {
  if (!input.orgId) return { ok: false, reason: 'org' };
  const subject = input.subject.trim();
  if (!subject || subject.length > SUBJECT_MAX_LENGTH) return { ok: false, reason: 'subject' };
  const description = input.description.trim();
  const body: CreateTicketBody = { orgId: input.orgId, subject, priority: input.priority };
  if (description) body.description = description;
  if (input.assigneeId) body.assigneeId = input.assigneeId;
  if (input.requesterContactId) body.requesterContactId = input.requesterContactId;
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
  return isForbidden(err);
}

/** A refusal by the permission model, as opposed to a failure worth reporting. */
function isForbidden(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  return (err as { statusCode?: unknown }).statusCode === 403;
}

/**
 * #5367: same rule for the contacts fetch. `GET /orgs/organizations/:id/contacts`
 * is gated on `organizations:read`, which plenty of technician roles do not
 * carry — for them the CONTACT row is simply not offered, which is the
 * permission model working, not a defect to report.
 */
export function isExpectedContactLoadFailure(err: unknown): boolean {
  return isForbidden(err);
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

// ── Requester contact (#5367) ────────────────────────────────────────────────

/** A row from `GET /orgs/organizations/:id/contacts`, trimmed to what the picker needs. */
export interface OrgContactOption {
  id: string;
  name: string | null;
  email: string | null;
  isPrimary?: boolean;
}

export interface ContactOption {
  /** `null` is the "No contact" row — sent as an omitted field, not literal null. */
  id: string | null;
  label: string;
}

/** The default, and the way back to it once a contact has been picked. */
export const NO_CONTACT_LABEL = 'No contact';

/**
 * How a contact reads in the picker: `name · email`, or whichever one it has.
 * A contact row is only required to carry ONE identifier (the API's
 * `no-identifier` rule), so both halves are individually optional.
 */
export function contactDisplayLabel(contact: Pick<OrgContactOption, 'name' | 'email'>): string {
  const name = contact.name?.trim();
  const email = contact.email?.trim();
  if (name && email) return `${name} · ${email}`;
  return name || email || 'Unnamed contact';
}

/**
 * Picker contents: "No contact" first (it is both the default and the only way
 * to clear a pick, so it survives every search), then the org's primary contact
 * ahead of everyone else — on most customer sites that is the person a ticket
 * is for — then the rest by display label.
 *
 * `search` filters client-side over name AND email. The list is one page of at
 * most 100 contacts, so this is a filter over what was fetched, not a query:
 * an org with more contacts than that needs server-side search (follow-up).
 */
export function contactOptions(
  contacts: readonly OrgContactOption[],
  search?: string
): ContactOption[] {
  const needle = search?.trim().toLowerCase() ?? '';
  const matching = needle
    ? contacts.filter(
        (c) =>
          (c.name ?? '').toLowerCase().includes(needle) || (c.email ?? '').toLowerCase().includes(needle)
      )
    : [...contacts];

  const ranked = matching
    .map((c) => ({ id: c.id, label: contactDisplayLabel(c), primary: c.isPrimary === true }))
    .sort((a, b) => (a.primary === b.primary ? a.label.localeCompare(b.label) : a.primary ? -1 : 1));

  return [
    { id: null, label: NO_CONTACT_LABEL },
    ...ranked.map(({ id, label }) => ({ id, label })),
  ];
}

/**
 * The contact selection that survives an organization change: none, unless the
 * organization did not actually change. Contacts are org-scoped, so carrying a
 * pick across would POST a `requesterContactId` from the previous customer —
 * which the API rejects (400 `REQUESTER_CONTACT_WRONG_ORG`), and which would
 * name the wrong customer's person if it ever did not.
 */
export function contactSelectionForOrg(
  current: { orgId: string | null; contactId: string | null },
  nextOrgId: string | null
): string | null {
  return current.orgId === nextOrgId ? current.contactId : null;
}
