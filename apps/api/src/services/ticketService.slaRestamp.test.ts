import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

// #6691 — SLA targets restamp on a category/priority change while the ticket
// is unanswered (first_response_at IS NULL) and not resolved/closed. D2 of
// docs/superpowers/plans/ticketing/2026-06-11-ticketing-sla-engine.md is
// amended for exactly that window; explicit (`field_provenance = 'user'`)
// targets survive. Real drizzle-orm + REAL schema (same harness as
// ticketService.aiExecutors.test.ts) so the AI path's guarded restamp UPDATE
// can be asserted on COMPILED SQL rather than on echoed mock arguments.
const dialect = new PgDialect();
function sqlOf(fragment: unknown) {
  return dialect.sqlToQuery(fragment as never);
}

const { emitMock, auditMock, feedbackMock, configMocks, dbState } = vi.hoisted(() => ({
  emitMock: vi.fn().mockResolvedValue(undefined),
  auditMock: vi.fn().mockResolvedValue(undefined),
  feedbackMock: vi.fn().mockResolvedValue(undefined),
  configMocks: {
    getOrgSlaOverride: vi.fn(),
    getPartnerPrioritySla: vi.fn(),
    getSystemStatusId: vi.fn().mockResolvedValue(null),
    getTicketStatusById: vi.fn().mockResolvedValue(null),
  },
  dbState: {
    selectQueues: new Map<unknown, unknown[][]>(),
    updateReturningQueue: [] as unknown[][],
  },
}));

vi.mock('./ticketEvents', () => ({ emitTicketEvent: emitMock }));
vi.mock('./auditService', () => ({ createAuditLogAsync: auditMock }));
vi.mock('./mlFeedbackEmitters', () => ({ emitTicketTriageFeedback: feedbackMock }));
vi.mock('./ticketConfigService', () => ({
  getOrgSlaOverride: (...a: unknown[]) => configMocks.getOrgSlaOverride(...a),
  getPartnerPrioritySla: (...a: unknown[]) => configMocks.getPartnerPrioritySla(...a),
  getSystemStatusId: (...a: unknown[]) => configMocks.getSystemStatusId(...a),
  getTicketStatusById: (...a: unknown[]) => configMocks.getTicketStatusById(...a),
}));

const setMock = vi.fn();
const updateWhereMock = vi.fn();
const insertValuesMock = vi.fn();

vi.mock('../db', () => {
  const dbMock: Record<string, unknown> = {
    transaction: vi.fn((fn: (tx: unknown) => unknown) => fn(dbMock)),
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => {
            const queue = dbState.selectQueues.get(table) ?? [];
            return Promise.resolve(queue.shift() ?? []);
          }),
        })),
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
        return { returning: vi.fn(() => Promise.resolve([])) };
      }),
    })),
  };
  return {
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
    db: dbMock,
  };
});

import { tickets, ticketCategories } from '../db/schema';
import { applyAiFieldUpdates, updateTicketFields, type TicketActor } from './ticketService';

function queueSelect(table: unknown, rows: unknown[]) {
  if (!dbState.selectQueues.has(table)) dbState.selectQueues.set(table, []);
  dbState.selectQueues.get(table)!.push(rows);
}

const TICKET_ID = '11111111-1111-1111-1111-111111111111';
const ORG_ID = '22222222-2222-2222-2222-222222222222';
const PARTNER_ID = '33333333-3333-3333-3333-333333333333';
const CATEGORY_ID = '44444444-4444-4444-4444-444444444444';
const OTHER_CATEGORY_ID = '66666666-6666-6666-6666-666666666666';
const RUN_ID = '55555555-5555-5555-5555-555555555555';

const actor: TicketActor = { userId: 'user-1', name: 'Tess Tech' };

