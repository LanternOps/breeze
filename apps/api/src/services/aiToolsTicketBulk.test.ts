import { beforeEach, describe, expect, it, vi } from 'vitest';

const ORG_A = '00000000-0000-4000-8000-0000000000a1';
const ORG_B = '00000000-0000-4000-8000-0000000000a2';
const T1 = '00000000-0000-4000-8000-000000000001';
const T2 = '00000000-0000-4000-8000-000000000002';
const T3 = '00000000-0000-4000-8000-000000000003';
const USER = '00000000-0000-4000-8000-0000000000e1';

const { svc, TicketServiceErrorMock, TicketMergedErrorMock } = vi.hoisted(() => {
  class TicketServiceErrorMock extends Error {
    constructor(message: string, public status = 409, public code?: string) { super(message); this.name = 'TicketServiceError'; }
  }
  class TicketMergedErrorMock extends Error {
    code = 'TICKET_MERGED';
    constructor(public id: string, public mergedIntoTicketId: string) { super('merged'); this.name = 'TicketMergedError'; }
  }
  return {
    TicketServiceErrorMock, TicketMergedErrorMock,
    svc: {
      assignTicket: vi.fn(), changeTicketStatus: vi.fn(), updateTicketFields: vi.fn(), getAssigneeForValidation: vi.fn(),
    },
  };
});

vi.mock('./ticketService', () => ({ ...svc, TicketServiceError: TicketServiceErrorMock }));
vi.mock('./ticketMerge/errors', () => ({ TicketMergedError: TicketMergedErrorMock }));

import { bulkUpdateTickets, MAX_BULK_TICKETS, type BulkDeps } from './aiToolsTicketBulk';

const actor = { kind: 'user', userId: USER, name: 'Tech' } as unknown as BulkDeps['actor'];

function deps(orgs: Record<string, string | null>, auth: BulkDeps['auth'] = { scope: 'partner', partnerId: 'p1' }): BulkDeps {
  return {
    actor,
    auth,
    findTicket: vi.fn(async (id: string) => (orgs[id] ? { id, orgId: orgs[id]! } : null)),
  };
}
const run = async (input: Record<string, unknown>, d: BulkDeps) => JSON.parse(await bulkUpdateTickets(input, d)) as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  svc.assignTicket.mockResolvedValue({});
  svc.changeTicketStatus.mockResolvedValue({});
  svc.updateTicketFields.mockResolvedValue({});
  svc.getAssigneeForValidation.mockResolvedValue({ id: USER, partnerId: 'p1' });
});

