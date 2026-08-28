/**
 * Durable ticket-helpdesk admission subscriber (wave 6 PR 3, #3828 —
 * docs/superpowers/plans/ai-mcp/2026-08-28-ai-agents-wave6-3-ticket-shadow.md
 * Task 3).
 *
 * Registered on the durable `eventSubscriberRegistry` under id
 * `ai-agent-ticket-helpdesk` (`eventSubscribers.ts`), subscribed to
 * `ticket.created` ONLY (v1 scope — `ticket.commented`/`ticket.status_changed`
 * are published on the bus by the outbox publisher for future context/
 * admission use, but this subscriber does not read them yet; see the plan's
 * deferred-items list).
 *
 * Admission itself is delegated entirely to `createAndEnqueueAgentRun`
 * (runService.ts) — kill switch, circuit breaker, dedupe, concurrency/rate/
 * budget caps, and the forced `modeAtStart: 'shadow'` for `triggerKind:
 * 'ticket'` all live there. This module's own job is narrow:
 *
 *  1. Extract the triggering ticket id from the id-only event payload.
 *  2. Origin-based loop guard (design authority: never `source`-string
 *     matching — see the migration header and `ticket_comments.origin_
 *     principal_kind`/`agent_run_id`, Task 1). No agent write path into
 *     `ticket_comments` exists yet in this PR (the autonomous-note lane is
 *     deferred, and shadow-mode tool gating denies `manage_tickets`
 *     mutations for ticket runs outright — see runLoop.test.ts's ticket-
 *     shadow contract test), so this check never actually fires against
 *     production data today. It is real, load-bearing infrastructure rather
 *     than dead code: it is the single place a FUTURE `ticket.commented`-
 *     driven admission (also deferred) or an autonomous-note write would be
 *     required to route through, and it is exercised directly by this
 *     file's own tests against a synthesized agent-originated comment row.
 *  3. Call `createAndEnqueueAgentRun` with `kind: 'helpdesk'`,
 *     `triggerKind: 'ticket'`, `deviceId: null` (tickets have no device
 *     axis in v1), and a dedupe key stable across redelivery of the same
 *     `ticket.created` event.
 */
import { and, eq, isNotNull, ne, or } from 'drizzle-orm';
import * as dbModule from '../../db';
import { ticketComments } from '../../db/schema';
import type { BreezeEvent } from '../eventBus';
import { createAndEnqueueAgentRun } from './runService';

// #4085-style fix, same as dnsThreatAlerts.ts / policyAlertBridge.ts:
// publish() (eventBus.ts) invokes durable-registry handlers via
// runOutsideDbContext, i.e. ambient scope 'none' — under forced RLS that is
// a 42501 the moment this handler's `db.select` runs without an explicit
// access context. `createAndEnqueueAgentRun` guards its own DB access
// internally regardless of ambient context, so wrapping the WHOLE handler
// here (rather than just the origin-guard probe) is a no-op for it and
// simplest for the probe.
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};

/**
 * 'user'-family per the migration header: the ONLY value this column
 * currently admits for a genuinely human-authored comment. Anything else
 * ('ai_agent', 'system', 'unknown') is treated as suspect and skips
 * admission — a narrowing allowlist, not a denylist, so a future
 * origin_principal_kind value added to the CHECK constraint fails closed by
 * default rather than silently being treated as human.
 */
const HUMAN_ORIGIN_KIND = 'user';

/**
 * True when ANY comment already on this ticket was agent-originated (either
 * `origin_principal_kind` is not the human-family value, or `agent_run_id`
 * is set — checked independently because a future writer could plausibly set
 * one without the other). A brand-new ticket has zero comments, so this is
 * vacuously false for every `ticket.created` admission today.
 */
async function ticketHasAgentOriginatedActivity(ticketId: string): Promise<boolean> {
  const { db } = dbModule;
  const [row] = await db
    .select({ id: ticketComments.id })
    .from(ticketComments)
    .where(
      and(
        eq(ticketComments.ticketId, ticketId),
        or(ne(ticketComments.originPrincipalKind, HUMAN_ORIGIN_KIND), isNotNull(ticketComments.agentRunId)),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Registered handler for `ticket.created` (`eventSubscribers.ts`). MUST
 * throw on failure — queue-mode dispatch (#4085) retries on a thrown
 * rejection; local delivery's wrapper (eventBus.ts's invokeLocalHandlers)
 * provides the swallow-and-log semantics a handler-level try/catch used to.
 * A malformed event (missing ticketId) is NOT retryable — it is logged and
 * dropped, never thrown, since no redelivery of the same malformed payload
 * would ever succeed.
 */
export async function handleTicketCreatedEvent(event: BreezeEvent): Promise<void> {
  const payload = event.payload as { ticketId?: unknown } | null | undefined;
  const ticketId = typeof payload?.ticketId === 'string' ? payload.ticketId : null;
  const orgId = event.orgId;

  if (!ticketId || !orgId) {
    console.error(
      '[ticketHelpdeskSubscriber] malformed ticket.created event — missing ticketId/orgId, dropping',
      { eventId: event.id, orgId, payload: event.payload },
    );
    return;
  }

  try {
    await runWithSystemDbAccess(async () => {
      if (await ticketHasAgentOriginatedActivity(ticketId)) {
        console.info(
          '[ticketHelpdeskSubscriber] skipping admission — ticket has agent-originated activity (loop guard)',
          { ticketId, orgId },
        );
        return;
      }

      const result = await createAndEnqueueAgentRun({
        orgId,
        kind: 'helpdesk',
        triggerKind: 'ticket',
        deviceId: null,
        ticketId,
        triggerRef: { ticketId },
        dedupeKey: `ticket-created:${ticketId}`,
      });

      if (!result.created) {
        console.info('[ticketHelpdeskSubscriber] admission skipped', {
          ticketId,
          orgId,
          reason: result.skipped,
        });
      }
    });
  } catch (err) {
    console.error('[ticketHelpdeskSubscriber] handler failed', {
      ticketId,
      orgId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
