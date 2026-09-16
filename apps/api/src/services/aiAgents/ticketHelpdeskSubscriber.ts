/**
 * Durable ticket-helpdesk admission subscriber. Originally wave 6 PR 3
 * (#3828) — docs/superpowers/plans/ai-mcp/2026-08-28-ai-agents-wave6-3-ticket-shadow.md
 * Task 3 — and extended by Phase 2 wave P2-4 (#4187/#4191) Task 9 to admit a
 * `profile: 'triage'` run on the ticket's first HUMAN comment and on its
 * resolution, not just on creation.
 *
 * Registered on the durable `eventSubscriberRegistry` under id
 * `ai-agent-ticket-helpdesk` (`eventSubscribers.ts`), subscribed to
 * `ticket.created`, `ticket.commented`, and `ticket.status_changed` — all
 * three are bridged onto the eventBus by the outbox publisher
 * (`TICKET_OUTBOX_EVENT_BUS_TYPES`, `jobs/ticketOutboxPublisher.ts`).
 *
 * Admission itself is delegated entirely to `createAndEnqueueAgentRun`
 * (runService.ts) — kill switch, circuit breaker, dedupe, concurrency/rate/
 * budget caps, and profile-specific admission rules all live there.
 * `createAndEnqueueAgentRun` manages its own DB access and deliberately
 * performs its announce+enqueue step OUTSIDE any system DB context (#1105
 * pool-hold-across-Redis) — this module MUST call it with no system context
 * active, or that protection is silently defeated by non-re-entrant nesting
 * (see `runWithSystemDbAccess`'s own comment below). Only the DB reads that
 * decide WHETHER to admit run inside a system context. This module's own
 * job, per event type:
 *
 *  - `ticket.created`: unconditional (subject to the loop guard and the
 *    ticket-filter-context read below) — a brand-new ticket always gets a
 *    first triage pass. Dedupe key `ticket-created:<ticketId>`.
 *  - `ticket.commented`: admits ONLY on a comment that DB-verifies as
 *    genuinely human-authored, public, and actually attached to this
 *    ticket/org (`loadVerifiedHumanComment` — never trusts the event
 *    payload's own claims about the comment). Dedupe key
 *    `ticket-commented:<commentId>` (#4212) — the comment IS the event, so
 *    its id is the natural per-event idempotency key. Before #4212 this lane
 *    shared `ticket-created:<ticketId>` with the created lane (the
 *    "first-admitting-event-wins contract"), capping a ticket at one triage
 *    run for life; #4212 deliberately supersedes that.
 *  - `ticket.status_changed`: admits ONLY when the new status is `resolved`
 *    AND the ticket (re-read fresh, never trusted from the payload) carries
 *    no resolution note AND has no `active` `resolution_note` draft already
 *    queued. Dedupe key `ticket-resolved:<ticketId>` — a SEPARATE key from
 *    the created/commented lane, since a resolved-ticket triage pass is a
 *    distinct, later admission on the same ticket, not a duplicate of it.
 *
 * Every admission path shares:
 *  1. Recency-ordered loop guard (design authority: never `source`-string
 *     matching — see the migration header and `ticket_comments.origin_
 *     principal_kind`/`agent_run_id`, Task 1) — `humanCommentIsNewerThanAgentActivity`
 *     (#4212, replacing the old permanent latch `ticketHasAgentOriginatedActivity`).
 *     APPLIED to created/commented, SKIPPED for the resolved lane (I1, final
 *     review #4191) — see `admitTriageRun`'s `loopGuard` param doc: every
 *     triage run posts an AI note, so applying this guard to the resolved
 *     lane would permanently dead-end it after the ticket's first triage pass
 *     ever. `isEligibleForResolvedAdmission`'s fresh re-read is that lane's
 *     own anti-loop gate instead.
 *  2. A hard per-ticket re-triage ceiling (#4212) — `MAX_TRIAGE_RUNS_PER_TICKET`
 *     — an absolute backstop independent of the loop guard and of
 *     runService.ts's per-AGENT rate/concurrency/budget caps.
 *  3. Load the ticket's category/priority (`loadTicketFilterContext`) and
 *     pass them as `ticketContext` so `runService.ts`'s
 *     `evaluateTicketTriggerFilters` can enforce `policy.triggers.
 *     ticketCategories`/`ticketPriorities`.
 *  4. Call `createAndEnqueueAgentRun` with `kind: 'helpdesk'`,
 *     `triggerKind: 'ticket'`, `deviceId: null` (tickets have no device
 *     axis), `profile: 'triage'`, `ticketContext`, and the event's dedupe
 *     key — all via the shared `admitTriageRun` helper.
 */
