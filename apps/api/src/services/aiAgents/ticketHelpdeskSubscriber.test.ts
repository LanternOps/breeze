/**
 * ticketHelpdeskSubscriber (#3828 wave-6-3 task 3).
 *
 * Mocked-DB unit tests for the durable `ai-agent-ticket-helpdesk` event
 * subscriber. `createAndEnqueueAgentRun` (runService.ts) is mocked — its own
 * admission behaviour (dedupe, forced shadow, kill switch, circuit breaker,
 * trigger-filter matching) is covered in runService.test.ts; these tests pin
 * only what THIS module is responsible for: extracting the trigger from the
 * event, running the origin-based loop guard, loading the ticket's
 * category/priority for the trigger-filter context, and calling admission
 * with the right shape.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

vi.mock('../../db', () => ({
  db: { select: vi.fn() },
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  getCurrentDbAccessContext: vi.fn(() => undefined),
}));

vi.mock('../../db/schema', () => ({
  ticketComments: {
    id: 'id',
    ticketId: 'ticket_id',
    originPrincipalKind: 'origin_principal_kind',
    agentRunId: 'agent_run_id',
    isPublic: 'is_public',
    deletedAt: 'deleted_at',
    createdAt: 'created_at',
  },
  tickets: {
    id: 'id',
    orgId: 'org_id',
    category: 'category',
    categoryId: 'category_id',
    priority: 'priority',
    status: 'status',
    resolutionNote: 'resolution_note',
  },
  ticketDrafts: {
    id: 'id',
    ticketId: 'ticket_id',
    orgId: 'org_id',
    kind: 'kind',
    state: 'state',
  },
  aiAgentRuns: {
    id: 'id',
    ticketId: 'ticket_id',
    profile: 'profile',
  },
}));

const createAndEnqueueAgentRun = vi.hoisted(() => vi.fn());
vi.mock('./runService', () => ({ createAndEnqueueAgentRun }));
// #4177 (W04): the time-entry proposal minted from an outbox `aiDraft` claim.
// Mocked wholesale — its verification + minting is aiTimeEntryProposal.test.ts;
// here we pin that the subscriber forwards the claim (and only a claim) and
// that a proposal failure never blocks admission.
const proposeTimeEntryFromOutboxClaim = vi.hoisted(() => vi.fn(async () => null));
vi.mock('../aiTimeEntryProposal', () => ({ proposeTimeEntryFromOutboxClaim }));

import { db, withSystemDbAccessContext } from '../../db';
import type { BreezeEvent } from '../eventBus';
import {
  handleTicketCreatedEvent,
  handleTicketCommentedEvent,
  handleTicketStatusChangedEvent,
  MAX_TRIAGE_RUNS_PER_TICKET,
} from './ticketHelpdeskSubscriber';

const ORG_ID = '00000000-0000-4000-8000-0000000000c1';
const TICKET_ID = '00000000-0000-4000-8000-0000000000c2';
const COMMENT_ID = '00000000-0000-4000-8000-0000000000c3';

function ticketCreatedEvent(over: Partial<BreezeEvent> = {}): BreezeEvent {
  return {
    id: 'evt-1',
    type: 'ticket.created',
    orgId: ORG_ID,
    source: 'ticket-outbox-publisher',
    priority: 'normal',
    payload: { ticketId: TICKET_ID },
    metadata: { timestamp: '2026-08-28T00:00:00.000Z' },
    ...over,
  } as BreezeEvent;
}

// Captures the most recent `.where()` mock for EACH of the two reads
// (origin-guard probe, ticket-filter-context read) so a test can pull its
// call argument and compile it to real SQL — asserting on the predicate that
// DEFINES the guard/scope, not just on which rows the (entirely mocked)
// query happens to resolve to.
let lastOriginWhereMock: ReturnType<typeof vi.fn> | undefined;
let lastTicketWhereMock: ReturnType<typeof vi.fn> | undefined;

/** db.select().from().where().orderBy().limit() -> rows (the recency-ordered
 *  loop guard probe, #4212 — `humanCommentIsNewerThanAgentActivity`). Must be
 *  queued FIRST — it is the first `db.select()` call the handler makes when
 *  the guard is not skipped. Rows carry `createdAt`, not `id` — the guard
 *  compares timestamps, not presence. */
function mockOriginProbe(rows: unknown[]) {
  const orderByMock = vi.fn().mockReturnValue({
    limit: vi.fn().mockResolvedValue(rows),
  });
  const whereMock = vi.fn().mockReturnValue({
    orderBy: orderByMock,
  });
  lastOriginWhereMock = whereMock;
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: whereMock,
    }),
  } as never);
}

/** db.select().from().where().limit() -> rows (loadTicketFilterContext). Must
 *  be queued SECOND, right after `mockOriginProbe` — the handler only makes
 *  this second call when the origin-guard probe found no agent activity. */
function mockTicketFilterRead(rows: unknown[]) {
  const whereMock = vi.fn().mockReturnValue({
    limit: vi.fn().mockResolvedValue(rows),
  });
  lastTicketWhereMock = whereMock;
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: whereMock,
    }),
  } as never);
}

