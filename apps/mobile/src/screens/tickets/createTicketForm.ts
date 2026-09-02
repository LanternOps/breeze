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
}

export type BuildResult =
  | { ok: true; body: CreateTicketBody }
  | { ok: false; reason: 'org' | 'subject' };

/**
 * The exact JSON the screen POSTs to `/tickets`, or the first reason it must
 * not. Priority is always sent: the server falls back to 'normal' when absent,
 * but the chip row shows a selection, so what is on screen is what is sent.
 */
export function buildCreateTicketBody(input: {
  orgId: string | null;
  subject: string;
  description: string;
  priority: TicketPriority;
}): BuildResult {
  if (!input.orgId) return { ok: false, reason: 'org' };
  const subject = input.subject.trim();
  if (!subject || subject.length > SUBJECT_MAX_LENGTH) return { ok: false, reason: 'subject' };
  const description = input.description.trim();
  const body: CreateTicketBody = { orgId: input.orgId, subject, priority: input.priority };
  if (description) body.description = description;
  return { ok: true, body };
}

export function canSubmitTicket(input: { orgId: string | null; subject: string; busy: boolean }): boolean {
  if (input.busy) return false;
  return buildCreateTicketBody({ ...input, description: '', priority: DEFAULT_TICKET_PRIORITY }).ok;
}

/**
 * Which organisation to start on: the signed-in user's own org when it is in
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
