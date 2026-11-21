/**
 * #11674 — which ticket an approval names, and the one read that may name it.
 *
 * The guardrail headline names a ticket by an id stub (`ticket #2aad0601...`,
 * aiGuardrails.ts `manage_tickets`). Two surfaces swap in the ticket number:
 * the chat card (approvalCardContext.ts) and the label the intent service
 * STORES, which the /approvals queue, the mobile push and audit read, and which
 * the filing caller can read back from their own approval row.
 *
 * Both go through `readApprovalTicketInReach` here, so they cannot drift on
 * which tickets they may name:
 *  - **Pinned to the intent's org** and to non-deleted tickets.
 *  - **Cut to the caller's reach**: the caller's org condition, and for a
 *    device-bound ticket, the caller's site/device scope (`deviceInSiteScope`).
 *    That is the predicate the tool's own `findTicketWithAccess`
 *    (aiToolsTicketing.ts) applies. A ticket the caller could not read through
 *    the tool resolves to nothing, and the stub stays.
 *  - **No reach, no read.** A principal without an org condition gets the stub.
 *    The read never falls back to an org-only lookup.
 *
 * The stored label gets the NUMBER only: `resolveApprovalTicketNumber` selects
 * the number columns and the device id it needs for the site check, never the
 * subject, the requester or any message text. A failed read is never fatal: it
 * degrades to the stub and is reported to Sentry.
 */

import { and, eq, isNull, type SQL } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { tickets } from '../../db/schema/portal';
import type { AuthContext } from '../../middleware/auth';
import { captureException } from '../sentry';

/** The slice of the filing caller's auth the read is cut to. */
export type ApprovalTicketReach = Pick<AuthContext, 'orgCondition' | 'allowedSiteIds' | 'allowedDeviceIds'>;

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
 * Read one ticket for an approval surface, or `null` when it is outside the
 * caller's reach (see the module comment). `select` runs the caller's own
 * projection against the WHERE clause built here; the projection must include
 * `deviceId` for the site check.
 *
 * Opens its own system-scoped context outside any ambient one, as
 * approvalDeviceName.ts does. Errors propagate: each caller reports them and
 * degrades to the stub.
 */
export async function readApprovalTicketInReach<T extends { deviceId: string | null }>(
  ticketId: string,
  orgId: string,
  reach: ApprovalTicketReach,
  contextLabel: string,
  select: (where: SQL) => PromiseLike<T[]>,
): Promise<T | null> {
  if (typeof reach?.orgCondition !== 'function') return null;
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const conditions: SQL[] = [eq(tickets.id, ticketId), eq(tickets.orgId, orgId), isNull(tickets.deletedAt)];
      const reachCondition = reach.orgCondition(tickets.orgId);
      if (reachCondition) conditions.push(reachCondition);
      const [ticket] = await select(and(...conditions) as SQL);
      if (!ticket) return null;
      if (ticket.deviceId) {
        // Loaded here rather than at the top: siteScope.ts imports the full
        // schema index, and the intent service must not pull that in just to
        // build a label. Only a device-bound ticket needs it.
        const { deviceInSiteScope } = await import('../../routes/tickets/siteScope');
        if (!(await deviceInSiteScope(reach, ticket.deviceId))) return null;
      }
      return ticket;
    }, contextLabel),
  );
}

/**
 * The number technicians see (`internal_number`, T-2026-0001), falling back to
 * the portal reference (`ticket_number`) for a ticket with none, or `null` when
 * the ticket is outside the caller's reach or cannot be read.
 */
export async function resolveApprovalTicketNumber(
  ticketId: string,
  orgId: string,
  reach: ApprovalTicketReach,
): Promise<string | null> {
  try {
    const ticket = await readApprovalTicketInReach(ticketId, orgId, reach, 'actionIntents.approvalTicketNumber', (where) =>
      db
        .select({ ticketNumber: tickets.ticketNumber, internalNumber: tickets.internalNumber, deviceId: tickets.deviceId })
        .from(tickets)
        .where(where)
        .limit(1),
    );
    return ticket ? (ticket.internalNumber ?? ticket.ticketNumber) : null;
  } catch (err) {
    // Reported, not swallowed: the only symptom is a queue row and a push that
    // name the ticket by a UUID fragment again.
    captureException(err instanceof Error ? err : new Error(String(err)));
    console.error(`[actionIntents] Failed to resolve the approval ticket number for ${ticketId}:`, err);
    return null;
  }
}