/** db.select().from().where().limit() -> rows (the per-ticket triage-run
 *  ceiling check, #4212 — `triageRunCeilingReached`). Queued THIRD in the
 *  admission path, right after the loop guard and before the
 *  ticket-filter-context read. Pass an array of `rows.length` to simulate how
 *  many prior triage runs exist for the ticket (the real query caps at
 *  `MAX_TRIAGE_RUNS_PER_TICKET` via `.limit()`). */
function mockTriageRunCeilingRead(rows: unknown[]) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
      }),
    }),
  } as never);
}

/** The common "admission proceeds" setup: no agent-originated activity,
 *  below the per-ticket triage-run ceiling, and the ticket exists in-org
 *  with the given category/categoryId/priority. */
function mockCleanTicket(overrides: Partial<{ category: string | null; categoryId: string | null; priority: string }> = {}) {
  mockOriginProbe([]);
  mockTriageRunCeilingRead([]);
  mockTicketFilterRead([{ category: 'hardware', categoryId: null, priority: 'normal', ...overrides }]);
}

// Captures the `.where()` mock of the comment-verification join query
// (`loadVerifiedHumanComment`) so a test can compile its predicate to real
// SQL, same discipline as `lastOriginWhereMock`/`lastTicketWhereMock` above.
let lastCommentVerifyWhereMock: ReturnType<typeof vi.fn> | undefined;

/** db.select().from().innerJoin().where().limit() -> rows (the
 *  `ticket.commented` comment-verification join). Must be queued FIRST for
 *  `handleTicketCommentedEvent` — it is the handler's first `db.select()`
 *  call, before the shared loop guard / ticket-filter-context reads. */
function mockCommentVerification(rows: unknown[]) {
  const whereMock = vi.fn().mockReturnValue({
    limit: vi.fn().mockResolvedValue(rows),
  });
  lastCommentVerifyWhereMock = whereMock;
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      innerJoin: vi.fn().mockReturnValue({
        where: whereMock,
      }),
    }),
  } as never);
}

/** db.select().from().where().limit() -> rows (the `ticket.status_changed`
 *  fresh ticket re-read: status + resolutionNote). Must be queued FIRST for
 *  `handleTicketStatusChangedEvent`. */
function mockResolvedTicketRead(rows: unknown[]) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
      }),
    }),
  } as never);
}

/** db.select().from().where().limit() -> rows (the active
 *  resolution_note-draft check). Must be queued SECOND for
 *  `handleTicketStatusChangedEvent`, right after `mockResolvedTicketRead`
 *  — only reached when the ticket itself re-reads as resolved with no note. */
function mockActiveResolutionDraftRead(rows: unknown[]) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
      }),
    }),
  } as never);
}

function ticketCommentedEvent(over: Partial<BreezeEvent> = {}): BreezeEvent {
  return {
    id: 'evt-2',
    type: 'ticket.commented',
    orgId: ORG_ID,
    source: 'ticket-outbox-publisher',
    priority: 'normal',
    payload: { ticketId: TICKET_ID, commentId: COMMENT_ID, isPublic: true },
    metadata: { timestamp: '2026-08-28T00:00:00.000Z' },
    ...over,
  } as BreezeEvent;
}

function ticketStatusChangedEvent(over: Partial<BreezeEvent> = {}): BreezeEvent {
  return {
    id: 'evt-3',
    type: 'ticket.status_changed',
    orgId: ORG_ID,
    source: 'ticket-outbox-publisher',
    priority: 'normal',
    payload: { ticketId: TICKET_ID, from: 'open', to: 'resolved' },
    metadata: { timestamp: '2026-08-28T00:00:00.000Z' },
    ...over,
  } as BreezeEvent;
}

