/**
 * #11674 — the ticket number read behind the stored approval label.
 *
 * `resolveApprovalTicketNumber` runs with RLS bypassed (system context, like
 * approvalDeviceName.ts), and the ticket id it resolves comes from tool
 * ARGUMENTS. The org pin in its WHERE clause is the only thing keeping it from
 * being a cross-tenant oracle, so it is asserted on the BOUND PARAMETERS of the
 * condition handed to `where()`, not on returned rows (see
 * approvalDeviceName.test.ts for why). The label also feeds the push and the
 * audit trail, so the read's projection is asserted too: the number columns
 * only, never the subject or the requester.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const dbState = {
  selectArgs: [] as unknown[],
  whereArgs: [] as unknown[],
  rows: [] as Array<{ ticketNumber: string; internalNumber: string | null }>,
  failWith: null as Error | null,
  systemContextLabels: [] as Array<string | undefined>,
  outsideContextCalls: 0,
};

vi.mock('../../db', () => ({
  db: {
    select: (projection: unknown) => {
      dbState.selectArgs.push(projection);
      return {
        from: () => ({
          where: (condition: unknown) => {
            dbState.whereArgs.push(condition);
            return {
              limit: async () => {
                if (dbState.failWith) throw dbState.failWith;
                return dbState.rows;
              },
            };
          },
        }),
      };
    },
  },
  runOutsideDbContext: <T,>(fn: () => Promise<T>) => {
    dbState.outsideContextCalls += 1;
    return fn();
  },
  withSystemDbAccessContext: <T,>(fn: () => Promise<T>, label?: string) => {
    dbState.systemContextLabels.push(label);
    return fn();
  },
}));

const captureException = vi.fn();
vi.mock('../sentry', () => ({ captureException: (e: unknown) => captureException(e) }));

import { and, eq } from 'drizzle-orm';
import { resolveApprovalTicketNumber } from './approvalTicketNumber';
import { tickets } from '../../db/schema';

const TICKET_ID = '2aad0601-1111-4222-8333-444455556666';
const ORG_ID = '11111111-2222-4333-8444-555566667777';
const OTHER_ORG_ID = '99999999-2222-4333-8444-555566667777';

function boundParams(node: unknown): unknown[] {
  if (node === null || typeof node !== 'object') return [];
  const obj = node as Record<string, unknown>;
  if ('value' in obj && 'encoder' in obj) return [obj.value];
  const chunks = obj.queryChunks;
  if (Array.isArray(chunks)) return chunks.flatMap(boundParams);
  return [];
}

beforeEach(() => {
  dbState.selectArgs = [];
  dbState.whereArgs = [];
  dbState.rows = [];
  dbState.failWith = null;
  dbState.systemContextLabels = [];
  dbState.outsideContextCalls = 0;
  captureException.mockClear();
});

describe('boundParams (control)', () => {
  it('loses the org id when the org term is dropped', () => {
    expect(boundParams(and(eq(tickets.id, TICKET_ID), eq(tickets.orgId, ORG_ID)))).toEqual(expect.arrayContaining([TICKET_ID, ORG_ID]));
    expect(boundParams(eq(tickets.id, TICKET_ID))).not.toContain(ORG_ID);
  });
});

describe('resolveApprovalTicketNumber', () => {
  it('pins the read to both the ticket id and the intent org', async () => {
    dbState.rows = [{ ticketNumber: 'TTAVKZRCGR', internalNumber: 'T-2026-0001' }];

    await resolveApprovalTicketNumber(TICKET_ID, ORG_ID);

    expect(dbState.whereArgs).toHaveLength(1);
    const params = boundParams(dbState.whereArgs[0]);
    expect(params).toContain(TICKET_ID);
    expect(params).toContain(ORG_ID);
    expect(params).not.toContain(OTHER_ORG_ID);
  });

  it('reads the number columns only: no subject, requester or text can reach the label', async () => {
    dbState.rows = [{ ticketNumber: 'TTAVKZRCGR', internalNumber: 'T-2026-0001' }];

    await resolveApprovalTicketNumber(TICKET_ID, ORG_ID);

    expect(dbState.selectArgs).toHaveLength(1);
    expect(Object.keys(dbState.selectArgs[0] as Record<string, unknown>).sort()).toEqual(['internalNumber', 'ticketNumber']);
  });

  it('reads under a system context opened outside any ambient one', async () => {
    dbState.rows = [{ ticketNumber: 'TTAVKZRCGR', internalNumber: 'T-2026-0001' }];

    await resolveApprovalTicketNumber(TICKET_ID, ORG_ID);

    expect(dbState.outsideContextCalls).toBe(1);
    expect(dbState.systemContextLabels).toEqual(['actionIntents.approvalTicketNumber']);
  });

  it('prefers the internal number technicians see over the portal reference', async () => {
    dbState.rows = [{ ticketNumber: 'TTAVKZRCGR', internalNumber: 'T-2026-0001' }];
    await expect(resolveApprovalTicketNumber(TICKET_ID, ORG_ID)).resolves.toBe('T-2026-0001');
  });

  it('falls back to the portal reference for a ticket with no internal number', async () => {
    dbState.rows = [{ ticketNumber: 'TTAVKZRCGR', internalNumber: null }];
    await expect(resolveApprovalTicketNumber(TICKET_ID, ORG_ID)).resolves.toBe('TTAVKZRCGR');
  });

  it('resolves to nothing when the org pin matches no row', async () => {
    dbState.rows = [];
    await expect(resolveApprovalTicketNumber(TICKET_ID, ORG_ID)).resolves.toBeNull();
  });

  it('reports a failed read to Sentry and degrades to null instead of throwing', async () => {
    dbState.failWith = new Error('connection terminated');

    await expect(resolveApprovalTicketNumber(TICKET_ID, ORG_ID)).resolves.toBeNull();
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });
});
