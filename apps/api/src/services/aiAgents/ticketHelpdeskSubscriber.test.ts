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
}));

const createAndEnqueueAgentRun = vi.hoisted(() => vi.fn());
vi.mock('./runService', () => ({ createAndEnqueueAgentRun }));

import { db, withSystemDbAccessContext } from '../../db';
import type { BreezeEvent } from '../eventBus';
import {
  handleTicketCreatedEvent,
  handleTicketCommentedEvent,
  handleTicketStatusChangedEvent,
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

/** db.select().from().where().limit() -> rows (the origin-guard probe). Must
 *  be queued FIRST — it is the first `db.select()` call the handler makes. */
function mockOriginProbe(rows: unknown[]) {
  const whereMock = vi.fn().mockReturnValue({
    limit: vi.fn().mockResolvedValue(rows),
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

/** The common "admission proceeds" setup: no agent-originated activity, and
 *  the ticket exists in-org with the given category/categoryId/priority. */
function mockCleanTicket(overrides: Partial<{ category: string | null; categoryId: string | null; priority: string }> = {}) {
  mockOriginProbe([]);
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

  it('loop guard: skips admission when a prior comment on the ticket is agent-originated', async () => {
    mockOriginProbe([{ id: 'comment-1' }]);

    await handleTicketCreatedEvent(ticketCreatedEvent());

    expect(createAndEnqueueAgentRun).not.toHaveBeenCalled();
    // The loop guard short-circuits BEFORE the ticket-filter-context read —
    // only the origin probe's one `db.select()` call is ever made.
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it('skips admission when the ticket is not found (or not in org) — no filter context to admit against', async () => {
    mockOriginProbe([]);
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

  it('rethrows when the origin-guard probe itself fails (queue-mode retry contract)', async () => {
    vi.mocked(db.select).mockImplementationOnce(() => {
      throw new Error('boom');
    });

    await expect(handleTicketCreatedEvent(ticketCreatedEvent())).rejects.toThrow('boom');
    expect(createAndEnqueueAgentRun).not.toHaveBeenCalled();
  });

  it('rethrows when the ticket-filter-context read itself fails (queue-mode retry contract)', async () => {
    mockOriginProbe([]);
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
// Task 9 (#4191): ticket.commented admission — first genuinely-human
// comment on a ticket.
// -----------------------------------------------------------------------
describe('handleTicketCommentedEvent', () => {
  it('admits a triage run when the comment DB-verifies as human/public and matches the ticket/org, using the SAME dedupe key as ticket.created', async () => {
    mockCommentVerification([{ id: COMMENT_ID }]);
    mockCleanTicket();

    await handleTicketCommentedEvent(ticketCommentedEvent());

    expect(createAndEnqueueAgentRun).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: ORG_ID,
        kind: 'helpdesk',
        triggerKind: 'ticket',
        ticketId: TICKET_ID,
        dedupeKey: `ticket-created:${TICKET_ID}`,
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

  it('loop guard is still consulted after comment verification passes', async () => {
    mockCommentVerification([{ id: COMMENT_ID }]);
    mockOriginProbe([{ id: 'prior-agent-comment' }]); // ticket already has agent-originated activity

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
    mockCommentVerification([{ id: COMMENT_ID }]);
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

  // Dedupe first-wins contract (brief step 1): `ticket.created` then
  // `ticket.commented` for the SAME ticket both pass the identical dedupe
  // key — admission itself (createAndEnqueueAgentRun, mocked here) is what
  // collapses the second call into a no-op, exactly like the existing
  // duplicate-ticket.created test above.
  it('dedupe first-wins: ticket.created then ticket.commented use the SAME dedupe key', async () => {
    mockCleanTicket();
    mockCommentVerification([{ id: COMMENT_ID }]);
    mockCleanTicket();
    createAndEnqueueAgentRun
      .mockResolvedValueOnce({ created: true, run: { id: 'run-1' } })
      .mockResolvedValueOnce({ created: false, skipped: 'duplicate' });

    await handleTicketCreatedEvent(ticketCreatedEvent());
    await handleTicketCommentedEvent(ticketCommentedEvent());

    expect(createAndEnqueueAgentRun).toHaveBeenCalledTimes(2);
    const dedupeKeys = createAndEnqueueAgentRun.mock.calls.map(
      ([input]) => (input as { dedupeKey: string }).dedupeKey,
    );
    expect(dedupeKeys).toEqual([`ticket-created:${TICKET_ID}`, `ticket-created:${TICKET_ID}`]);
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
    // I1 (final review #4191): the resolved lane skips the origin-guard
    // probe (applyLoopGuard=false) — only the ticket-filter-context read
    // remains, NOT `mockCleanTicket()`'s two-call shape (that would queue an
    // origin-probe mock the handler never consumes, starving the real next
    // call and making this assertion pass for the wrong reason).
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
    // Exactly 3 db.select calls total: the resolved-eligibility ticket
    // read, the active-draft read, and the ticket-filter-context read — NO
    // origin-guard probe. If the guard were mistakenly re-applied to this
    // lane, the handler would issue a 4th db.select() (the origin probe)
    // BEFORE consuming the `mockTicketFilterRead` mock — starving it and
    // either throwing (queue exhausted) or reading the wrong shape, so this
    // count is itself the I1 regression assertion: prior agent-originated
    // activity on the ticket (an earlier triage note) can no longer block
    // this lane, because nothing here even asks the question.
    expect(db.select).toHaveBeenCalledTimes(3);
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
    // I1: single ticket-filter-context read only — see the earlier admission
    // test's comment for why `mockCleanTicket()`'s origin-probe mock is not
    // used here.
    mockTicketFilterRead([{ category: 'hardware', categoryId: null, priority: 'normal' }]);

    await handleTicketStatusChangedEvent(ticketStatusChangedEvent());

    const [input] = createAndEnqueueAgentRun.mock.calls[0]!;
    expect((input as { dedupeKey: string }).dedupeKey).toBe(`ticket-resolved:${TICKET_ID}`);
    expect((input as { dedupeKey: string }).dedupeKey).not.toBe(`ticket-created:${TICKET_ID}`);
  });
});