beforeEach(() => {
  vi.mocked(db.select).mockReset();
  createAndEnqueueAgentRun.mockReset().mockResolvedValue({
    created: true,
    run: { id: 'run-1' },
  });
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('handleTicketCreatedEvent', () => {
  it('admits a helpdesk run when the ticket has no agent-originated activity', async () => {
    mockCleanTicket({ category: 'hardware', categoryId: null, priority: 'normal' });

    await handleTicketCreatedEvent(ticketCreatedEvent());

    expect(createAndEnqueueAgentRun).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: ORG_ID,
        kind: 'helpdesk',
        triggerKind: 'ticket',
        deviceId: null,
        ticketId: TICKET_ID,
        ticketContext: { category: 'hardware', categoryId: null, priority: 'normal' },
        dedupeKey: `ticket-created:${TICKET_ID}`,
        // Task 6/9 (#4191): every admission this module makes is a triage
        // run, never the pre-existing `full` shape.
        profile: 'triage',
      }),
    );
  });

  it('runs the origin-guard probe and the admission call under a system DB context', async () => {
    mockCleanTicket();
    await handleTicketCreatedEvent(ticketCreatedEvent());
    expect(withSystemDbAccessContext).toHaveBeenCalled();
  });

  it('loop guard: skips admission when the ticket already has agent-originated activity (created lane passes epoch as its humanCommentAt, #4212)', async () => {
    mockOriginProbe([{ createdAt: new Date('2026-09-10T10:00:00Z') }]);

    await handleTicketCreatedEvent(ticketCreatedEvent());

    expect(createAndEnqueueAgentRun).not.toHaveBeenCalled();
    // The loop guard short-circuits BEFORE the ticket-filter-context read —
    // only the origin probe's one `db.select()` call is ever made.
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it('skips admission when the ticket is not found (or not in org) — no filter context to admit against', async () => {
    mockOriginProbe([]);
    mockTriageRunCeilingRead([]);
    mockTicketFilterRead([]); // ticket vanished / moved org between event and processing

    await handleTicketCreatedEvent(ticketCreatedEvent());

    expect(createAndEnqueueAgentRun).not.toHaveBeenCalled();
  });

  // Compiles the actual `.where()` argument to real parameterized SQL via
  // `PgDialect().sqlToQuery(...)` and asserts on both `.sql` and `.params` —
  // a bare `toContain(...)` substring check (or asserting only on the rows
  // the mock resolves to) passes identically whether the code wrote
  // `and()`/`or()` correctly, swapped them, or dropped the ticket-id scope
  // entirely, so structure is what's under test, not just presence. The
  // mocked schema's columns (see the `vi.mock('../../db/schema', ...)`
  // above) are plain strings rather than real Drizzle Column instances,
  // which is exactly what compiles them to bound parameters below instead of
  // quoted identifiers.
  it('loop guard WHERE clause: scopes to the ticket AND requires the origin OR (non-human origin OR a set agent_run_id)', async () => {
    mockCleanTicket();

    await handleTicketCreatedEvent(ticketCreatedEvent());

    const whereArg = lastOriginWhereMock!.mock.calls[0]?.[0];
    const { sql: sqlText, params } = new PgDialect().sqlToQuery(whereArg as never);

    // `($1 = $2 and ($3 <> $4 or $5 is not null))` — the ticket-id scope
    // ANDed with an OR of the two origin arms, i.e. deleting either the
    // ticket-id scope, the AND, or either OR arm changes this string.
    expect(sqlText).toBe('($1 = $2 and ($3 <> $4 or $5 is not null))');
    expect(params).toEqual(['ticket_id', TICKET_ID, 'origin_principal_kind', 'user', 'agent_run_id']);
  });

  // Wave 6 PR 3 review follow-up (#3828): `loadTicketFilterContext` runs
  // under a system DB context (full RLS bypass, same as the origin-guard
  // probe), so the org predicate has to be explicit in the WHERE clause by
  // hand — proven here the same way, not just by which rows the mock
  // resolves to.
  it('ticket-filter-context read is org-pinned', async () => {
    mockCleanTicket();

    await handleTicketCreatedEvent(ticketCreatedEvent());

    const whereArg = lastTicketWhereMock!.mock.calls[0]?.[0];
    const { sql: sqlText, params } = new PgDialect().sqlToQuery(whereArg as never);

    // `($1 = $2 and $3 = $4)` — the ticket-id scope ANDed with the org pin.
    expect(sqlText).toBe('($1 = $2 and $3 = $4)');
    expect(params).toEqual(['id', TICKET_ID, 'org_id', ORG_ID]);
  });

  it('a duplicate delivery of the same ticket.created event calls admission twice with the same dedupe key (admission itself collapses it)', async () => {
    mockCleanTicket();
    mockCleanTicket();
    createAndEnqueueAgentRun
      .mockResolvedValueOnce({ created: true, run: { id: 'run-1' } })
      .mockResolvedValueOnce({ created: false, skipped: 'duplicate' });

    const event = ticketCreatedEvent();
    await handleTicketCreatedEvent(event);
    await handleTicketCreatedEvent(event);

    expect(createAndEnqueueAgentRun).toHaveBeenCalledTimes(2);
    expect(createAndEnqueueAgentRun.mock.calls[0]![0]).toMatchObject({
      dedupeKey: `ticket-created:${TICKET_ID}`,
    });
    expect(createAndEnqueueAgentRun.mock.calls[1]![0]).toMatchObject({
      dedupeKey: `ticket-created:${TICKET_ID}`,
    });
    // Must not throw on the duplicate-skip result.
  });

  it('does not throw and does not admit when the event payload has no ticketId', async () => {
    await expect(
      handleTicketCreatedEvent(ticketCreatedEvent({ payload: {} })),
    ).resolves.toBeUndefined();
    expect(createAndEnqueueAgentRun).not.toHaveBeenCalled();
    expect(db.select).not.toHaveBeenCalled();
  });

  // #4212: `humanCommentIsNewerThanAgentActivity` fails CLOSED internally
  // (denies rather than rethrowing) — a queue-mode retry of a transient read
  // error can't distinguish "no agent activity" from "couldn't tell", so the
  // safe default is deny, not retry. This supersedes the old rethrow
  // contract for this specific probe (the ticket-filter-context read below
  // still rethrows — it has no such fail-closed design).
  it('denies rather than rethrowing when the loop-guard probe itself fails (fail-closed, #4212)', async () => {
    vi.mocked(db.select).mockImplementationOnce(() => {
      throw new Error('boom');
    });

    await expect(handleTicketCreatedEvent(ticketCreatedEvent())).resolves.toBeUndefined();
    expect(createAndEnqueueAgentRun).not.toHaveBeenCalled();
  });

  it('rethrows when the ticket-filter-context read itself fails (queue-mode retry contract)', async () => {
    mockOriginProbe([]);
    mockTriageRunCeilingRead([]);
    vi.mocked(db.select).mockImplementationOnce(() => {
      throw new Error('ticket read boom');
    });

    await expect(handleTicketCreatedEvent(ticketCreatedEvent())).rejects.toThrow('ticket read boom');
    expect(createAndEnqueueAgentRun).not.toHaveBeenCalled();
  });

  // #1105 pool-hold seam contract: `withSystemDbAccessContext` opens a real
  // Postgres transaction (`db/index.ts`'s `withDbAccessContext` wraps `fn` in
  // `baseDb.transaction(...)`). `createAndEnqueueAgentRun` manages its own DB
  // access internally and deliberately calls `publishEvent` + the BullMQ
  // enqueuer OUTSIDE its own system context (runService.ts step 10) to avoid
  // holding a pooled connection across a Redis round-trip. Wrapping the WHOLE
  // handler body — including this call — in a system context here would
  // silently defeat that: `runService.ts`'s `inSystemDbContext` skips
  // re-entry when the ambient scope is already 'system', so step 10 would run
  // INSIDE the still-open transaction this handler opened. Only the
  // origin-guard probe and the ticket-filter-context read may run under a
  // system context; the admission call must run with no system context
  // active at all.
  it('calls createAndEnqueueAgentRun OUTSIDE any withSystemDbAccessContext scope (pool-hold seam contract, #1105)', async () => {
    mockCleanTicket();
    let systemContextDepth = 0;
    vi.mocked(withSystemDbAccessContext).mockImplementation(async (fn: () => Promise<unknown>) => {
      systemContextDepth += 1;
      try {
        return await fn();
      } finally {
        systemContextDepth -= 1;
      }
    });
    let depthDuringAdmission: number | null = null;
    createAndEnqueueAgentRun.mockImplementation(async () => {
      depthDuringAdmission = systemContextDepth;
      return { created: true, run: { id: 'run-1' } };
    });

    await handleTicketCreatedEvent(ticketCreatedEvent());

    expect(depthDuringAdmission).toBe(0);
  });
});

// -----------------------------------------------------------------------
// Task 8 (#4212): the loop guard is recency-ordered, not a permanent latch —
// a ticket may re-triage whenever the human spoke AFTER the agent last did.
// -----------------------------------------------------------------------
describe('recency-ordered loop guard (#4212)', () => {
  it('admits when the human comment is newer than the newest agent comment', async () => {
    mockCommentVerification([{ createdAt: new Date('2026-09-10T11:00:00Z') }]);
    mockOriginProbe([{ createdAt: new Date('2026-09-10T10:00:00Z') }]);
    mockTriageRunCeilingRead([]);
    mockTicketFilterRead([{ category: 'hardware', categoryId: null, priority: 'normal' }]);

    await handleTicketCommentedEvent(ticketCommentedEvent({ payload: { ticketId: TICKET_ID, commentId: 'c2', isPublic: true } }));

    expect(createAndEnqueueAgentRun).toHaveBeenCalled();
  });

  it('skips when the newest agent comment is newer than the human comment (redelivery / no new activity)', async () => {
    mockCommentVerification([{ createdAt: new Date('2026-09-10T11:00:00Z') }]);
    mockOriginProbe([{ createdAt: new Date('2026-09-10T12:00:00Z') }]);

    await handleTicketCommentedEvent(ticketCommentedEvent({ payload: { ticketId: TICKET_ID, commentId: 'c1', isPublic: true } }));

    expect(createAndEnqueueAgentRun).not.toHaveBeenCalled();
  });

  // Review follow-up (pr-test-analyzer): the comparison is strict `>`, so a
  // tie denies — pin that boundary explicitly rather than leaving it to be
  // inferred from the newer/older cases above. Matters in practice because
  // Postgres `now()` is constant within one transaction, so an agent note and
  // a human comment written in the same transaction (bulk import, a test
  // fixture) can share an identical timestamp.
  it('a tie (equal timestamps) denies — the comparison is strict greater-than', async () => {
    const sameInstant = new Date('2026-09-10T11:00:00Z');
    mockCommentVerification([{ createdAt: sameInstant }]);
    mockOriginProbe([{ createdAt: sameInstant }]);

    await handleTicketCommentedEvent(ticketCommentedEvent({ payload: { ticketId: TICKET_ID, commentId: 'c1', isPublic: true } }));

    expect(createAndEnqueueAgentRun).not.toHaveBeenCalled();
  });

  // Review follow-up (pr-test-analyzer): proves the CHECK ORDER, not just the
  // outcome — when the loop guard denies, the per-ticket ceiling read
  // (Task 9) must never fire. The mirror case (ceiling still evaluated when
  // the guard is explicitly 'skip'ped for the resolved lane) is already
  // pinned by the "resolved lane skips the guard entirely" test below; this
  // is the other half of that interaction.
  it('the ceiling is never evaluated when the loop guard already denied (short-circuit, #4212)', async () => {
    mockCommentVerification([{ createdAt: new Date('2026-09-10T11:00:00Z') }]);
    mockOriginProbe([{ createdAt: new Date('2026-09-10T12:00:00Z') }]); // agent spoke after — denies

    await handleTicketCommentedEvent(ticketCommentedEvent({ payload: { ticketId: TICKET_ID, commentId: 'c1', isPublic: true } }));

    expect(createAndEnqueueAgentRun).not.toHaveBeenCalled();
    // verification (1) + loop guard (1) only — if the ceiling read fired
    // too, this would be 3 (and the mock queue, empty past index 1, would
    // either throw or resolve undefined instead of a real row shape).
    expect(db.select).toHaveBeenCalledTimes(2);
  });

  it('a brand-new ticket with no comments still admits (created lane passes epoch vacuously)', async () => {
    mockCleanTicket();

    await handleTicketCreatedEvent(ticketCreatedEvent());

    expect(createAndEnqueueAgentRun).toHaveBeenCalled();
  });

  it('a DB error in the guard denies rather than admitting (fail-closed)', async () => {
    mockCommentVerification([{ createdAt: new Date('2026-09-10T11:00:00Z') }]);
    vi.mocked(db.select).mockImplementationOnce(() => {
      throw new Error('boom');
    });

    await handleTicketCommentedEvent(ticketCommentedEvent({ payload: { ticketId: TICKET_ID, commentId: 'c1', isPublic: true } }));

    expect(createAndEnqueueAgentRun).not.toHaveBeenCalled();
  });

  it('the resolved lane skips the guard entirely — an ancient agent note does not block resolution admission', async () => {
    mockResolvedTicketRead([{ status: 'resolved', resolutionNote: null }]);
    mockActiveResolutionDraftRead([]);
    // The per-ticket triage-run ceiling (Task 9) is NOT skipped by 'skip' —
    // it applies unconditionally as an absolute backstop, unlike the loop
    // guard.
    mockTriageRunCeilingRead([]);
    mockTicketFilterRead([{ category: 'hardware', categoryId: null, priority: 'normal' }]);

    await handleTicketStatusChangedEvent(ticketStatusChangedEvent());

    expect(createAndEnqueueAgentRun).toHaveBeenCalled();
    // No origin-guard probe at all for this lane — 4 selects total (resolved
    // read, active-draft read, ceiling read, ticket-filter-context read).
    expect(db.select).toHaveBeenCalledTimes(4);
  });
});

// -----------------------------------------------------------------------
// Task 9 (#4191): ticket.commented admission — first genuinely-human
// comment on a ticket.
// -----------------------------------------------------------------------
describe('handleTicketCommentedEvent', () => {
  it('admits a triage run when the comment DB-verifies as human/public and matches the ticket/org, using a per-comment dedupe key (#4212)', async () => {
    mockCommentVerification([{ createdAt: new Date('2026-09-10T11:00:00Z') }]);
    mockCleanTicket();

    await handleTicketCommentedEvent(ticketCommentedEvent());

    expect(createAndEnqueueAgentRun).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: ORG_ID,
        kind: 'helpdesk',
        triggerKind: 'ticket',
        ticketId: TICKET_ID,
        dedupeKey: `ticket-commented:${COMMENT_ID}`,
        profile: 'triage',
      }),
    );
  });

  // Codex amendment: never trust payload fields — a forged/stale payload
  // claiming a comment belongs to this ticket/org when the DB says
  // otherwise (wrong ticket, wrong org, or the comment doesn't exist at
  // all) must not admit.
  it('rejects a forged payload — the comment does not DB-verify against this ticket/org', async () => {
    mockCommentVerification([]); // join found no matching row

    await handleTicketCommentedEvent(ticketCommentedEvent());

    expect(createAndEnqueueAgentRun).not.toHaveBeenCalled();
    // Verification fails BEFORE the loop guard / ticket-filter-context reads.
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it('rejects an internal (non-public) or agent-originated comment', async () => {
    // The mocked join predicate itself encodes is_public/origin/agent_run_id
    // — a real DB would return zero rows for either case, so this is
    // exercised identically to the forged-payload case from this test's
    // perspective; the WHERE-clause compilation test below proves the
    // predicate itself is correct.
    mockCommentVerification([]);

    await handleTicketCommentedEvent(ticketCommentedEvent({ payload: { ticketId: TICKET_ID, commentId: COMMENT_ID, isPublic: false } }));

    expect(createAndEnqueueAgentRun).not.toHaveBeenCalled();
  });

  it('loop guard is still consulted after comment verification passes — denies when the newest agent comment is newer than this human comment', async () => {
    mockCommentVerification([{ createdAt: new Date('2026-09-10T11:00:00Z') }]);
    mockOriginProbe([{ createdAt: new Date('2026-09-10T12:00:00Z') }]); // agent spoke AFTER this human comment

    await handleTicketCommentedEvent(ticketCommentedEvent());

    expect(createAndEnqueueAgentRun).not.toHaveBeenCalled();
    // verification (1) + loop guard (1); short-circuits before the
    // ticket-filter-context read.
    expect(db.select).toHaveBeenCalledTimes(2);
  });

  it('does not throw and does not admit when the event payload has no commentId', async () => {
    await expect(
      handleTicketCommentedEvent(ticketCommentedEvent({ payload: { ticketId: TICKET_ID } })),
    ).resolves.toBeUndefined();
    expect(createAndEnqueueAgentRun).not.toHaveBeenCalled();
    expect(db.select).not.toHaveBeenCalled();
  });

  it('rethrows when the comment-verification query itself fails (queue-mode retry contract)', async () => {
    vi.mocked(db.select).mockImplementationOnce(() => {
      throw new Error('verify boom');
    });

    await expect(handleTicketCommentedEvent(ticketCommentedEvent())).rejects.toThrow('verify boom');
    expect(createAndEnqueueAgentRun).not.toHaveBeenCalled();
  });

  // Compiles the join's `.where()` argument to real parameterized SQL —
  // same discipline as the loop-guard WHERE-clause test above. Proves the
  // predicate really does AND together every one of the seven claims
  // (id, ticket_id, org_id, origin, agent_run_id, is_public, deleted_at),
  // not just that SOME query ran.
  it('comment-verification WHERE clause scopes to the comment id, ticket id, org id, and every human/public/not-deleted condition', async () => {
    mockCommentVerification([{ createdAt: new Date('2026-09-10T11:00:00Z') }]);
    mockCleanTicket();

    await handleTicketCommentedEvent(ticketCommentedEvent());

    const whereArg = lastCommentVerifyWhereMock!.mock.calls[0]?.[0];
    const { sql: sqlText, params } = new PgDialect().sqlToQuery(whereArg as never);

    expect(sqlText).toBe(
      '($1 = $2 and $3 = $4 and $5 = $6 and $7 = $8 and $9 is null and $10 = $11 and $12 is null)',
    );
    expect(params).toEqual([
      'id', COMMENT_ID,
      'ticket_id', TICKET_ID,
      'org_id', ORG_ID,
      'origin_principal_kind', 'user',
      'agent_run_id',
      'is_public', true,
      'deleted_at',
    ]);
  });

  // #4212: per-event dedupe key — a SECOND human comment on the same ticket
  // gets its OWN key and can admit its own re-triage run, unlike the old
  // shared `ticket-created:<ticketId>` key which capped a ticket at one
  // triage run for life (the superseded "first-admitting-event-wins"
  // contract).
  it('a second human comment admits a second run under its own dedupe key (#4212)', async () => {
    mockCommentVerification([{ createdAt: new Date('2026-09-10T11:00:00Z') }]);
    mockCleanTicket();
    mockCommentVerification([{ createdAt: new Date('2026-09-10T13:00:00Z') }]);
    mockCleanTicket();

    await handleTicketCommentedEvent(ticketCommentedEvent({ payload: { ticketId: TICKET_ID, commentId: 'c1', isPublic: true } }));
    await handleTicketCommentedEvent(ticketCommentedEvent({ payload: { ticketId: TICKET_ID, commentId: 'c2', isPublic: true } }));

    expect(createAndEnqueueAgentRun).toHaveBeenCalledTimes(2);
    const dedupeKeys = createAndEnqueueAgentRun.mock.calls.map(
      ([input]) => (input as { dedupeKey: string }).dedupeKey,
    );
    expect(dedupeKeys).toEqual(['ticket-commented:c1', 'ticket-commented:c2']);
  });

  // The created lane's key is untouched by #4212 — only the commented lane
  // moved off the shared `ticket-created:<ticketId>` string.
  it('leaves the created lane key untouched (#4212)', async () => {
    mockCleanTicket();

    await handleTicketCreatedEvent(ticketCreatedEvent());

    expect(createAndEnqueueAgentRun).toHaveBeenCalledWith(
      expect.objectContaining({ dedupeKey: `ticket-created:${TICKET_ID}` }),
    );
  });
});

