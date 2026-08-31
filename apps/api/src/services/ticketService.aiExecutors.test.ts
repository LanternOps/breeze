import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

// P2-4 (#4191). Real drizzle-orm + REAL schema throughout this suite
// (deliberately NOT mocked, unlike ticketService.test.ts's flat-string
// `../db/schema` mock) — the CAS predicate in `applyAiFieldUpdates` is
// security/correctness-critical (it is the ONLY thing standing between an
// autonomous AI write and clobbering a human-set field or a concurrent
// change), so it is asserted on COMPILED SQL via
// `new PgDialect().sqlToQuery(...)`, matching `deviceUninstallDrain.test.ts`'s
// precedent and the vacuous-Drizzle-assertion rule (CLAUDE.md): a mock that
// only echoes back whatever `.set()` was called with would pass identically
// whether the code wrote `IS NOT DISTINCT FROM` or `=`, or compared the
// wrong column.
const dialect = new PgDialect();
function sqlOf(fragment: unknown) {
  return dialect.sqlToQuery(fragment as never);
}

const { emitMock, auditMock, dbState } = vi.hoisted(() => ({
  emitMock: vi.fn().mockResolvedValue(undefined),
  auditMock: vi.fn().mockResolvedValue(undefined),
  dbState: {
    // table identity -> queue of row-arrays, shifted per select call.
    selectQueues: new Map<unknown, unknown[][]>(),
    updateReturningQueue: [] as unknown[][],
    insertReturningQueue: [] as Array<unknown[] | Error>,
  },
}));

vi.mock('./ticketEvents', () => ({ emitTicketEvent: emitMock }));
vi.mock('./auditService', () => ({ createAuditLogAsync: auditMock }));

const setMock = vi.fn();
const updateWhereMock = vi.fn();
const insertValuesMock = vi.fn();
const selectWhereMock = vi.fn();

vi.mock('../db', () => ({
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  db: {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn((w: unknown) => {
          selectWhereMock(w);
          return {
            limit: vi.fn(() => {
              const queue = dbState.selectQueues.get(table) ?? [];
              return Promise.resolve(queue.shift() ?? []);
            }),
          };
        }),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((v: unknown) => {
        setMock(v);
        return {
          where: vi.fn((w: unknown) => {
            updateWhereMock(w);
            return {
              returning: vi.fn(() => Promise.resolve(dbState.updateReturningQueue.shift() ?? [])),
            };
          }),
        };
      }),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((v: unknown) => {
        insertValuesMock(v);
        return {
          returning: vi.fn(() => {
            const next = dbState.insertReturningQueue.shift();
            if (next instanceof Error) return Promise.reject(next);
            return Promise.resolve(next ?? []);
          }),
        };
      }),
    })),
  },
}));

import { tickets, ticketComments, ticketCategories } from '../db/schema';
import {
  addAiTriageNote,
  applyAiFieldUpdates,
  updateTicketFields,
  TicketServiceError,
  type TicketActor,
} from './ticketService';

function queueSelect(table: unknown, rows: unknown[]) {
  if (!dbState.selectQueues.has(table)) dbState.selectQueues.set(table, []);
  dbState.selectQueues.get(table)!.push(rows);
}

