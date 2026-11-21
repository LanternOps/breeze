/**
 * #11674 — the ticket NUMBER for the stored approval label.
 *
 * The guardrail headline names a ticket by an id stub (`ticket #2aad0601...`,
 * aiGuardrails.ts `manage_tickets`). The chat card swaps in the number
 * (approvalCardContext.ts); the label the intent service STORES, which the
 * /approvals queue, the mobile push and audit read, kept the stub. This module
 * does for that label what approvalDeviceName.ts does for the device name.
 *
 * It reads the number and nothing else. The stored label carries no ticket
 * content: no subject, no requester, no message text.
 *
 * Same two load-bearing properties as approvalDeviceName.ts:
 *  - **Org-pinned.** The id comes from tool ARGUMENTS. Pinning the read to the
 *    intent's `orgId` means a foreign or nonexistent id resolves to nothing and
 *    the stub survives.
 *  - **Never fatal.** A failed read degrades to the stub and is reported to
 *    Sentry; it never fails the approval.
 *
 * It is not cut to the caller's reach (unlike `resolveApprovalTicketContext`):
 * the stored label is read by the intent's approvers, not only by the caller,
 * and a number is an identifier, not content, the same exposure the device name
 * already has.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { tickets } from '../../db/schema/portal';
import { captureException } from '../sentry';

/** Shape-only UUID guard, as in approvalDeviceName.ts: `tickets.id` is a uuid, so junk would raise 22P02. */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `manage_tickets` actions whose handler acts on `expectedTicketId` and never reads `ticketId` (aiToolsTicketing.ts). */
const COMMENT_REWRITE_ACTIONS = new Set<unknown>(['edit_comment', 'delete_comment']);

/**
 * The ticket THIS call acts on. For most `manage_tickets` actions that is
 * `ticketId`, the argument every `ticket #<id>...` stub is built from. A
 * comment edit or delete acts on `expectedTicketId` instead, so that is the one
 * named: a `ticketId` sent alongside it is ignored by the handler and must not
 * put a different ticket on the card (same mapping as intentRowTarget.ts).
 */
export function argumentTicketId(toolName: string, input: Record<string, unknown>): string | null {
  if (toolName !== 'manage_tickets') return null;
  const raw = COMMENT_REWRITE_ACTIONS.has(input.action) ? input.expectedTicketId : input.ticketId;
  return typeof raw === 'string' && UUID_SHAPE.test(raw) ? raw : null;
}

/**
 * The number technicians see (`internal_number`, T-2026-0001), falling back to
 * the portal reference (`ticket_number`) for a ticket with none, or `null` when
 * it cannot be resolved. Opens its own system-scoped context outside any
 * ambient one, for the reason given in approvalDeviceName.ts; safe only because
 * of the `orgId` pin.
 */
export async function resolveApprovalTicketNumber(ticketId: string, orgId: string): Promise<string | null> {
  try {
    return await runOutsideDbContext(() =>
      withSystemDbAccessContext(async () => {
        const [ticket] = await db
          .select({ ticketNumber: tickets.ticketNumber, internalNumber: tickets.internalNumber })
          .from(tickets)
          .where(and(eq(tickets.id, ticketId), eq(tickets.orgId, orgId), isNull(tickets.deletedAt)))
          .limit(1);
        return ticket ? (ticket.internalNumber ?? ticket.ticketNumber) : null;
      }, 'actionIntents.approvalTicketNumber'),
    );
  } catch (err) {
    // Reported, not swallowed: the only symptom is a queue row and a push that
    // name the ticket by a UUID fragment again.
    captureException(err instanceof Error ? err : new Error(String(err)));
    console.error(`[actionIntents] Failed to resolve the approval ticket number for ${ticketId}:`, err);
    return null;
  }
}