import { and, desc, eq, isNotNull, isNull, ne, or } from 'drizzle-orm';
import * as dbModule from '../../db';
import { aiAgentRuns, ticketComments, ticketDrafts, tickets } from '../../db/schema';
import type { BreezeEvent } from '../eventBus';
import { createAndEnqueueAgentRun } from './runService';
import { proposeTimeEntryFromOutboxClaim } from '../aiTimeEntryProposal';

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
 * #4212 — the loop guard, ordered rather than latching.
 *
 * The old `ticketHasAgentOriginatedActivity` returned true as soon as ANY
 * agent-originated comment existed, which permanently dead-ended the
 * created/commented lanes after a ticket's first triage pass — acceptable when
 * those lanes shared one dedupe key and could only fire once anyway (#3828 /
 * #4191), and wrong now that each human comment carries its own key (Task 7).
 *
 * The replacement admits only when the human actually spoke AFTER the agent
 * last did. That is exactly what stops ping-pong: the agent's own note (and
 * any comment a human posted FROM an agent proposal, which carries
 * origin_principal_kind='user' and so is human by construction — #4211) can
 * never be the thing that re-admits a run, because a run's note is never
 * newer than the human comment that triggered it.
 *
 * Fail-closed: any read error denies. Same discipline as
 * `evaluateTicketAutonomy` — a loop guard that fails open is a runaway spend.
 */
async function humanCommentIsNewerThanAgentActivity(
  ticketId: string,
  humanCommentCreatedAt: Date,
): Promise<boolean> {
  const { db } = dbModule;
  try {
    const [newestAgent] = await db
      .select({ createdAt: ticketComments.createdAt })
      .from(ticketComments)
      .where(
        and(
          eq(ticketComments.ticketId, ticketId),
          or(ne(ticketComments.originPrincipalKind, HUMAN_ORIGIN_KIND), isNotNull(ticketComments.agentRunId)),
        ),
      )
      .orderBy(desc(ticketComments.createdAt))
      .limit(1);
    if (!newestAgent) return true;
    return humanCommentCreatedAt.getTime() > newestAgent.createdAt.getTime();
  } catch (err) {
    console.error('[ticketHelpdesk] loop-guard read failed — denying admission:', { ticketId, err });
    return false;
  }
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
 * `ticket.commented` admission gate (Task 9, #4191). Loads the comment row
 * by id and verifies EVERY claim the event payload makes about it directly
 * from the DB, in one query — the payload (`ticketId`/`commentId`/the
 * event's `orgId`) is written by a trusted internal publisher today, but
 * this handler treats it as untrusted input per the Codex amendment: a
 * stale/replayed event, a ticket moved to another org after the comment was
 * posted, or a payload/DB drift of any kind must never admit a run on the
 * strength of the payload alone.
 *
 * The join (not two separate reads) is deliberate: it proves the comment
 * genuinely belongs to THIS ticket AND that ticket's CURRENT org is the
 * event's org, atomically, rather than checking the ticket id string match
 * and the org match as two independently-mockable conditions.
 *
 * Returns `null` (never throws for a plain verification miss) whenever any
 * one of these does not hold:
 *  - the comment exists and its `id` is `commentId`
 *  - its `ticket_id` is `ticketId`
 *  - its ticket's `org_id` is `orgId`
 *  - `origin_principal_kind = 'user'` (human-family — see `HUMAN_ORIGIN_KIND`)
 *  - `agent_run_id IS NULL`
 *  - `is_public = true`
 *  - not soft-deleted (`deleted_at IS NULL`)
 *
 * Returns the comment's `createdAt` (#4212) rather than a plain boolean — the
 * commented lane's loop guard needs it as `humanCommentAt` to decide whether
 * this comment is newer than the ticket's last agent-originated activity.
 */
async function loadVerifiedHumanComment(
  commentId: string,
  ticketId: string,
  orgId: string,
): Promise<{ createdAt: Date } | null> {
  const { db } = dbModule;
  const [row] = await db
    .select({ createdAt: ticketComments.createdAt })
    .from(ticketComments)
    .innerJoin(tickets, eq(ticketComments.ticketId, tickets.id))
    .where(
      and(
        eq(ticketComments.id, commentId),
        eq(ticketComments.ticketId, ticketId),
        eq(tickets.orgId, orgId),
        eq(ticketComments.originPrincipalKind, HUMAN_ORIGIN_KIND),
        isNull(ticketComments.agentRunId),
        eq(ticketComments.isPublic, true),
        isNull(ticketComments.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * `ticket.status_changed` admission gate (Task 9, #4191) — re-reads the
 * ticket FRESH rather than trusting the event payload's `to` status (the
 * ticket may have moved again between the status-change write and this
 * handler running). Admits only when ALL of:
 *  - the ticket's CURRENT status is `resolved`
 *  - it carries no resolution note (`resolution_note` is null/empty)
 *  - it has no `active`, `resolution_note`-kind draft already queued (a
 *    triage pass already proposed one and it is awaiting a human decision —
 *    minting a second would just be noise)
 *
 * `null` (not found / moved out of org) reads as "not eligible", same
 * "moved/deleted reads as absent" posture as `loadTicketFilterContext`.
 */
async function isEligibleForResolvedAdmission(ticketId: string, orgId: string): Promise<boolean> {
  const { db } = dbModule;
  const [ticketRow] = await db
    .select({ status: tickets.status, resolutionNote: tickets.resolutionNote })
    .from(tickets)
    .where(and(eq(tickets.id, ticketId), eq(tickets.orgId, orgId)))
    .limit(1);
  if (!ticketRow || ticketRow.status !== 'resolved' || ticketRow.resolutionNote) {
    return false;
  }

  const [activeDraft] = await db
    .select({ id: ticketDrafts.id })
    .from(ticketDrafts)
    .where(
      and(
        eq(ticketDrafts.ticketId, ticketId),
        eq(ticketDrafts.orgId, orgId),
        eq(ticketDrafts.kind, 'resolution_note'),
        eq(ticketDrafts.state, 'active'),
      ),
    )
    .limit(1);
  return activeDraft === undefined;
}

/**
 * #4212 — absolute per-ticket backstop on re-triage. Independent of the
 * per-hour / concurrency / budget caps in runService.ts, which are per AGENT:
 * a single pathological ticket that a customer replies to twenty times must
 * not consume an org's whole triage budget on its own. Counted over every
 * triage-profile run ever admitted for the ticket, not a rolling window, so
 * the ceiling is a true ceiling.
 *
 * A constant, not a policy field: the existing `ai_agents.limits` jsonb is at
 * schemaVersion 8 and every bump ripples through `validators/aiAgents.ts`,
 * `effectivePolicy.ts`, `agentPreview.ts` and the settings UI. This ceiling is
 * a safety backstop, not a knob techs tune — `limits.maxTriageRunsPerHour`
 * and `cooldownSeconds` are the tunable dials and already apply.
 *
 * Fail-closed on a read error, same discipline as the loop guard above.
 *
 * Known limitation (review follow-up, #4212, out of scope for this wave):
 * this is check-then-act, not locked per-ticket — `createAndEnqueueAgentRun`'s
 * own `pg_advisory_xact_lock` (runService.ts) is keyed on `(agentId, orgId)`,
 * not `ticketId`, and is acquired only inside that call, after this read
 * already ran. Two genuinely concurrent `ticket.commented` events for the
 * SAME ticket (distinct comments, hence distinct dedupe keys) could both read
 * "below ceiling" and both admit, letting the count exceed
 * `MAX_TRIAGE_RUNS_PER_TICKET` by the concurrency width. This is a soft cap
 * under concurrent delivery, not an absolute one; closing it needs a
 * ticket-scoped lock/`SELECT ... FOR UPDATE` spanning this read and the
 * enqueue, which is a real design decision the W02 plan did not specify —
 * tracked as a fast-follow rather than expanded here.
 */
export const MAX_TRIAGE_RUNS_PER_TICKET = 5;

async function triageRunCeilingReached(ticketId: string): Promise<boolean> {
  const { db } = dbModule;
  try {
    const rows = await db
      .select({ id: aiAgentRuns.id })
      .from(aiAgentRuns)
      .where(and(eq(aiAgentRuns.ticketId, ticketId), eq(aiAgentRuns.profile, 'triage')))
      .limit(MAX_TRIAGE_RUNS_PER_TICKET);
    return rows.length >= MAX_TRIAGE_RUNS_PER_TICKET;
  } catch (err) {
    console.error('[ticketHelpdesk] triage-run ceiling read failed — denying admission:', { ticketId, err });
    return true;
  }
}

/**
 * The shared "admit a triage run for this ticket" body every event handler
 * below funnels into once its own event-specific gate has passed: the loop
 * guard, the ticket-filter-context read, and the `createAndEnqueueAgentRun`
 * call with `profile: 'triage'`. Only the reads run under a system DB
 * context — the admission call itself must run with NONE active (see this
 * file's header and `runWithSystemDbAccess`'s comment below).
 *
 * `loopGuard` (#4212, replacing the old boolean `applyLoopGuard`): either
 * `{ humanCommentAt: Date }` — applied for the created/commented lanes, where
 * `humanCommentIsNewerThanAgentActivity` guards against a real risk, an
 * AI-authored comment re-triggering `ticket.commented` and admitting a
 * second run off its own note — or the literal `'skip'`, used by the
 * `ticket.status_changed -> resolved` lane. That lane has no such risk: every
 * triage run posts an AI note as a side effect (Task 6), so applying the
 * guard there would let ANY prior triage pass on the ticket, no matter how
 * old, permanently block it. Skipping the guard there is safe because
 * `isEligibleForResolvedAdmission`'s fresh re-read (active resolution_note
 * draft + no resolution note already present) is itself the anti-loop gate
 * for that lane: a run this function admits either produces a draft
 * (blocking the NEXT resolved event) or the ticket is no longer resolved,
 * either of which already prevents readmission without help from the
 * recency check.
 */
async function admitTriageRun(
  orgId: string,
  ticketId: string,
  dedupeKey: string,
  loopGuard: { humanCommentAt: Date } | 'skip',
): Promise<void> {
  // Only the loop-guard probe, the ceiling read, and the ticket-filter-context
  // read run under a system context — see `runWithSystemDbAccess`'s header
  // comment (#1105 pool-hold seam).
  if (loopGuard !== 'skip') {
    const ok = await runWithSystemDbAccess(() =>
      humanCommentIsNewerThanAgentActivity(ticketId, loopGuard.humanCommentAt),
    );
    if (!ok) {
      console.info(
        '[ticketHelpdeskSubscriber] skipping admission — no human activity newer than the ticket\'s last agent action (loop guard)',
        { ticketId, orgId },
      );
      return;
    }
  }

  // #4212 — absolute per-ticket backstop, independent of and unconditional
  // on the loop guard above (applies even to the resolved lane's 'skip').
  const atCeiling = await runWithSystemDbAccess(() => triageRunCeilingReached(ticketId));
  if (atCeiling) {
    console.info(
      '[ticketHelpdeskSubscriber] skipping admission — ticket is at the per-ticket triage-run ceiling',
      { ticketId, orgId, ceiling: MAX_TRIAGE_RUNS_PER_TICKET },
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
    dedupeKey,
    // Task 6 (#4191) — a triage run, never the pre-existing `full` shape.
    profile: 'triage',
  });

  if (!result.created) {
    console.info('[ticketHelpdeskSubscriber] admission skipped', {
      ticketId,
      orgId,
      reason: result.skipped,
    });
  }
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
    // #4212: a brand-new ticket has no prior comments, so the recency-ordered
    // loop guard returns true vacuously — passing epoch as `humanCommentAt`
    // means the ONLY way this can admit is "no agent activity yet", which
    // still denies a redelivered `ticket.created` for an already-triaged
    // ticket.
    await admitTriageRun(orgId, ticketId, `ticket-created:${ticketId}`, { humanCommentAt: new Date(0) });
  } catch (err) {
    console.error('[ticketHelpdeskSubscriber] handler failed', {
      ticketId,
      orgId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/**
 * Registered handler for `ticket.commented` (`eventSubscribers.ts`). Same
 * throw/drop contract as `handleTicketCreatedEvent` — a malformed payload
 * (missing ticketId/commentId/orgId) is logged and dropped, never thrown;
 * anything past that point throws on failure for queue-mode retry.
 *
 * Dedupe key `ticket-commented:<commentId>` (#4212) — per-EVENT, not
 * per-ticket; see this file's header for why the created lane keeps its own
 * separate key.
 */
/**
 * #4177 (W04): a `ticket.commented` / `ticket.status_changed` outbox event
 * whose payload carries an `aiDraft` claim (ticketService consumed a draft
 * authored by an agent run) mints the Tier-2 time-entry PROPOSAL. Runs
 * before — and independently of — the admission logic below: the proposal
 * is about the technician's just-finished work, not about admitting a new
 * run. `proposeTimeEntryFromOutboxClaim` DB-verifies the claim and returns
 * null for every permanent "no"; it THROWS only on an infrastructure error,
 * which is exactly what this handler's retry contract wants (registry:
 * "MUST throw on failure") — minting is idempotent per (run, trigger) and
 * admission is idempotent per dedupe key, so the redelivery cannot
 * double-mint or double-admit.
 */
async function proposeTimeEntryIfClaimed(event: BreezeEvent, ticketId: string, orgId: string): Promise<void> {
  const claim = (event.payload as { aiDraft?: unknown } | null | undefined)?.aiDraft;
  if (claim === undefined || claim === null) return;
  await proposeTimeEntryFromOutboxClaim({ orgId, ticketId, claim });
}

export async function handleTicketCommentedEvent(event: BreezeEvent): Promise<void> {
  const payload = event.payload as { ticketId?: unknown; commentId?: unknown } | null | undefined;
  const ticketId = typeof payload?.ticketId === 'string' ? payload.ticketId : null;
  const commentId = typeof payload?.commentId === 'string' ? payload.commentId : null;
  const orgId = event.orgId;

  if (!ticketId || !commentId || !orgId) {
    console.error(
      '[ticketHelpdeskSubscriber] malformed ticket.commented event — missing ticketId/commentId/orgId, dropping',
      { eventId: event.id, orgId, payload: event.payload },
    );
    return;
  }

  await proposeTimeEntryIfClaimed(event, ticketId, orgId);

  try {
    // DB verification of every payload claim — see `loadVerifiedHumanComment`'s
    // docstring. Runs under a system context, same as the loop guard below.
    const verified = await runWithSystemDbAccess(() =>
      loadVerifiedHumanComment(commentId, ticketId, orgId),
    );
    if (!verified) {
      console.info(
        '[ticketHelpdeskSubscriber] skipping admission — comment failed human/public/ticket/org verification',
        { ticketId, commentId, orgId },
      );
      return;
    }

    // #4212: per-EVENT dedupe. The comment IS the event, so its id is the
    // natural idempotency key: a redelivered outbox row for the same comment
    // collides on ai_agent_runs_org_dedupe_key_uq and no-ops, while the NEXT
    // human comment gets its own key and can admit its own re-triage run.
    // Before this change the commented lane shared `ticket-created:<ticketId>`
    // with the created lane, which capped the ticket at one triage run for
    // life (the "first-admitting-event-wins contract" the old header comment
    // described — deliberately superseded here).
    await admitTriageRun(orgId, ticketId, `ticket-commented:${commentId}`, { humanCommentAt: verified.createdAt });
  } catch (err) {
    console.error('[ticketHelpdeskSubscriber] handler failed', {
      ticketId,
      commentId,
      orgId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/**
 * Registered handler for `ticket.status_changed` (`eventSubscribers.ts`).
 * Same throw/drop contract as the siblings above. The payload's `to` is
 * used ONLY as a cheap prefilter to skip the DB round trip for the vast
 * majority of status changes that are not a resolution
 * (open/pending/on_hold/closed transitions) — the actual admission decision
 * re-reads the ticket fresh (`isEligibleForResolvedAdmission`), never
 * trusting the payload's claim about the ticket's current state.
 */
export async function handleTicketStatusChangedEvent(event: BreezeEvent): Promise<void> {
  const payload = event.payload as { ticketId?: unknown; to?: unknown } | null | undefined;
  const ticketId = typeof payload?.ticketId === 'string' ? payload.ticketId : null;
  const toStatus = typeof payload?.to === 'string' ? payload.to : null;
  const orgId = event.orgId;

  if (!ticketId || !orgId) {
    console.error(
      '[ticketHelpdeskSubscriber] malformed ticket.status_changed event — missing ticketId/orgId, dropping',
      { eventId: event.id, orgId, payload: event.payload },
    );
    return;
  }

  await proposeTimeEntryIfClaimed(event, ticketId, orgId);

  // Cheap prefilter only — see the docstring above. The real decision is
  // `isEligibleForResolvedAdmission`'s fresh re-read.
  if (toStatus !== 'resolved') {
    return;
  }

  try {
    const eligible = await runWithSystemDbAccess(() =>
      isEligibleForResolvedAdmission(ticketId, orgId),
    );
    if (!eligible) {
      console.info(
        '[ticketHelpdeskSubscriber] skipping resolved admission — ticket not (still) resolved, already has a resolution note, or an active resolution-note draft exists',
        { ticketId, orgId },
      );
      return;
    }

    // loopGuard: 'skip' — see admitTriageRun's docstring: every triage run
    // posts an AI note, so the standard loop guard would permanently block
    // this lane after the ticket's first-ever triage pass.
    await admitTriageRun(orgId, ticketId, `ticket-resolved:${ticketId}`, 'skip');
  } catch (err) {
    console.error('[ticketHelpdeskSubscriber] handler failed', {
      ticketId,
      orgId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