beforeEach(() => {
  vi.clearAllMocks();
  dbState.selectQueues.clear();
  dbState.updateReturningQueue.length = 0;
  dbState.insertReturningQueue.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

const TICKET_ID = '11111111-1111-1111-1111-111111111111';
const ORG_ID = '22222222-2222-2222-2222-222222222222';
const PARTNER_ID = '33333333-3333-3333-3333-333333333333';
const CATEGORY_ID = '44444444-4444-4444-4444-444444444444';
const RUN_ID = '55555555-5555-5555-5555-555555555555';

describe('applyAiFieldUpdates — CAS predicate (P2-4, #4191)', () => {
  it('compiles a CAS predicate requiring both value-unchanged (IS NOT DISTINCT FROM) and no human stamp', async () => {
    queueSelect(tickets, [{ id: TICKET_ID, orgId: ORG_ID, partnerId: PARTNER_ID }]);
    queueSelect(ticketCategories, [{ id: CATEGORY_ID, partnerId: PARTNER_ID, responseSlaMinutes: null, resolutionSlaMinutes: null }]);
    dbState.updateReturningQueue.push([{ categoryId: CATEGORY_ID, priority: 'high', fieldProvenance: { categoryId: 'ai_agent', priority: 'ai_agent' } }]);

    await applyAiFieldUpdates(
      TICKET_ID,
      ORG_ID,
      {
        categoryId: { value: CATEGORY_ID, expectedCurrent: null },
        priority: { value: 'high', expectedCurrent: 'normal' },
      },
      RUN_ID,
    );

    const setArg = setMock.mock.calls[0]![0] as Record<string, unknown>;
    const categorySql = sqlOf(setArg.categoryId).sql.toLowerCase();
    expect(categorySql).toContain('case when');
    expect(categorySql).toContain('is not distinct from');
    expect(categorySql).toContain('coalesce');
    expect(categorySql).toContain('<>');

    const provenanceSql = sqlOf(setArg.fieldProvenance).sql.toLowerCase();
    expect(provenanceSql).toContain('||');
    expect(provenanceSql).toContain('case when');

    const whereSql = sqlOf(updateWhereMock.mock.calls[0]![0]);
    expect(whereSql.sql.toLowerCase()).toContain('"org_id" = $');
  });

  it('CAS skips a human-set field: DB reports the value unchanged and provenance still "user"', async () => {
    queueSelect(tickets, [{ id: TICKET_ID, orgId: ORG_ID, partnerId: PARTNER_ID }]);
    queueSelect(ticketCategories, [{ id: CATEGORY_ID, partnerId: PARTNER_ID, responseSlaMinutes: null, resolutionSlaMinutes: null }]);
    // DB simulates: the CASE WHEN did NOT fire — category_id stayed at its
    // prior human-set value, and field_provenance was left untouched ('user').
    dbState.updateReturningQueue.push([{ categoryId: 'human-chosen-category', priority: 'normal', fieldProvenance: { categoryId: 'user' } }]);

    const result = await applyAiFieldUpdates(
      TICKET_ID,
      ORG_ID,
      { categoryId: { value: CATEGORY_ID, expectedCurrent: 'human-chosen-category' } },
      RUN_ID,
    );

    expect(result.categoryId).toEqual({ applied: false, skipped: 'human_set' });
  });

  it('CAS skips on a concurrent value change: expectedCurrent no longer matches, provenance is not "user"', async () => {
    queueSelect(tickets, [{ id: TICKET_ID, orgId: ORG_ID, partnerId: PARTNER_ID }]);
    // DB simulates: someone else's concurrent AI/system write already moved
    // priority away from what this caller expected; provenance stayed 'ai_agent'
    // (not 'user'), so this is a concurrent-change skip, not a human_set skip.
    dbState.updateReturningQueue.push([{ categoryId: null, priority: 'urgent', fieldProvenance: { priority: 'ai_agent' } }]);

    const result = await applyAiFieldUpdates(
      TICKET_ID,
      ORG_ID,
      { priority: { value: 'high', expectedCurrent: 'normal' } },
      RUN_ID,
    );

    expect(result.priority).toEqual({ applied: false, skipped: 'concurrent_change' });
  });

  it('applies when the CAS condition holds (DB reports the new value + ai_agent stamp)', async () => {
    queueSelect(tickets, [{ id: TICKET_ID, orgId: ORG_ID, partnerId: PARTNER_ID }]);
    dbState.updateReturningQueue.push([{ categoryId: null, priority: 'high', fieldProvenance: { priority: 'ai_agent' } }]);

    const result = await applyAiFieldUpdates(
      TICKET_ID,
      ORG_ID,
      { priority: { value: 'high', expectedCurrent: 'normal' } },
      RUN_ID,
    );

    expect(result.priority).toEqual({ applied: true });
  });

  it('validates categoryId against ticket_categories for the ticket\'s PARTNER before writing', async () => {
    queueSelect(tickets, [{ id: TICKET_ID, orgId: ORG_ID, partnerId: PARTNER_ID }]);
    // Category belongs to a DIFFERENT partner — must fail closed, never reach the UPDATE.
    queueSelect(ticketCategories, [{ id: CATEGORY_ID, partnerId: 'other-partner', responseSlaMinutes: null, resolutionSlaMinutes: null }]);

    await expect(
      applyAiFieldUpdates(TICKET_ID, ORG_ID, { categoryId: { value: CATEGORY_ID, expectedCurrent: null } }, RUN_ID),
    ).rejects.toThrow(TicketServiceError);
    expect(setMock).not.toHaveBeenCalled();
  });

  it('404s when the ticket is not found in the given org (tenancy guard)', async () => {
    queueSelect(tickets, []);
    await expect(
      applyAiFieldUpdates(TICKET_ID, ORG_ID, { priority: { value: 'high', expectedCurrent: 'normal' } }, RUN_ID),
    ).rejects.toThrow(TicketServiceError);
  });

  it('409s when the UPDATE matches zero rows (ticket disappeared mid-flight)', async () => {
    queueSelect(tickets, [{ id: TICKET_ID, orgId: ORG_ID, partnerId: PARTNER_ID }]);
    dbState.updateReturningQueue.push([]);
    await expect(
      applyAiFieldUpdates(TICKET_ID, ORG_ID, { priority: { value: 'high', expectedCurrent: 'normal' } }, RUN_ID),
    ).rejects.toThrow(TicketServiceError);
  });
});

describe('addAiTriageNote — AI-origin internal comment (P2-4, #4191)', () => {
  it('inserts an internal, non-public comment with no users-FK id and the AI origin columns stamped', async () => {
    queueSelect(tickets, [{ id: TICKET_ID, orgId: ORG_ID, partnerId: PARTNER_ID }]);
    dbState.insertReturningQueue.push([{ id: 'comment-1' }]);

    const result = await addAiTriageNote(TICKET_ID, RUN_ID, 'The disk is at 95% capacity.', ORG_ID);

    expect(result).toEqual({ comment: { id: 'comment-1' } });
    const insertArg = insertValuesMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(insertArg).toMatchObject({
      ticketId: TICKET_ID,
      userId: null,
      portalUserId: null,
      authorType: 'ai_agent',
      commentType: 'internal',
      isPublic: false,
      originPrincipalKind: 'ai_agent',
      agentRunId: RUN_ID,
    });
  });

  it('emits ticket.commented — the loop guard is origin-based, not a suppression of this event', async () => {
    queueSelect(tickets, [{ id: TICKET_ID, orgId: ORG_ID, partnerId: PARTNER_ID }]);
    dbState.insertReturningQueue.push([{ id: 'comment-1' }]);

    await addAiTriageNote(TICKET_ID, RUN_ID, 'note', ORG_ID);

    expect(emitMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'ticket.commented', ticketId: TICKET_ID }));
  });

  it('is idempotent per run: a unique-violation retry returns the EXISTING row instead of erroring', async () => {
    queueSelect(tickets, [{ id: TICKET_ID, orgId: ORG_ID, partnerId: PARTNER_ID }]);
    dbState.insertReturningQueue.push(Object.assign(new Error('duplicate key'), { code: '23505' }));
    queueSelect(ticketComments, [{ id: 'existing-comment' }]);

    const result = await addAiTriageNote(TICKET_ID, RUN_ID, 'note', ORG_ID);

    expect(result).toEqual({ comment: { id: 'existing-comment' } });
    // Must not have emitted a SECOND ticket.commented for the duplicate attempt.
    expect(emitMock).not.toHaveBeenCalled();
  });

  it('404s when the ticket does not belong to the given org (tenancy guard)', async () => {
    queueSelect(tickets, [{ id: TICKET_ID, orgId: 'some-other-org', partnerId: PARTNER_ID }]);
    await expect(addAiTriageNote(TICKET_ID, RUN_ID, 'note', ORG_ID)).rejects.toThrow(TicketServiceError);
  });
});

