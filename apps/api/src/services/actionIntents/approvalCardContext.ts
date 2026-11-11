/**
 * #11674 — what the chat approval card names, beyond the guardrail headline.
 *
 * `buildApprovalDescription` (aiGuardrails.ts) builds its headline from tool
 * input alone, so a ticket reads `ticket #2aad0601...` and a device
 * `on device 8f14580d...`. The intent service already swaps a device NAME into
 * the label it stores for the queue and the push (approvalDeviceName.ts,
 * #5363); the chat `approval_required` event carried the raw stub. This module
 * gives the chat card the same naming for devices and adds it for tickets:
 *
 *  - `resolveApprovalTicketContext` reads the ticket's number, subject and the
 *    requester a public reply emails, so the card can say all three above
 *    Approve. Same two load-bearing properties as approvalDeviceName.ts:
 *    **org-pinned** (the id comes from tool ARGUMENTS; a foreign id resolves to
 *    nothing, so the card is never a cross-tenant oracle) and **never fatal**
 *    (a failed read degrades to the stub and is reported to Sentry).
 *  - `nameApprovalCardTargets` swaps the resolved number and name into the
 *    headline, only where the stub is THIS call's id.
 *
 * The ticket's subject never goes into the headline: the headline also feeds
 * the stored reason, the push and audit, which carry no ticket content
 * (aiGuardrails.ts `manage_tickets`). The subject travels as structured
 * `ticketContext` and is rendered in the card body only.
 */

import { and, eq, isNull, type SQL } from 'drizzle-orm';
import type { AiApprovalTicketContext } from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { tickets } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { deviceInSiteScope } from '../../routes/tickets/siteScope';
import { captureException } from '../sentry';

/** The slice of the call's auth the read is cut to: the same reach `findTicketWithAccess` (aiToolsTicketing.ts) applies. */
export type ApprovalTicketReach = Pick<AuthContext, 'orgCondition' | 'allowedSiteIds' | 'allowedDeviceIds'>;

/** Shape-only UUID guard, as in approvalDeviceName.ts: `tickets.id` is a uuid, so junk would raise 22P02. */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The ticket THIS call acts on: `manage_tickets`' own `ticketId`, the argument every `ticket #<id>...` stub is built from. */
export function argumentTicketId(toolName: string, input: Record<string, unknown>): string | null {
  if (toolName !== 'manage_tickets') return null;
  const raw = input.ticketId;
  return typeof raw === 'string' && UUID_SHAPE.test(raw) ? raw : null;
}

/**
 * The ticket's number, subject and requester, or `null` when it cannot be
 * resolved. Opens its own system-scoped context outside any ambient one, as
 * approvalDeviceName.ts does. System scope is safe only because the read is
 * cut back down twice: to the intent's `orgId`, and to the CALLER's reach —
 * the same predicate the tool's own `findTicketWithAccess` applies (not
 * deleted, in the caller's org reach, its device in the caller's site/device
 * scope). A ticket the caller could not read through the tool shows nothing
 * here either.
 */
export async function resolveApprovalTicketContext(
  ticketId: string,
  orgId: string,
  reach: ApprovalTicketReach,
): Promise<AiApprovalTicketContext | null> {
  try {
    const row = await runOutsideDbContext(() =>
      withSystemDbAccessContext(async () => {
        const conditions: SQL[] = [eq(tickets.id, ticketId), eq(tickets.orgId, orgId), isNull(tickets.deletedAt)];
        const reachCondition = reach.orgCondition(tickets.orgId);
        if (reachCondition) conditions.push(reachCondition);
        const [ticket] = await db
          .select({
            ticketNumber: tickets.ticketNumber,
            subject: tickets.subject,
            submitterName: tickets.submitterName,
            submitterEmail: tickets.submitterEmail,
            deviceId: tickets.deviceId,
          })
          .from(tickets)
          .where(and(...conditions))
          .limit(1);
        if (!ticket) return null;
        if (ticket.deviceId && !(await deviceInSiteScope(reach, ticket.deviceId))) return null;
        return ticket;
      }, 'actionIntents.approvalCardTicket'),
    );
    if (!row) return null;
    return {
      ticketNumber: row.ticketNumber,
      subject: row.subject,
      ...(row.submitterName ? { requesterName: row.submitterName } : {}),
      ...(row.submitterEmail ? { requesterEmail: row.submitterEmail } : {}),
    };
  } catch (err) {
    // Reported, not swallowed: the only symptom is a card that names the
    // ticket by a UUID fragment again and loses its recipient line.
    captureException(err instanceof Error ? err : new Error(String(err)));
    console.error(`[actionIntents] Failed to resolve the approval ticket context for ${ticketId}:`, err);
    return null;
  }
}

export interface ApprovalCardTargets {
  deviceId?: string | null;
  deviceName?: string | null;
  ticketId?: string | null;
  ticketNumber?: string | null;
}

/**
 * Swap the resolved device name and ticket number into a guardrail headline.
 * Only the stub built from THIS call's id is replaced (matched on its 8-char
 * prefix, as `hasDeviceIdStub` does), so a headline naming some other ticket
 * or device — a merge target, say — keeps its stub rather than being mislabelled.
 */
export function nameApprovalCardTargets(description: string, targets: ApprovalCardTargets): string {
  let text = description;
  const deviceName = targets.deviceName?.trim();
  if (deviceName && targets.deviceId && UUID_SHAPE.test(targets.deviceId)) {
    const prefix = targets.deviceId.slice(0, 8);
    text = text.replace(new RegExp(`\\b(on|from) device ${prefix}\\.\\.\\.`, 'gi'), (_m, prep: string) => `${prep} ${deviceName}`);
  }
  const ticketNumber = targets.ticketNumber?.trim();
  if (ticketNumber && targets.ticketId && UUID_SHAPE.test(targets.ticketId)) {
    const prefix = targets.ticketId.slice(0, 8);
    text = text.replace(new RegExp(`\\bticket #${prefix}\\.\\.\\.`, 'gi'), () => `ticket ${ticketNumber}`);
  }
  return text;
}
