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
 * 'ticket'` all live there. `createAndEnqueueAgentRun` manages its own DB
 * access and deliberately performs its announce+enqueue step OUTSIDE any
 * system DB context (#1105 pool-hold-across-Redis) — this module MUST call
 * it with no system context active, or that protection is silently defeated
 * by non-re-entrant nesting (see `runWithSystemDbAccess`'s own comment
 * below). Only the origin-guard probe runs inside a system context. This
 * module's own job is narrow:
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
 *  3. Load the ticket's category/priority (`loadTicketFilterContext`) and
 *     pass them as `ticketContext` so `runService.ts`'s
 *     `evaluateTicketTriggerFilters` can enforce `policy.triggers.
 *     ticketCategories`/`ticketPriorities` (wave 6 PR 3 review follow-up,
 *     #3828 — previously validated/merged by effectivePolicy but never read
 *     anywhere, so a helpdesk agent fired on every ticket regardless of its
 *     configured filters).
 *  4. Call `createAndEnqueueAgentRun` with `kind: 'helpdesk'`,
 *     `triggerKind: 'ticket'`, `deviceId: null` (tickets have no device
 *     axis in v1), `ticketContext`, and a dedupe key stable across
 *     redelivery of the same `ticket.created` event.
 */
import { and, eq, isNotNull, ne, or } from 'drizzle-orm';
import * as dbModule from '../../db';
import { ticketComments, tickets } from '../../db/schema';
import type { BreezeEvent } from '../eventBus';
import { createAndEnqueueAgentRun } from './runService';

// #4085-style fix, same as dnsThreatAlerts.ts / policyAlertBridge.ts:
// publish() (eventBus.ts) invokes durable-registry handlers via
// runOutsideDbContext, i.e. ambient scope 'none' — under forced RLS that is
// a 42501 the moment this handler's `db.select` runs without an explicit
// access context. Only the origin-guard probe (`ticketHasAgentOriginatedActivity`)
// is wrapped in this — NOT `createAndEnqueueAgentRun`.
//
// #1105 pool-hold seam: `withSystemDbAccessContext` opens a real Postgres
// transaction for the duration of `fn` (`db/index.ts`'s `withDbAccessContext`
// wraps the callback in `baseDb.transaction(...)`). `createAndEnqueueAgentRun`
// manages its own DB access internally and deliberately calls `publishEvent`
// + the BullMQ enqueuer OUTSIDE its own system context (runService.ts step
// 10) specifically to avoid holding a pooled connection across a Redis
// round-trip. If this module wrapped the WHOLE handler body (including the
// admission call) in a system context, that protection would be silently
// defeated: `runService.ts`'s `inSystemDbContext` skips re-entry when the
// ambient scope is ALREADY 'system' (no second nested transaction), so step
// 10's enqueue would run INSIDE the transaction this handler opened instead
// of after it — the exact pool-hold-across-Redis pattern #1105 exists to
// prevent. `createAndEnqueueAgentRun` must therefore be called with NO
// system context active at all.
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
 * The ticket-trigger-filter shape `runService.ts`'s `evaluateTicketTriggerFilters`
 * evaluates against `policy.triggers.ticketCategories`/`ticketPriorities`
 * (wave 6 PR 3 review follow-up, #3828 — previously validated/merged by
 * effectivePolicy but never read anywhere, so a helpdesk agent fired on
 * EVERY ticket regardless of its configured filters). Org-pinned (Shape 1
 * RLS would normally cover this, but this read runs under the same system
 * DB context as the origin-guard probe above — see this module's header —
 * so the org predicate has to be explicit here too, matching
 * `ticketContext.ts`'s `loadTicketContext`). `null` means the ticket is not
 * (or no longer) in this org — same "moved/deleted reads as absent" posture
 * used throughout this PR.
 */
async function loadTicketFilterContext(
  ticketId: string,
  orgId: string,
): Promise<{ category: string | null; categoryId: string | null; priority: string } | null> {
  const { db } = dbModule;
  const [row] = await db
    .select({ category: tickets.category, categoryId: tickets.categoryId, priority: tickets.priority })
    .from(tickets)
    .where(and(eq(tickets.id, ticketId), eq(tickets.orgId, orgId)))
    .limit(1);
  return row ?? null;
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
    // Only the origin-guard probe runs under a system context — see
    // `runWithSystemDbAccess`'s header comment (#1105 pool-hold seam).
    const hasAgentActivity = await runWithSystemDbAccess(() =>
      ticketHasAgentOriginatedActivity(ticketId),
    );
    if (hasAgentActivity) {
      console.info(
        '[ticketHelpdeskSubscriber] skipping admission — ticket has agent-originated activity (loop guard)',
        { ticketId, orgId },
      );
      return;
    }

    // Load the ticket's category/priority for `runService.ts`'s trigger-filter
    // evaluation (`evaluateTicketTriggerFilters`) — same system-context read
    // as the origin-guard probe above. A `null` result means the ticket is
    // not (or no longer) in this org; there is nothing to admit a run for.
    const ticketFilterCtx = await runWithSystemDbAccess(() =>
      loadTicketFilterContext(ticketId, orgId),
    );
    if (!ticketFilterCtx) {
      console.info(
        '[ticketHelpdeskSubscriber] skipping admission — ticket not found (or not in org)',
        { ticketId, orgId },
      );
      return;
    }

    // Called with NO system DB context active — `createAndEnqueueAgentRun`
    // manages its own (see the header comment on `runWithSystemDbAccess`).
    const result = await createAndEnqueueAgentRun({
      orgId,
      kind: 'helpdesk',
      triggerKind: 'ticket',
      deviceId: null,
      ticketId,
      ticketContext: {
        category: ticketFilterCtx.category,
        categoryId: ticketFilterCtx.categoryId,
        priority: ticketFilterCtx.priority as 'low' | 'normal' | 'high' | 'urgent',
      },
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
  } catch (err) {
    console.error('[ticketHelpdeskSubscriber] handler failed', {
      ticketId,
      orgId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