// An uncategorised, unanswered email ticket still on the default (normal = none) SLA.
const UNANSWERED = {
  id: TICKET_ID, orgId: ORG_ID, partnerId: PARTNER_ID, subject: 'Printer offline',
  description: null, categoryId: null, priority: 'normal', dueDate: null,
  responseSlaMinutes: null, resolutionSlaMinutes: null, deviceId: null, tags: [],
  status: 'new', firstResponseAt: null, workKind: 'support', fieldProvenance: {},
};

function queueCategory(id: string, responseSlaMinutes: number | null, resolutionSlaMinutes: number | null) {
  queueSelect(ticketCategories, [{ id, partnerId: PARTNER_ID, responseSlaMinutes, resolutionSlaMinutes }]);
}

beforeEach(() => {
  vi.clearAllMocks();
  dbState.selectQueues.clear();
  dbState.updateReturningQueue.length = 0;
  configMocks.getOrgSlaOverride.mockResolvedValue({ responseMinutes: null, resolutionMinutes: null });
  configMocks.getPartnerPrioritySla.mockResolvedValue({ responseMinutes: null, resolutionMinutes: null });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('updateTicketFields — SLA restamp before first response (#6691)', () => {
  it('(a) setting a category on an uncategorised, unanswered ticket stamps the category targets', async () => {
    queueSelect(tickets, [UNANSWERED]);
    queueCategory(CATEGORY_ID, 30, 480);
    dbState.updateReturningQueue.push([{ ...UNANSWERED, categoryId: CATEGORY_ID }]);

    await updateTicketFields(TICKET_ID, { categoryId: CATEGORY_ID }, actor);

    expect(setMock).toHaveBeenCalledTimes(1);
    const setArg = setMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(setArg.categoryId).toBe(CATEGORY_ID);
    expect(setArg.responseSlaMinutes).toBe(30);
    expect(setArg.resolutionSlaMinutes).toBe(480);
    // Restamped targets are NOT a human override: only categoryId is stamped 'user'.
    const provenance = sqlOf(setArg.fieldProvenance);
    expect(provenance.params).toContain(JSON.stringify({ categoryId: 'user' }));
    // Breach state is never touched by a restamp.
    expect(setArg).not.toHaveProperty('slaBreachedAt');
    expect(setArg).not.toHaveProperty('slaBreachReason');
    // Same timeline/event path as any other field change.
    expect(insertValuesMock.mock.calls[0]![0]).toMatchObject({
      commentType: 'system',
      content: 'Updated category, response SLA, resolution SLA',
    });
    expect(emitMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'ticket.updated',
      payload: { changed: ['categoryId', 'responseSlaMinutes', 'resolutionSlaMinutes'] },
    }));
  });

  it('(b) a priority change on an unanswered ticket applies the org → partner priority chain', async () => {
    queueSelect(tickets, [UNANSWERED]);
    configMocks.getOrgSlaOverride.mockResolvedValue({ responseMinutes: 45, resolutionMinutes: null });
    configMocks.getPartnerPrioritySla.mockResolvedValue({ responseMinutes: 90, resolutionMinutes: 600 });
    dbState.updateReturningQueue.push([{ ...UNANSWERED, priority: 'high' }]);

    await updateTicketFields(TICKET_ID, { priority: 'high' }, actor);

    expect(configMocks.getOrgSlaOverride).toHaveBeenCalledWith(ORG_ID, 'high');
    expect(configMocks.getPartnerPrioritySla).toHaveBeenCalledWith(PARTNER_ID, 'high');
    const setArg = setMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(setArg.priority).toBe('high');
    expect(setArg.responseSlaMinutes).toBe(45);
    expect(setArg.resolutionSlaMinutes).toBe(600);
  });

  it('a priority change keeps the ticket\'s existing category as the first link of the chain', async () => {
    queueSelect(tickets, [{ ...UNANSWERED, categoryId: CATEGORY_ID, responseSlaMinutes: 30, resolutionSlaMinutes: null }]);
    queueCategory(CATEGORY_ID, 30, null);
    configMocks.getPartnerPrioritySla.mockResolvedValue({ responseMinutes: 90, resolutionMinutes: 600 });
    dbState.updateReturningQueue.push([{ ...UNANSWERED, priority: 'urgent' }]);

    await updateTicketFields(TICKET_ID, { priority: 'urgent' }, actor);

    const setArg = setMock.mock.calls[0]![0] as Record<string, unknown>;
    // response: category 30 unchanged → not in the patch; resolution: partner 600.
    expect(setArg).not.toHaveProperty('responseSlaMinutes');
    expect(setArg.resolutionSlaMinutes).toBe(600);
  });

  it('(c) no restamp once the ticket has a first response', async () => {
    queueSelect(tickets, [{ ...UNANSWERED, firstResponseAt: new Date('2026-09-01T10:00:00Z') }]);
    queueCategory(CATEGORY_ID, 30, 480);
    dbState.updateReturningQueue.push([{ ...UNANSWERED, categoryId: CATEGORY_ID }]);

    await updateTicketFields(TICKET_ID, { categoryId: CATEGORY_ID, priority: 'urgent' }, actor);

    const setArg = setMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(setArg.categoryId).toBe(CATEGORY_ID);
    expect(setArg).not.toHaveProperty('responseSlaMinutes');
    expect(setArg).not.toHaveProperty('resolutionSlaMinutes');
    expect(configMocks.getOrgSlaOverride).not.toHaveBeenCalled();
  });

  it.each(['resolved', 'closed'])('(d) no restamp on a %s ticket', async (status) => {
    queueSelect(tickets, [{ ...UNANSWERED, status }]);
    queueCategory(CATEGORY_ID, 30, 480);
    dbState.updateReturningQueue.push([{ ...UNANSWERED, categoryId: CATEGORY_ID }]);

    await updateTicketFields(TICKET_ID, { categoryId: CATEGORY_ID }, actor);

    const setArg = setMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(setArg).not.toHaveProperty('responseSlaMinutes');
    expect(setArg).not.toHaveProperty('resolutionSlaMinutes');
  });

  it('(e) a user-set response target survives; the resolution target is restamped', async () => {
    queueSelect(tickets, [{
      ...UNANSWERED, responseSlaMinutes: 15, fieldProvenance: { responseSlaMinutes: 'user' },
    }]);
    queueCategory(CATEGORY_ID, 30, 480);
    dbState.updateReturningQueue.push([{ ...UNANSWERED, categoryId: CATEGORY_ID }]);

    await updateTicketFields(TICKET_ID, { categoryId: CATEGORY_ID }, actor);

    const setArg = setMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(setArg).not.toHaveProperty('responseSlaMinutes');
    expect(setArg.resolutionSlaMinutes).toBe(480);
  });

  it('(f) an explicit SLA value in the same PATCH wins over the restamp and takes user provenance', async () => {
    queueSelect(tickets, [UNANSWERED]);
    queueCategory(CATEGORY_ID, 30, 480);
    dbState.updateReturningQueue.push([{ ...UNANSWERED, categoryId: CATEGORY_ID }]);

    await updateTicketFields(TICKET_ID, { categoryId: CATEGORY_ID, responseSlaMinutes: 10 }, actor);

    const setArg = setMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(setArg.responseSlaMinutes).toBe(10);
    expect(setArg.resolutionSlaMinutes).toBe(480);
    const provenance = sqlOf(setArg.fieldProvenance);
    expect(provenance.params).toContain(JSON.stringify({ categoryId: 'user', responseSlaMinutes: 'user' }));
  });

  it('no restamp when neither category nor priority actually changes', async () => {
    queueSelect(tickets, [{ ...UNANSWERED, categoryId: CATEGORY_ID }]);
    queueCategory(CATEGORY_ID, 30, 480);
    dbState.updateReturningQueue.push([{ ...UNANSWERED, subject: 'x' }]);

    await updateTicketFields(TICKET_ID, { categoryId: CATEGORY_ID, priority: 'normal', subject: 'x' }, actor);

    const setArg = setMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(setArg).not.toHaveProperty('responseSlaMinutes');
    expect(setArg).not.toHaveProperty('resolutionSlaMinutes');
    expect(configMocks.getOrgSlaOverride).not.toHaveBeenCalled();
  });

  it('clearing the category falls back to the org/partner/default chain', async () => {
    queueSelect(tickets, [{ ...UNANSWERED, categoryId: CATEGORY_ID, priority: 'urgent', responseSlaMinutes: 30, resolutionSlaMinutes: 480 }]);
    dbState.updateReturningQueue.push([{ ...UNANSWERED, categoryId: null }]);

    await updateTicketFields(TICKET_ID, { categoryId: null }, actor);

    const setArg = setMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(setArg.categoryId).toBeNull();
    // urgent hardcoded defaults (ticketSla.PRIORITY_SLA_DEFAULTS).
    expect(setArg.responseSlaMinutes).toBe(60);
    expect(setArg.resolutionSlaMinutes).toBe(240);
  });

  it('non-support work carries no SLA (work-kind link of the chain)', async () => {
    queueSelect(tickets, [{ ...UNANSWERED, workKind: 'deliverable' }]);
    queueCategory(CATEGORY_ID, 30, 480);
    dbState.updateReturningQueue.push([{ ...UNANSWERED, categoryId: CATEGORY_ID }]);

    await updateTicketFields(TICKET_ID, { categoryId: CATEGORY_ID }, actor);

    const setArg = setMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(setArg).not.toHaveProperty('responseSlaMinutes');
    expect(setArg).not.toHaveProperty('resolutionSlaMinutes');
  });
});