// -----------------------------------------------------------------------
// Task 9 (#4191): ticket.status_changed admission — ticket resolved with
// no resolution note and no active resolution-note draft.
// -----------------------------------------------------------------------
describe('handleTicketStatusChangedEvent', () => {
  it('admits a triage run when the ticket re-reads as resolved with no note and no active draft', async () => {
    mockResolvedTicketRead([{ status: 'resolved', resolutionNote: null }]);
    mockActiveResolutionDraftRead([]);
    // I1 (final review #4191): the resolved lane skips the loop guard
    // (loopGuard: 'skip') — no origin/recency probe. The per-ticket triage
    // ceiling (Task 9, #4212) is NOT skipped, so it still queues here, right
    // before the ticket-filter-context read — NOT `mockCleanTicket()`'s
    // shape (that would queue an origin-probe mock the handler never
    // consumes, starving the real next call and making this assertion pass
    // for the wrong reason).
    mockTriageRunCeilingRead([]);
    mockTicketFilterRead([{ category: 'hardware', categoryId: null, priority: 'normal' }]);

    await handleTicketStatusChangedEvent(ticketStatusChangedEvent());

    expect(createAndEnqueueAgentRun).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: ORG_ID,
        kind: 'helpdesk',
        triggerKind: 'ticket',
        ticketId: TICKET_ID,
        dedupeKey: `ticket-resolved:${TICKET_ID}`,
        profile: 'triage',
      }),
    );
    // Exactly 4 db.select calls total: the resolved-eligibility ticket
    // read, the active-draft read, the triage-run-ceiling read, and the
    // ticket-filter-context read — NO origin-guard probe. If the loop guard
    // were mistakenly re-applied to this lane, the handler would issue an
    // extra db.select() (the origin probe) BEFORE consuming the
    // `mockTriageRunCeilingRead`/`mockTicketFilterRead` mocks — starving them
    // and either throwing (queue exhausted) or reading the wrong shape, so
    // this count is itself the I1 regression assertion: prior agent-originated
    // activity on the ticket (an earlier triage note) can no longer block
    // this lane, because nothing here even asks the question.
    expect(db.select).toHaveBeenCalledTimes(4);
  });

  it('cheap prefilter: skips with NO db reads at all when the payload\'s `to` is not resolved', async () => {
    await handleTicketStatusChangedEvent(ticketStatusChangedEvent({ payload: { ticketId: TICKET_ID, from: 'new', to: 'open' } }));

    expect(createAndEnqueueAgentRun).not.toHaveBeenCalled();
    expect(db.select).not.toHaveBeenCalled();
  });

  it('re-reads fresh: skips when the ticket is no longer resolved by the time this handler runs, even though the payload says resolved', async () => {
    mockResolvedTicketRead([{ status: 'open', resolutionNote: null }]);

    await handleTicketStatusChangedEvent(ticketStatusChangedEvent());

    expect(createAndEnqueueAgentRun).not.toHaveBeenCalled();
    // Short-circuits before the active-draft read.
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it('skips when the ticket already has a resolution note', async () => {
    mockResolvedTicketRead([{ status: 'resolved', resolutionNote: 'Reimaged the workstation.' }]);

    await handleTicketStatusChangedEvent(ticketStatusChangedEvent());

    expect(createAndEnqueueAgentRun).not.toHaveBeenCalled();
  });

  it('skips when an active resolution_note draft already exists for the ticket', async () => {
    mockResolvedTicketRead([{ status: 'resolved', resolutionNote: null }]);
    mockActiveResolutionDraftRead([{ id: 'draft-1' }]);

    await handleTicketStatusChangedEvent(ticketStatusChangedEvent());

    expect(createAndEnqueueAgentRun).not.toHaveBeenCalled();
  });

  it('skips when the ticket is not found (or not in org) on re-read', async () => {
    mockResolvedTicketRead([]);

    await handleTicketStatusChangedEvent(ticketStatusChangedEvent());

    expect(createAndEnqueueAgentRun).not.toHaveBeenCalled();
  });

  it('does not throw and does not admit when the event payload has no ticketId', async () => {
    await expect(
      handleTicketStatusChangedEvent(ticketStatusChangedEvent({ payload: { to: 'resolved' } })),
    ).resolves.toBeUndefined();
    expect(createAndEnqueueAgentRun).not.toHaveBeenCalled();
    expect(db.select).not.toHaveBeenCalled();
  });

  it('rethrows when the resolved-eligibility read itself fails (queue-mode retry contract)', async () => {
    vi.mocked(db.select).mockImplementationOnce(() => {
      throw new Error('resolved-read boom');
    });

    await expect(handleTicketStatusChangedEvent(ticketStatusChangedEvent())).rejects.toThrow('resolved-read boom');
    expect(createAndEnqueueAgentRun).not.toHaveBeenCalled();
  });

  it('uses its OWN dedupe key (ticket-resolved:<id>), distinct from ticket-created/commented', async () => {
    mockResolvedTicketRead([{ status: 'resolved', resolutionNote: null }]);
    mockActiveResolutionDraftRead([]);
    // I1: no origin/recency probe — see the earlier admission test's comment
    // for why `mockCleanTicket()`'s shape is not used here. The triage-run
    // ceiling (#4212) still applies unconditionally.
    mockTriageRunCeilingRead([]);
    mockTicketFilterRead([{ category: 'hardware', categoryId: null, priority: 'normal' }]);

    await handleTicketStatusChangedEvent(ticketStatusChangedEvent());

    const [input] = createAndEnqueueAgentRun.mock.calls[0]!;
    expect((input as { dedupeKey: string }).dedupeKey).toBe(`ticket-resolved:${TICKET_ID}`);
    expect((input as { dedupeKey: string }).dedupeKey).not.toBe(`ticket-created:${TICKET_ID}`);
  });
});

