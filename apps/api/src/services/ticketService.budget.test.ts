import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// #4617 W03 — the ticket budget (spec §4.2). Setting `budgetAmount` stamps
// `budgetCurrencyCode` from the org currency, read under the org SHARE lock
// BEFORE the ticket row is written (lock order organizations → tickets, the
// same order the approval gate takes). Clearing the amount clears both.
// Harness: ticketService.slaRestamp.test.ts.

const { emitMock, callOrder, orgCurrency, dbState } = vi.hoisted(() => ({
  emitMock: vi.fn().mockResolvedValue(undefined),
  callOrder: [] as string[],
  orgCurrency: { value: 'USD' as string, missing: false },
  dbState: {
    selectQueues: new Map<unknown, unknown[][]>(),
    updateReturningQueue: [] as unknown[][],
  },
}));

vi.mock('./ticketEvents', () => ({ emitTicketEvent: emitMock }));
vi.mock('./auditService', () => ({ createAuditLogAsync: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./mlFeedbackEmitters', () => ({ emitTicketTriageFeedback: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./ticketConfigService', () => ({
  getOrgSlaOverride: vi.fn(),
  getPartnerPrioritySla: vi.fn(),
  getSystemStatusId: vi.fn().mockResolvedValue(null),
  getTicketStatusById: vi.fn().mockResolvedValue(null),
}));
vi.mock('./orgCurrencyCore', async (orig) => {
  const actual = await orig<typeof import('./orgCurrencyCore')>();
  return {
    ...actual,
    readOrgStampingDefaults: vi.fn(async (_tx: unknown, orgId: string) => {
      callOrder.push(`orgShare:${orgId}`);
      if (orgCurrency.missing) throw new actual.OrgCurrencyServiceError('Organization not found', 404, 'ORG_NOT_FOUND');
      return { currencyCode: orgCurrency.value };
    }),
  };
});

const setMock = vi.fn();
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
        callOrder.push('ticketUpdate');
        setMock(v);
        return {
          where: vi.fn(() => ({
            returning: vi.fn(() => Promise.resolve(dbState.updateReturningQueue.shift() ?? [])),
          })),
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

import { tickets } from '../db/schema';
import { updateTicketFields, TicketServiceError, type TicketActor } from './ticketService';

const TICKET_ID = '11111111-1111-1111-1111-111111111111';
const ORG_ID = '22222222-2222-2222-2222-222222222222';
const actor: TicketActor = { kind: 'user', userId: 'user-1', name: 'Tess Tech' };

const BASE = {
  id: TICKET_ID, orgId: ORG_ID, partnerId: 'p-1', subject: 'Printer offline', description: null,
  categoryId: null, priority: 'normal', dueDate: null, responseSlaMinutes: null, resolutionSlaMinutes: null,
  deviceId: null, tags: [], status: 'open', firstResponseAt: null, workKind: 'support', fieldProvenance: {},
  budgetMinutes: null, budgetAmount: null, budgetCurrencyCode: null,
};

function queueTicket(row: Record<string, unknown>) {
  if (!dbState.selectQueues.has(tickets)) dbState.selectQueues.set(tickets, []);
  dbState.selectQueues.get(tickets)!.push([row]);
  dbState.updateReturningQueue.push([{ ...row }]);
}

beforeEach(() => {
  vi.clearAllMocks();
  callOrder.length = 0;
  orgCurrency.value = 'USD';
  orgCurrency.missing = false;
  dbState.selectQueues.clear();
  dbState.updateReturningQueue.length = 0;
});

afterEach(() => vi.restoreAllMocks());

describe('updateTicketFields — ticket budget (#4617 W03)', () => {
  it('setting budgetAmount stamps budgetCurrencyCode from the org, read before the ticket write', async () => {
    orgCurrency.value = 'EUR';
    queueTicket(BASE);
    await updateTicketFields(TICKET_ID, { budgetAmount: '450.5' }, actor);

    expect(setMock).toHaveBeenCalledTimes(1);
    const set = setMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(set.budgetAmount).toBe('450.50');
    expect(set.budgetCurrencyCode).toBe('EUR');
    expect(callOrder).toEqual([`orgShare:${ORG_ID}`, 'ticketUpdate']);
    expect(insertValuesMock).toHaveBeenCalledWith(expect.objectContaining({ content: 'Updated budget' }));
  });

  it('clearing budgetAmount clears both the amount and the currency, without reading the org', async () => {
    queueTicket({ ...BASE, budgetAmount: '100.00', budgetCurrencyCode: 'USD' });
    await updateTicketFields(TICKET_ID, { budgetAmount: null }, actor);

    const set = setMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(set.budgetAmount).toBeNull();
    expect(set.budgetCurrencyCode).toBeNull();
    expect(callOrder).toEqual(['ticketUpdate']);
  });

  it('budgetMinutes alone never touches the money axis', async () => {
    queueTicket({ ...BASE, budgetAmount: '100.00', budgetCurrencyCode: 'USD' });
    await updateTicketFields(TICKET_ID, { budgetMinutes: 240 }, actor);

    const set = setMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(set.budgetMinutes).toBe(240);
    expect(set).not.toHaveProperty('budgetAmount');
    expect(set).not.toHaveProperty('budgetCurrencyCode');
    expect(callOrder).toEqual(['ticketUpdate']);
  });

  it('refuses an amount the org currency cannot represent (JPY has no minor unit) with 400 and writes nothing', async () => {
    orgCurrency.value = 'JPY';
    queueTicket(BASE);
    await expect(updateTicketFields(TICKET_ID, { budgetAmount: '100.50' }, actor))
      .rejects.toMatchObject({ status: 400 });
    expect(setMock).not.toHaveBeenCalled();
  });

  it('an unchanged amount in the same currency is a no-op', async () => {
    queueTicket({ ...BASE, budgetAmount: '100.00', budgetCurrencyCode: 'USD' });
    await updateTicketFields(TICKET_ID, { budgetAmount: '100' }, actor);
    expect(setMock).not.toHaveBeenCalled();
  });

  it('re-saving the same amount after the org currency changed re-stamps the currency', async () => {
    orgCurrency.value = 'GBP';
    queueTicket({ ...BASE, budgetAmount: '100.00', budgetCurrencyCode: 'USD' });
    await updateTicketFields(TICKET_ID, { budgetAmount: '100.00' }, actor);
    const set = setMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(set.budgetCurrencyCode).toBe('GBP');
  });

  it('a vanished org surfaces as a ticket-service 404, not a 500', async () => {
    orgCurrency.missing = true;
    queueTicket(BASE);
    const err = await updateTicketFields(TICKET_ID, { budgetAmount: '10.00' }, actor).catch((e) => e);
    expect(err).toBeInstanceOf(TicketServiceError);
    expect(err.status).toBe(404);
  });
});
