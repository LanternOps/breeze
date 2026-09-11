/**
 * Ticket creation for planned work (#5573 W02): deliverable occurrences and
 * key-date reminders. Both are opened by the unattended daily sweep, so the
 * one thing this adds over createTicket is that a stale reference can never
 * stall the sweep forever.
 *
 * createTicket validates the assignee and category BEFORE any write (they are
 * checked ahead of ticket-number allocation), so a refusal leaves the caller's
 * transaction usable: drop the refused reference, loudly, and try again. An
 * owner who left the partner, was deactivated or lost access to the org would
 * otherwise make every daily run throw the same error, and a deleted category
 * likewise — the MSP would just see the work silently never appear.
 *
 * Service Management `off` is not an error for planned work: the caller still
 * records the occurrence / reminder and the technician fulfils it by hand.
 * Every other failure is rethrown so the caller's transaction rolls back and
 * the next run retries.
 */
import { createTicket, type TicketWorkKind } from './ticketService';

export type PlannedWorkTicketResult =
  | { kind: 'created'; ticketId: string }
  | { kind: 'service_management_off' };

export interface PlannedWorkTicketInput {
  orgId: string;
  workKind: Exclude<TicketWorkKind, 'support'>;
  subject: string;
  description?: string;
  dueDate: Date;
  assigneeId: string | null;
  categoryId: string | null;
}

const ASSIGNEE_REFUSALS: ReadonlySet<string> = new Set(['ASSIGNEE_NOT_FOUND', 'ASSIGNEE_WRONG_PARTNER', 'ASSIGNEE_NOT_ELIGIBLE']);
const CATEGORY_REFUSALS: ReadonlySet<string> = new Set(['CATEGORY_NOT_FOUND', 'CATEGORY_WRONG_PARTNER']);

function errorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

export async function createPlannedWorkTicket(
  input: PlannedWorkTicketInput,
  actor: { userId: string; name: string },
  logContext: Record<string, string>,
): Promise<PlannedWorkTicketResult> {
  let assigneeId = input.assigneeId;
  let categoryId = input.categoryId;
  const context = Object.entries(logContext).map(([k, v]) => `${k}=${v}`);

  // Bounded: each retry drops one reference, and there are only two.
  for (;;) {
    try {
      const ticket = await createTicket({
        orgId: input.orgId, source: 'api', workKind: input.workKind,
        subject: input.subject, description: input.description,
        dueDate: input.dueDate,
        assigneeId: assigneeId ?? undefined,
        categoryId: categoryId ?? undefined,
      }, actor);
      return { kind: 'created', ticketId: ticket.id };
    } catch (err) {
      const code = errorCode(err);
      if (code === 'service_management_off') return { kind: 'service_management_off' };
      if (assigneeId && code && ASSIGNEE_REFUSALS.has(code)) {
        console.warn('[plannedWork] dropping an assignee the ticket service refused', ...context, `userId=${assigneeId}`, `code=${code}`);
        assigneeId = null;
        continue;
      }
      if (categoryId && code && CATEGORY_REFUSALS.has(code)) {
        console.warn('[plannedWork] dropping a ticket category the ticket service refused', ...context, `categoryId=${categoryId}`, `code=${code}`);
        categoryId = null;
        continue;
      }
      throw err;
    }
  }
}