describe('manage_tickets bulk_update (W06-D3/D4)', () => {
  describe('input validation', () => {
    it('needs exactly one of assigneeId, status, priority', async () => {
      const d = deps({ [T1]: ORG_A });
      expect(await run({ ticketIds: [T1] }, d)).toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(await run({ ticketIds: [T1], status: 'open', priority: 'high' }, d)).toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(svc.changeTicketStatus).not.toHaveBeenCalled();
    });

    it('refuses resolved (route parity: resolution needs a per-ticket note)', async () => {
      expect(await run({ ticketIds: [T1], status: 'resolved' }, deps({ [T1]: ORG_A }))).toMatchObject({
        code: 'VALIDATION_ERROR', error: expect.stringContaining('resolution note'),
      });
    });

    it('has no delete: a stray delete-shaped field changes nothing and an op is still required', async () => {
      const d = deps({ [T1]: ORG_A });
      expect(await run({ ticketIds: [T1], delete: true }, d)).toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(svc.assignTicket).not.toHaveBeenCalled();
    });

    it(`caps a call at ${MAX_BULK_TICKETS} ids and rejects malformed ids`, async () => {
      const many = Array.from({ length: MAX_BULK_TICKETS + 1 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
      expect(await run({ ticketIds: many, priority: 'low' }, deps({}))).toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(await run({ ticketIds: ['nope'], priority: 'low' }, deps({}))).toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(await run({ ticketIds: [], priority: 'low' }, deps({}))).toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('rejects an out-of-enum status and priority', async () => {
      const d = deps({ [T1]: ORG_A });
      expect(await run({ ticketIds: [T1], status: 'banana' }, d)).toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(await run({ ticketIds: [T1], priority: 'critical' }, d)).toMatchObject({ code: 'VALIDATION_ERROR' });
    });
  });

  describe('single-organization rule (quorum QW4)', () => {
    it('refuses the WHOLE call, before any write, when accessible tickets span organizations', async () => {
      const res = await run({ ticketIds: [T1, T2], priority: 'high' }, deps({ [T1]: ORG_A, [T2]: ORG_B }));
      expect(res).toMatchObject({ code: 'MULTIPLE_ORGANIZATIONS' });
      expect(svc.updateTicketFields).not.toHaveBeenCalled();
      expect(svc.assignTicket).not.toHaveBeenCalled();
    });

    it('an out-of-scope ticket in another org does not count: it is skipped, the rest proceed', async () => {
      // T2 is invisible to the caller (findTicket → null), so only ORG_A is accessible.
      const res = await run({ ticketIds: [T1, T2], status: 'on_hold' }, deps({ [T1]: ORG_A, [T2]: null }));
      expect(res).toMatchObject({ updated: 1, skipped: 1, failed: 0, skippedReasons: { OUT_OF_SCOPE: 1 }, total: 2 });
      expect(svc.changeTicketStatus).toHaveBeenCalledTimes(1);
      expect(svc.changeTicketStatus).toHaveBeenCalledWith(T1, { status: 'on_hold' }, {}, actor);
    });
  });

  describe('operations', () => {
    it('assign: validates the assignee once, then assigns each ticket (null unassigns)', async () => {
      const d = deps({ [T1]: ORG_A, [T2]: ORG_A });
      await run({ ticketIds: [T1, T2], assigneeId: USER }, d);
      expect(svc.getAssigneeForValidation).toHaveBeenCalledTimes(1);
      expect(svc.assignTicket).toHaveBeenNthCalledWith(1, T1, USER, actor);
      expect(svc.assignTicket).toHaveBeenNthCalledWith(2, T2, USER, actor);
      svc.assignTicket.mockClear();
      const res = await run({ ticketIds: [T1], assigneeId: null }, d);
      expect(res).toMatchObject({ updated: 1 });
      expect(svc.assignTicket).toHaveBeenCalledWith(T1, null, actor);
    });

    it('assign: an unknown assignee and a cross-partner assignee fail the request, writing nothing', async () => {
      svc.getAssigneeForValidation.mockResolvedValueOnce(null);
      expect(await run({ ticketIds: [T1], assigneeId: USER }, deps({ [T1]: ORG_A }))).toMatchObject({ code: 'ASSIGNEE_NOT_FOUND' });
      svc.getAssigneeForValidation.mockResolvedValueOnce({ id: USER, partnerId: 'other-partner' });
      expect(await run({ ticketIds: [T1], assigneeId: USER }, deps({ [T1]: ORG_A }))).toMatchObject({ code: 'ASSIGNEE_PARTNER_MISMATCH' });
      expect(svc.assignTicket).not.toHaveBeenCalled();
    });

    it('priority runs the per-ticket updateTicketFields path (the route has no priority action)', async () => {
      const res = await run({ ticketIds: [T1, T2], priority: 'urgent' }, deps({ [T1]: ORG_A, [T2]: ORG_A }));
      expect(res).toMatchObject({ updated: 2, skipped: 0, failed: 0 });
      expect(svc.updateTicketFields).toHaveBeenCalledWith(T1, { priority: 'urgent' }, actor);
      expect(svc.updateTicketFields).toHaveBeenCalledWith(T2, { priority: 'urgent' }, actor);
    });

    it('de-duplicates repeated ids', async () => {
      const res = await run({ ticketIds: [T1, T1, T1], priority: 'low' }, deps({ [T1]: ORG_A }));
      expect(res).toMatchObject({ updated: 1, total: 1 });
      expect(svc.updateTicketFields).toHaveBeenCalledTimes(1);
    });
  });

  describe('per-ticket outcomes (route taxonomy)', () => {
    it('a service refusal and a merged tombstone are skipped by code; an unexpected error is failed; the loop continues', async () => {
      svc.changeTicketStatus
        .mockRejectedValueOnce(new TicketServiceErrorMock('invalid transition', 409, 'INVALID_TRANSITION'))
        .mockRejectedValueOnce(new TicketMergedErrorMock(T2, T3))
        .mockRejectedValueOnce(new Error('db down'))
        .mockResolvedValueOnce({});
      const T4 = '00000000-0000-4000-8000-000000000004';
      const T5 = '00000000-0000-4000-8000-000000000005';
      const orgs = { [T1]: ORG_A, [T2]: ORG_A, [T3]: ORG_A, [T4]: ORG_A };
      const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const res = await run({ ticketIds: [T1, T2, T3, T4, T5], status: 'closed' }, deps({ ...orgs, [T5]: null }));
      spy.mockRestore();
      expect(res).toMatchObject({
        updated: 1, skipped: 3, failed: 1, total: 5,
        skippedReasons: { INVALID_TRANSITION: 1, TICKET_MERGED: 1, OUT_OF_SCOPE: 1 },
      });
    });

    it('a call where nothing is accessible writes nothing and reports every id skipped', async () => {
      const res = await run({ ticketIds: [T1, T2], priority: 'low' }, deps({}));
      expect(res).toMatchObject({ updated: 0, skipped: 2, skippedReasons: { OUT_OF_SCOPE: 2 } });
      expect(svc.updateTicketFields).not.toHaveBeenCalled();
    });
  });
});