describe('updateTicketFields — field_provenance stamped in the same UPDATE (P2-4, #4191)', () => {
  const actor: TicketActor = { userId: 'user-1', name: 'Tess Tech' };

  it('stamps field_provenance for every changed field, in the SAME .set() call as the field write', async () => {
    queueSelect(tickets, [{
      id: TICKET_ID, orgId: ORG_ID, partnerId: PARTNER_ID, subject: 'old subject',
      description: null, categoryId: null, priority: 'normal', dueDate: null,
      responseSlaMinutes: null, resolutionSlaMinutes: null, deviceId: null, tags: [],
    }]);
    dbState.updateReturningQueue.push([{ id: TICKET_ID, subject: 'new subject', orgId: ORG_ID, partnerId: PARTNER_ID }]);

    await updateTicketFields(TICKET_ID, { subject: 'new subject' }, actor);

    // Exactly ONE .set() call carries BOTH the field write and its provenance
    // stamp — not two separate statements (would defeat "in the same
    // transaction/statement" for the human-set-field authority).
    expect(setMock).toHaveBeenCalledTimes(1);
    const setArg = setMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(setArg.subject).toBe('new subject');
    const provenanceSql = sqlOf(setArg.fieldProvenance);
    expect(provenanceSql.sql.toLowerCase()).toContain('||');
    expect(provenanceSql.params).toContain(JSON.stringify({ subject: 'user' }));
  });

  it('defaults principalKind to "user" when the actor does not specify one', async () => {
    queueSelect(tickets, [{
      id: TICKET_ID, orgId: ORG_ID, partnerId: PARTNER_ID, subject: 'old subject',
      description: null, categoryId: null, priority: 'normal', dueDate: null,
      responseSlaMinutes: null, resolutionSlaMinutes: null, deviceId: null, tags: [],
    }]);
    dbState.updateReturningQueue.push([{ id: TICKET_ID, subject: 'new subject' }]);

    await updateTicketFields(TICKET_ID, { subject: 'new subject' }, actor);

    const setArg = setMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(sqlOf(setArg.fieldProvenance).params).toContain(JSON.stringify({ subject: 'user' }));
  });
});