describe('applyAiFieldUpdates — SLA restamp before first response (#6691)', () => {
  it('(g) applying a category on an unanswered email ticket restamps under the same gate, in SQL', async () => {
    queueSelect(tickets, [UNANSWERED]);
    queueCategory(CATEGORY_ID, 30, 480);
    dbState.updateReturningQueue.push([{ categoryId: CATEGORY_ID, priority: 'normal', fieldProvenance: { categoryId: 'ai_agent' } }]);
    dbState.updateReturningQueue.push([{ id: TICKET_ID }]);

    const result = await applyAiFieldUpdates(
      TICKET_ID, ORG_ID, { categoryId: { value: CATEGORY_ID, expectedCurrent: null } }, RUN_ID,
    );

    expect(result.categoryId).toEqual({ applied: true });
    expect(setMock).toHaveBeenCalledTimes(2);
    const restamp = setMock.mock.calls[1]![0] as Record<string, unknown>;
    expect(Object.keys(restamp).sort()).toEqual(['resolutionSlaMinutes', 'responseSlaMinutes']);
    const response = sqlOf(restamp.responseSlaMinutes);
    expect(response.sql.toLowerCase()).toContain('case when');
    expect(response.sql).toContain(`->>'responseSlaMinutes'`);
    expect(response.sql.toLowerCase()).toContain(`<> 'user'`);
    expect(response.params).toContain(30);
    expect(sqlOf(restamp.resolutionSlaMinutes).params).toContain(480);

    // The gate is re-enforced atomically in the WHERE: unanswered, not
    // resolved/closed, and still on the category/priority the targets came from.
    const where = sqlOf(updateWhereMock.mock.calls[1]![0]);
    const w = where.sql.toLowerCase();
    expect(w).toContain('"first_response_at" is null');
    expect(w).toContain('"status" not in');
    expect(where.params).toEqual(expect.arrayContaining(['resolved', 'closed', CATEGORY_ID, 'normal', ORG_ID, TICKET_ID]));
    // No breach columns touched.
    expect(restamp).not.toHaveProperty('slaBreachedAt');
  });

  it('(g2) a priority applied by the AI restamps from the ticket\'s existing category + chain', async () => {
    queueSelect(tickets, [{ ...UNANSWERED, categoryId: OTHER_CATEGORY_ID }]);
    queueCategory(OTHER_CATEGORY_ID, null, null);
    configMocks.getPartnerPrioritySla.mockResolvedValue({ responseMinutes: 90, resolutionMinutes: 600 });
    dbState.updateReturningQueue.push([{ categoryId: OTHER_CATEGORY_ID, priority: 'high', fieldProvenance: { priority: 'ai_agent' } }]);
    dbState.updateReturningQueue.push([{ id: TICKET_ID }]);

    await applyAiFieldUpdates(TICKET_ID, ORG_ID, { priority: { value: 'high', expectedCurrent: 'normal' } }, RUN_ID);

    expect(configMocks.getPartnerPrioritySla).toHaveBeenCalledWith(PARTNER_ID, 'high');
    const restamp = setMock.mock.calls[1]![0] as Record<string, unknown>;
    expect(sqlOf(restamp.responseSlaMinutes).params).toContain(90);
    expect(sqlOf(restamp.resolutionSlaMinutes).params).toContain(600);
  });

  it('(h) a skipped (human_set) update does not restamp', async () => {
    queueSelect(tickets, [{ ...UNANSWERED, categoryId: OTHER_CATEGORY_ID, fieldProvenance: { categoryId: 'user' } }]);
    queueCategory(CATEGORY_ID, 30, 480);
    dbState.updateReturningQueue.push([{ categoryId: OTHER_CATEGORY_ID, priority: 'normal', fieldProvenance: { categoryId: 'user' } }]);

    const result = await applyAiFieldUpdates(
      TICKET_ID, ORG_ID, { categoryId: { value: CATEGORY_ID, expectedCurrent: OTHER_CATEGORY_ID } }, RUN_ID,
    );

    expect(result.categoryId).toEqual({ applied: false, skipped: 'human_set' });
    expect(setMock).toHaveBeenCalledTimes(1);
    expect(configMocks.getOrgSlaOverride).not.toHaveBeenCalled();
  });

  it('no restamp when the AI applies a category to an already-answered ticket', async () => {
    queueSelect(tickets, [{ ...UNANSWERED, firstResponseAt: new Date('2026-09-01T10:00:00Z') }]);
    queueCategory(CATEGORY_ID, 30, 480);
    dbState.updateReturningQueue.push([{ categoryId: CATEGORY_ID, priority: 'normal', fieldProvenance: { categoryId: 'ai_agent' } }]);

    await applyAiFieldUpdates(TICKET_ID, ORG_ID, { categoryId: { value: CATEGORY_ID, expectedCurrent: null } }, RUN_ID);

    expect(setMock).toHaveBeenCalledTimes(1);
  });

  it('a user-set target is left out of the AI restamp entirely', async () => {
    queueSelect(tickets, [{ ...UNANSWERED, responseSlaMinutes: 15, fieldProvenance: { responseSlaMinutes: 'user' } }]);
    queueCategory(CATEGORY_ID, 30, 480);
    dbState.updateReturningQueue.push([{ categoryId: CATEGORY_ID, priority: 'normal', fieldProvenance: { categoryId: 'ai_agent', responseSlaMinutes: 'user' } }]);
    dbState.updateReturningQueue.push([{ id: TICKET_ID }]);

    await applyAiFieldUpdates(TICKET_ID, ORG_ID, { categoryId: { value: CATEGORY_ID, expectedCurrent: null } }, RUN_ID);

    const restamp = setMock.mock.calls[1]![0] as Record<string, unknown>;
    expect(restamp).not.toHaveProperty('responseSlaMinutes');
    expect(sqlOf(restamp.resolutionSlaMinutes).params).toContain(480);
  });
});