// -----------------------------------------------------------------------
// Task 9 (#4212): hard per-ticket re-triage ceiling — an absolute backstop
// independent of the loop guard and of runService.ts's per-AGENT caps.
// -----------------------------------------------------------------------
describe('per-ticket triage-run ceiling (#4212)', () => {
  it('stops admitting after MAX_TRIAGE_RUNS_PER_TICKET runs on one ticket', async () => {
    mockCommentVerification([{ createdAt: new Date('2026-09-10T11:00:00Z') }]);
    mockOriginProbe([]);
    mockTriageRunCeilingRead(
      Array.from({ length: MAX_TRIAGE_RUNS_PER_TICKET }, (_, i) => ({ id: `run-${i}` })),
    );

    await handleTicketCommentedEvent(ticketCommentedEvent({ payload: { ticketId: TICKET_ID, commentId: 'c9', isPublic: true } }));

    expect(createAndEnqueueAgentRun).not.toHaveBeenCalled();
  });

  it('still admits below the ceiling', async () => {
    mockCommentVerification([{ createdAt: new Date('2026-09-10T11:00:00Z') }]);
    mockOriginProbe([]);
    mockTriageRunCeilingRead(
      Array.from({ length: MAX_TRIAGE_RUNS_PER_TICKET - 1 }, (_, i) => ({ id: `run-${i}` })),
    );
    mockTicketFilterRead([{ category: 'hardware', categoryId: null, priority: 'normal' }]);

    await handleTicketCommentedEvent(ticketCommentedEvent({ payload: { ticketId: TICKET_ID, commentId: 'c9', isPublic: true } }));

    expect(createAndEnqueueAgentRun).toHaveBeenCalled();
  });

  it('counts denied rather than admitting when the ceiling read throws (fail-closed)', async () => {
    mockCommentVerification([{ createdAt: new Date('2026-09-10T11:00:00Z') }]);
    mockOriginProbe([]);
    vi.mocked(db.select).mockImplementationOnce(() => {
      throw new Error('boom');
    });

    await handleTicketCommentedEvent(ticketCommentedEvent({ payload: { ticketId: TICKET_ID, commentId: 'c9', isPublic: true } }));

    expect(createAndEnqueueAgentRun).not.toHaveBeenCalled();
  });
});

