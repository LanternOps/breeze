/**
 * #11674 — the ticket number read behind the stored approval label.
 *
 * `resolveApprovalTicketNumber` runs with RLS bypassed (system context, like
 * approvalDeviceName.ts), and the ticket id it resolves comes from tool
 * ARGUMENTS. What keeps it from naming a ticket the caller cannot read is the
 * WHERE clause (the intent's org AND the caller's org reach) plus the caller's
 * site/device check on a device-bound ticket — the same predicate the chat card
 * read uses. The WHERE terms are asserted on the BOUND PARAMETERS handed to
 * `where()`, not on returned rows (see approvalDeviceName.test.ts for why). The
 * label also feeds the push and the audit trail, so the projection is asserted
 * too: the number columns and the device id only, never subject or requester.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const dbState = {
  selectArgs: [] as unknown[],
  whereArgs: [] as unknown[],
  rows: [] as Array<{ ticketNumber: string; internalNumber: string | null; deviceId: string | null }>,
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

const deviceInSiteScope = vi.fn(async (_auth: unknown, _deviceId: string) => true);
vi.mock('../../routes/tickets/siteScope', () => ({
  deviceInSiteScope: (auth: unknown, deviceId: string) => deviceInSiteScope(auth, deviceId),
}));

import { and, eq } from 'drizzle-orm';
import { argumentTicketId, resolveApprovalTicketNumber, type ApprovalTicketReach } from './approvalTicketNumber';
import { buildActionLabel, hasTicketIdStub } from './actionLabel';
import { checkGuardrails } from '../aiGuardrails';
import { tickets } from '../../db/schema';

const TICKET_ID = '2aad0601-1111-4222-8333-444455556666';
const ORG_ID = '11111111-2222-4333-8444-555566667777';
const OTHER_ORG_ID = '99999999-2222-4333-8444-555566667777';
const REACH_ORG_ID = '33333333-2222-4333-8444-555566667777';
const DEVICE_ID = '8f14580d-1111-4222-8333-444455556666';

/** The caller's reach. `orgCondition` binds a distinct org id, so its term is visible in the bound params. */
function reach(overrides: Partial<ApprovalTicketReach> = {}): ApprovalTicketReach {
  return { orgCondition: (column) => eq(column, REACH_ORG_ID), ...overrides };
}

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
  deviceInSiteScope.mockReset();
  deviceInSiteScope.mockResolvedValue(true);
});

describe('boundParams (control)', () => {
  it('loses the org id when the org term is dropped', () => {
    expect(boundParams(and(eq(tickets.id, TICKET_ID), eq(tickets.orgId, ORG_ID)))).toEqual(expect.arrayContaining([TICKET_ID, ORG_ID]));
    expect(boundParams(eq(tickets.id, TICKET_ID))).not.toContain(ORG_ID);
  });
});