describe('AI time-entry proposal claim forwarding (#4177, W04)', () => {
  beforeEach(() => {
    proposeTimeEntryFromOutboxClaim.mockReset();
    proposeTimeEntryFromOutboxClaim.mockResolvedValue(null);
  });

  const claim = { draftId: '00000000-0000-4000-8000-0000000000d1', runId: '00000000-0000-4000-8000-0000000000d2', trigger: 'draft_sent' };

  it('ticket.commented with an aiDraft claim forwards it, then still runs admission', async () => {
    mockCommentVerification([{ createdAt: new Date('2026-09-10T11:00:00Z') }]);
    mockCleanTicket();

    await handleTicketCommentedEvent(ticketCommentedEvent({ payload: { ticketId: TICKET_ID, commentId: COMMENT_ID, isPublic: true, aiDraft: claim } }));

    expect(proposeTimeEntryFromOutboxClaim).toHaveBeenCalledWith({ orgId: ORG_ID, ticketId: TICKET_ID, claim });
    expect(createAndEnqueueAgentRun).toHaveBeenCalled();
  });

  it('ticket.commented without a claim never touches the proposal lane', async () => {
    mockCommentVerification([{ createdAt: new Date('2026-09-10T11:00:00Z') }]);
    mockCleanTicket();
    await handleTicketCommentedEvent(ticketCommentedEvent());
    expect(proposeTimeEntryFromOutboxClaim).not.toHaveBeenCalled();
  });

  it('ticket.status_changed with a claim forwards it even when the transition is not to resolved', async () => {
    await handleTicketStatusChangedEvent(ticketStatusChangedEvent({
      payload: { ticketId: TICKET_ID, from: 'resolved', to: 'closed', aiDraft: { ...claim, trigger: 'resolved_with_ai_note' } },
    }));
    expect(proposeTimeEntryFromOutboxClaim).toHaveBeenCalledWith({
      orgId: ORG_ID, ticketId: TICKET_ID, claim: { ...claim, trigger: 'resolved_with_ai_note' },
    });
    expect(createAndEnqueueAgentRun).not.toHaveBeenCalled();
  });

  it('an infrastructure error from the proposal lane propagates so the subscriber retry fires', async () => {
    proposeTimeEntryFromOutboxClaim.mockRejectedValueOnce(new Error('pool timeout'));
    await expect(
      handleTicketCommentedEvent(ticketCommentedEvent({ payload: { ticketId: TICKET_ID, commentId: COMMENT_ID, isPublic: true, aiDraft: claim } })),
    ).rejects.toThrow('pool timeout');
    expect(createAndEnqueueAgentRun).not.toHaveBeenCalled();
  });

  it('a malformed event (no ticketId) is dropped before the claim is ever forwarded', async () => {
    await handleTicketCommentedEvent(ticketCommentedEvent({ payload: { commentId: COMMENT_ID, aiDraft: claim } }));
    expect(proposeTimeEntryFromOutboxClaim).not.toHaveBeenCalled();
  });
});