describe('resolveApprovalTicketNumber', () => {
  it('pins the read to the ticket id, the intent org and the caller\'s org reach', async () => {
    dbState.rows = [{ ticketNumber: 'TTAVKZRCGR', internalNumber: 'T-2026-0001', deviceId: null }];

    await resolveApprovalTicketNumber(TICKET_ID, ORG_ID, reach());

    expect(dbState.whereArgs).toHaveLength(1);
    const params = boundParams(dbState.whereArgs[0]);
    expect(params).toContain(TICKET_ID);
    expect(params).toContain(ORG_ID);
    expect(params).toContain(REACH_ORG_ID);
    expect(params).not.toContain(OTHER_ORG_ID);
  });

  it('reads the number columns and the device id only: no subject, requester or text', async () => {
    dbState.rows = [{ ticketNumber: 'TTAVKZRCGR', internalNumber: 'T-2026-0001', deviceId: null }];

    await resolveApprovalTicketNumber(TICKET_ID, ORG_ID, reach());

    expect(dbState.selectArgs).toHaveLength(1);
    expect(Object.keys(dbState.selectArgs[0] as Record<string, unknown>).sort()).toEqual(['deviceId', 'internalNumber', 'ticketNumber']);
  });

  it('reads under a system context opened outside any ambient one', async () => {
    dbState.rows = [{ ticketNumber: 'TTAVKZRCGR', internalNumber: 'T-2026-0001', deviceId: null }];

    await resolveApprovalTicketNumber(TICKET_ID, ORG_ID, reach());

    expect(dbState.outsideContextCalls).toBe(1);
    expect(dbState.systemContextLabels).toEqual(['actionIntents.approvalTicketNumber']);
  });

  it('prefers the internal number technicians see over the portal reference', async () => {
    dbState.rows = [{ ticketNumber: 'TTAVKZRCGR', internalNumber: 'T-2026-0001', deviceId: null }];
    await expect(resolveApprovalTicketNumber(TICKET_ID, ORG_ID, reach())).resolves.toBe('T-2026-0001');
  });

  it('falls back to the portal reference for a ticket with no internal number', async () => {
    dbState.rows = [{ ticketNumber: 'TTAVKZRCGR', internalNumber: null, deviceId: null }];
    await expect(resolveApprovalTicketNumber(TICKET_ID, ORG_ID, reach())).resolves.toBe('TTAVKZRCGR');
  });

  it('resolves to nothing when the WHERE clause matches no row', async () => {
    dbState.rows = [];
    await expect(resolveApprovalTicketNumber(TICKET_ID, ORG_ID, reach())).resolves.toBeNull();
  });

  it('resolves to nothing for a ticket whose device is outside the caller\'s site scope', async () => {
    const siteRestricted = reach({ allowedSiteIds: ['44444444-2222-4333-8444-555566667777'] });
    dbState.rows = [{ ticketNumber: 'TTAVKZRCGR', internalNumber: 'T-2026-0001', deviceId: DEVICE_ID }];
    deviceInSiteScope.mockResolvedValueOnce(false);

    await expect(resolveApprovalTicketNumber(TICKET_ID, ORG_ID, siteRestricted)).resolves.toBeNull();
    expect(deviceInSiteScope).toHaveBeenCalledWith(siteRestricted, DEVICE_ID);
  });

  it('names a device-bound ticket whose device is in the caller\'s site scope', async () => {
    dbState.rows = [{ ticketNumber: 'TTAVKZRCGR', internalNumber: 'T-2026-0001', deviceId: DEVICE_ID }];
    const siteRestricted = reach({ allowedSiteIds: ['44444444-2222-4333-8444-555566667777'] });
    await expect(resolveApprovalTicketNumber(TICKET_ID, ORG_ID, siteRestricted)).resolves.toBe('T-2026-0001');
    expect(deviceInSiteScope).toHaveBeenCalledTimes(1);
  });

  it('keeps the stub (null, no read) when the filing principal carries no org reach', async () => {
    // Reach cannot be established: never fall back to an org-only read.
    const noReach = {} as unknown as ApprovalTicketReach;
    await expect(resolveApprovalTicketNumber(TICKET_ID, ORG_ID, noReach)).resolves.toBeNull();
    expect(dbState.whereArgs).toHaveLength(0);
    expect(dbState.systemContextLabels).toHaveLength(0);
    // A deliberate decision, not a failed read: nothing is reported.
    expect(captureException).not.toHaveBeenCalled();
  });

  it('reports a failed read to Sentry and degrades to null instead of throwing', async () => {
    dbState.failWith = new Error('connection terminated');

    await expect(resolveApprovalTicketNumber(TICKET_ID, ORG_ID, reach())).resolves.toBeNull();
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  it('a site-restricted comment edit naming an out-of-site ticket keeps the stub in the stored label', async () => {
    // The composition intentService.ts runs: operative ticket id, read cut to
    // the caller's reach, then the label.
    const input = { action: 'edit_comment', commentId: DEVICE_ID, expectedTicketId: TICKET_ID, content: 'new text' };
    const reason = checkGuardrails('manage_tickets', input).description!;
    const ticketId = argumentTicketId('manage_tickets', input)!;
    expect(hasTicketIdStub(reason, ticketId)).toBe(true);
    dbState.rows = [{ ticketNumber: 'TTAVKZRCGR', internalNumber: 'T-2026-0001', deviceId: DEVICE_ID }];
    deviceInSiteScope.mockResolvedValueOnce(false);

    const ticketNumber = await resolveApprovalTicketNumber(ticketId, ORG_ID, reach({ allowedSiteIds: [] }));

    expect(buildActionLabel({ toolName: 'manage_tickets', input, reason, ticketId, ticketNumber }))
      .toBe('Edit a comment on ticket #2aad0601... (replaces its text)');
  });
});
