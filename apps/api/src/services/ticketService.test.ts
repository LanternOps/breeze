import { describe, it, expect, vi, beforeEach } from 'vitest';

// Recorders for insert().values(v) and update().set(v) arguments
const valuesMock = vi.fn();
const setMock = vi.fn();

const { emitMock, auditMock, allocateMock, dbMocks } = vi.hoisted(() => {
  const insertReturning = vi.fn();
  const updateReturning = vi.fn();
  const selectResult = vi.fn();
  return {
    emitMock: vi.fn().mockResolvedValue(undefined),
    auditMock: vi.fn().mockResolvedValue(undefined),
    allocateMock: vi.fn().mockResolvedValue('T-2026-0042'),
    dbMocks: { insertReturning, updateReturning, selectResult }
  };
});

vi.mock('./ticketEvents', () => ({ emitTicketEvent: emitMock }));
vi.mock('./auditService', () => ({ createAuditLogAsync: auditMock }));
vi.mock('./ticketNumbers', () => ({ allocateInternalTicketNumber: allocateMock }));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => dbMocks.selectResult())
        }))
      }))
    })),
    insert: vi.fn(() => ({
      values: vi.fn((v) => {
        valuesMock(v);
        return {
          returning: vi.fn(() => dbMocks.insertReturning()),
          onConflictDoNothing: vi.fn(() => ({
            returning: vi.fn(() => dbMocks.insertReturning())
          }))
        };
      })
    })),
    update: vi.fn(() => ({
      set: vi.fn((v) => {
        setMock(v);
        return {
          where: vi.fn(() => ({ returning: vi.fn(() => dbMocks.updateReturning()) }))
        };
      })
    })),
    delete: vi.fn(() => ({
      where: vi.fn(() => ({ returning: vi.fn(() => dbMocks.insertReturning()) }))
    }))
  }
}));
vi.mock('../db/schema', () => ({
  tickets: { id: 'id', orgId: 'orgId', status: 'status', assignedTo: 'assignedTo' },
  ticketComments: {},
  ticketAlertLinks: { ticketId: 'ticketId', alertId: 'alertId' },
  organizations: { id: 'id', partnerId: 'partnerId' },
  alerts: { id: 'id', orgId: 'orgId' },
  ticketStatusEnum: { enumValues: ['new', 'open', 'pending', 'on_hold', 'resolved', 'closed'] },
  ticketSourceEnum: { enumValues: ['portal', 'email', 'alert', 'manual', 'api', 'ai'] }
}));

import {
  createTicket, changeTicketStatus, assignTicket, addTicketComment,
  linkAlertToTicket, unlinkAlertFromTicket, createTicketFromAlert,
  TicketServiceError, TICKET_STATUS_TRANSITIONS
} from './ticketService';

const actor = { userId: 'u-1', name: 'Tess Tech' };

describe('TICKET_STATUS_TRANSITIONS', () => {
  it('makes resolved reopenable and closed reopenable but otherwise terminal', () => {
    expect(TICKET_STATUS_TRANSITIONS.resolved).toEqual(['open', 'closed']);
    expect(TICKET_STATUS_TRANSITIONS.closed).toEqual(['open']);
  });
});

describe('createTicket', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    valuesMock.mockClear();
    setMock.mockClear();
    allocateMock.mockResolvedValue('T-2026-0042');
  });

  it('resolves partnerId from the org, allocates a number, inserts, emits ticket.created', async () => {
    dbMocks.selectResult.mockResolvedValue([{ id: 'o-1', partnerId: 'p-1' }]);
    dbMocks.insertReturning.mockResolvedValue([{ id: 't-1', orgId: 'o-1', internalNumber: 'T-2026-0042', status: 'new' }]);

    const t = await createTicket({ orgId: 'o-1', subject: 'Printer offline', source: 'manual' }, actor);

    expect(allocateMock).toHaveBeenCalledWith('p-1');
    expect(t.internalNumber).toBe('T-2026-0042');
    expect(emitMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'ticket.created', ticketId: 't-1' }));
    expect(auditMock).toHaveBeenCalled();
  });

  it('throws 404 when the org does not exist', async () => {
    dbMocks.selectResult.mockResolvedValue([]);
    await expect(createTicket({ orgId: 'missing', subject: 'x', source: 'manual' }, actor))
      .rejects.toThrow(TicketServiceError);
  });

  it('inserts with status open when assigneeId is provided', async () => {
    dbMocks.selectResult.mockResolvedValue([{ id: 'o-1', partnerId: 'p-1' }]);
    dbMocks.insertReturning.mockResolvedValue([{ id: 't-2', orgId: 'o-1', internalNumber: 'T-2026-0043', status: 'open' }]);

    await createTicket({ orgId: 'o-1', subject: 'Test', source: 'manual', assigneeId: 'u-99' }, actor);

    const insertPayload = valuesMock.mock.calls[0]![0];
    expect(insertPayload).toMatchObject({ status: 'open', assignedTo: 'u-99' });
  });

  it('passes through portal submitter fields to the insert payload', async () => {
    dbMocks.selectResult.mockResolvedValue([{ id: 'o-1', partnerId: 'p-1' }]);
    dbMocks.insertReturning.mockResolvedValue([{ id: 't-3', orgId: 'o-1', internalNumber: 'T-2026-0044', status: 'new' }]);

    await createTicket({
      orgId: 'o-1',
      subject: 'Keyboard broken',
      source: 'portal',
      submittedBy: 'pu-42',
      submitterEmail: 'alice@example.com',
      submitterName: 'Alice',
    }, actor);

    const insertPayload = valuesMock.mock.calls[0]![0];
    expect(insertPayload).toMatchObject({
      source: 'portal',
      submittedBy: 'pu-42',
      submitterEmail: 'alice@example.com',
      submitterName: 'Alice',
    });
  });
});

describe('changeTicketStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    valuesMock.mockClear();
    setMock.mockClear();
  });

  it('rejects an illegal transition with 409', async () => {
    dbMocks.selectResult.mockResolvedValue([{ id: 't-1', orgId: 'o-1', partnerId: 'p-1', status: 'closed', resolvedAt: null }]);
    const err = await changeTicketStatus('t-1', 'pending', {}, actor).catch(e => e);
    expect(err).toBeInstanceOf(TicketServiceError);
    expect(err.status).toBe(409);
    expect(err.message).toMatch(/cannot transition/i);
  });

  it('stamps resolvedAt + resolutionNote on resolve and writes a status_change feed entry', async () => {
    dbMocks.selectResult.mockResolvedValue([{ id: 't-1', orgId: 'o-1', partnerId: 'p-1', status: 'open', resolvedAt: null }]);
    dbMocks.updateReturning.mockResolvedValue([{ id: 't-1', status: 'resolved' }]);
    dbMocks.insertReturning.mockResolvedValue([{ id: 'c-1' }]);

    await changeTicketStatus('t-1', 'resolved', { resolutionNote: 'Replaced toner' }, actor);

    // Assert update payload contains the right fields
    const updatePayload = setMock.mock.calls[0]![0];
    expect(updatePayload).toMatchObject({
      status: 'resolved',
      resolutionNote: 'Replaced toner'
    });
    expect(updatePayload.resolvedAt).toBeInstanceOf(Date);

    // Assert comment insert payload has correct commentType and values
    const commentPayload = valuesMock.mock.calls[0]![0];
    expect(commentPayload).toMatchObject({
      commentType: 'status_change',
      oldValue: 'open',
      newValue: 'resolved'
    });

    expect(emitMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'ticket.status_changed',
      payload: expect.objectContaining({ from: 'open', to: 'resolved' })
    }));
  });

  it('requires a resolutionNote to resolve — 400 not 409', async () => {
    dbMocks.selectResult.mockResolvedValue([{ id: 't-1', orgId: 'o-1', partnerId: 'p-1', status: 'open' }]);
    const err = await changeTicketStatus('t-1', 'resolved', {}, actor).catch(e => e);
    expect(err).toBeInstanceOf(TicketServiceError);
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/resolution note/i);
  });

  it('throws 409 on concurrent modification and does NOT write a feed entry or emit', async () => {
    dbMocks.selectResult.mockResolvedValue([{ id: 't-1', orgId: 'o-1', partnerId: 'p-1', status: 'open', resolvedAt: null }]);
    // Simulate concurrent update: zero rows returned from update
    dbMocks.updateReturning.mockResolvedValue([]);

    const err = await changeTicketStatus('t-1', 'pending', {}, actor).catch(e => e);
    expect(err).toBeInstanceOf(TicketServiceError);
    expect(err.status).toBe(409);
    expect(err.message).toMatch(/concurrently/i);
    // No comment insert, no event
    expect(valuesMock).not.toHaveBeenCalled();
    expect(emitMock).not.toHaveBeenCalled();
  });

  it('returns the ticket unchanged on same-status no-op', async () => {
    const ticket = { id: 't-1', orgId: 'o-1', partnerId: 'p-1', status: 'open' };
    dbMocks.selectResult.mockResolvedValue([ticket]);

    const result = await changeTicketStatus('t-1', 'open', {}, actor);
    expect(result).toBe(ticket);
    // No update issued
    expect(setMock).not.toHaveBeenCalled();
    expect(emitMock).not.toHaveBeenCalled();
  });
});

describe('assignTicket', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    valuesMock.mockClear();
    setMock.mockClear();
  });

  it('updates assignee, writes an assignment feed entry, emits ticket.assigned', async () => {
    dbMocks.selectResult.mockResolvedValue([{ id: 't-1', orgId: 'o-1', partnerId: 'p-1', status: 'new', assignedTo: null }]);
    dbMocks.updateReturning.mockResolvedValue([{ id: 't-1', assignedTo: 'u-2', status: 'open' }]);
    dbMocks.insertReturning.mockResolvedValue([{ id: 'c-1' }]);

    await assignTicket('t-1', 'u-2', actor);

    // Assert comment insert has commentType 'assignment' and correct newValue
    const commentPayload = valuesMock.mock.calls[0]![0];
    expect(commentPayload).toMatchObject({
      commentType: 'assignment',
      newValue: 'u-2'
    });

    expect(emitMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'ticket.assigned',
      payload: expect.objectContaining({ assigneeId: 'u-2' })
    }));
  });

  it('throws 409 on concurrent modification and does NOT write a feed entry or emit', async () => {
    dbMocks.selectResult.mockResolvedValue([{ id: 't-1', orgId: 'o-1', partnerId: 'p-1', status: 'open', assignedTo: null }]);
    dbMocks.updateReturning.mockResolvedValue([]);

    const err = await assignTicket('t-1', 'u-2', actor).catch(e => e);
    expect(err).toBeInstanceOf(TicketServiceError);
    expect(err.status).toBe(409);
    expect(err.message).toMatch(/concurrently/i);
    expect(valuesMock).not.toHaveBeenCalled();
    expect(emitMock).not.toHaveBeenCalled();
  });

  it('unassign (assigneeId: null) succeeds', async () => {
    dbMocks.selectResult.mockResolvedValue([{ id: 't-1', orgId: 'o-1', partnerId: 'p-1', status: 'open', assignedTo: 'u-2' }]);
    dbMocks.updateReturning.mockResolvedValue([{ id: 't-1', assignedTo: null }]);
    dbMocks.insertReturning.mockResolvedValue([{ id: 'c-1' }]);

    const result = await assignTicket('t-1', null, actor);
    expect(result).toBeDefined();
    const updatePayload = setMock.mock.calls[0]![0];
    expect(updatePayload).toMatchObject({ assignedTo: null });
  });
});

describe('addTicketComment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    valuesMock.mockClear();
    setMock.mockClear();
  });

  it('stamps firstResponseAt on the first public technician comment', async () => {
    dbMocks.selectResult.mockResolvedValue([{ id: 't-1', orgId: 'o-1', partnerId: 'p-1', status: 'new', firstResponseAt: null }]);
    dbMocks.insertReturning.mockResolvedValue([{ id: 'c-1', isPublic: true }]);
    dbMocks.updateReturning.mockResolvedValue([{ id: 't-1' }]);

    const result = await addTicketComment('t-1', { content: 'On it', isPublic: true }, actor);

    expect(result.firstResponseStamped).toBe(true);

    // Assert update payload contains a firstResponseAt Date
    const updatePayload = setMock.mock.calls[0]![0];
    expect(updatePayload.firstResponseAt).toBeInstanceOf(Date);

    expect(emitMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'ticket.commented' }));
  });

  it('does not stamp firstResponseAt for internal notes', async () => {
    dbMocks.selectResult.mockResolvedValue([{ id: 't-1', orgId: 'o-1', partnerId: 'p-1', status: 'new', firstResponseAt: null }]);
    dbMocks.insertReturning.mockResolvedValue([{ id: 'c-1', isPublic: false }]);

    const result = await addTicketComment('t-1', { content: 'customer is VIP', isPublic: false }, actor);
    expect(result.firstResponseStamped).toBe(false);
    // No update on tickets
    expect(setMock).not.toHaveBeenCalled();
  });
});

describe('linkAlertToTicket', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    valuesMock.mockClear();
    setMock.mockClear();
  });

  it('refuses to link an alert from a different org — 400', async () => {
    dbMocks.selectResult
      .mockResolvedValueOnce([{ id: 't-1', orgId: 'o-1', partnerId: 'p-1', status: 'open' }])
      .mockResolvedValueOnce([{ id: 'a-1', orgId: 'o-OTHER', title: 'CPU high' }]);
    const err = await linkAlertToTicket('t-1', 'a-1', actor).catch(e => e);
    expect(err).toBeInstanceOf(TicketServiceError);
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/same organization/i);
  });

  it('links and writes a system feed entry', async () => {
    dbMocks.selectResult
      .mockResolvedValueOnce([{ id: 't-1', orgId: 'o-1', partnerId: 'p-1', status: 'open' }])
      .mockResolvedValueOnce([{ id: 'a-1', orgId: 'o-1', title: 'CPU high' }]);
    dbMocks.insertReturning.mockResolvedValue([{ id: 'link-1' }]);
    const link = await linkAlertToTicket('t-1', 'a-1', actor);
    expect(link).toBeDefined();
  });

  it('throws 409 when the link already exists and inserts no feed entry', async () => {
    dbMocks.selectResult
      .mockResolvedValueOnce([{ id: 't-1', orgId: 'o-1', partnerId: 'p-1', status: 'open' }])
      .mockResolvedValueOnce([{ id: 'a-1', orgId: 'o-1', title: 'CPU high' }]);
    // onConflictDoNothing() returned empty array → already linked
    dbMocks.insertReturning.mockResolvedValue([]);

    const err = await linkAlertToTicket('t-1', 'a-1', actor).catch(e => e);
    expect(err).toBeInstanceOf(TicketServiceError);
    expect(err.status).toBe(409);
    expect(err.message).toMatch(/already linked/i);
    // Only one insert call (the link insert) — no comment insert
    expect(valuesMock).toHaveBeenCalledTimes(1);
  });
});

describe('unlinkAlertFromTicket', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    valuesMock.mockClear();
    setMock.mockClear();
  });

  it('throws 404 when the link does not exist and writes no feed entry', async () => {
    dbMocks.selectResult.mockResolvedValue([{ id: 't-1', orgId: 'o-1', partnerId: 'p-1', status: 'open' }]);
    // delete returns empty array → link not found
    dbMocks.insertReturning.mockResolvedValue([]);

    const err = await unlinkAlertFromTicket('t-1', 'a-1', actor).catch(e => e);
    expect(err).toBeInstanceOf(TicketServiceError);
    expect(err.status).toBe(404);
    expect(err.message).toMatch(/link not found/i);
    // No comment inserted
    expect(valuesMock).not.toHaveBeenCalled();
  });

  it('unlinks successfully and writes a system feed entry', async () => {
    dbMocks.selectResult.mockResolvedValue([{ id: 't-1', orgId: 'o-1', partnerId: 'p-1', status: 'open' }]);
    // delete returns a row → success
    dbMocks.insertReturning.mockResolvedValueOnce([{ id: 'link-1' }]).mockResolvedValue([{ id: 'c-1' }]);

    const result = await unlinkAlertFromTicket('t-1', 'a-1', actor);
    expect(result).toMatchObject({ ticketId: 't-1', alertId: 'a-1' });
    expect(valuesMock).toHaveBeenCalledWith(expect.objectContaining({ commentType: 'system', content: 'Unlinked alert' }));
  });
});

describe('createTicketFromAlert', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    valuesMock.mockClear();
    setMock.mockClear();
    allocateMock.mockResolvedValue('T-2026-0042');
  });

  it('creates a pre-filled ticket linked created_from', async () => {
    // selects in order: alert, org (inside createTicket), ticket (inside linkAlertToTicket), alert (inside linkAlertToTicket)
    dbMocks.selectResult
      .mockResolvedValueOnce([{ id: 'a-1', orgId: 'o-1', deviceId: 'd-1', title: 'Disk 90%', message: 'C: at 92%', severity: 'high' }])
      .mockResolvedValueOnce([{ id: 'o-1', partnerId: 'p-1' }])
      .mockResolvedValueOnce([{ id: 't-9', orgId: 'o-1', partnerId: 'p-1', status: 'new' }])
      .mockResolvedValueOnce([{ id: 'a-1', orgId: 'o-1', title: 'Disk 90%' }]);
    dbMocks.insertReturning.mockResolvedValue([{ id: 't-9', orgId: 'o-1', internalNumber: 'T-2026-0042' }]);

    const t = await createTicketFromAlert('a-1', actor);
    expect(t.id).toBe('t-9');
    expect(emitMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'ticket.created' }));

    // Assert createTicket's insert payload got priority: 'high' for severity: 'high'
    const ticketInsertPayload = valuesMock.mock.calls[0]![0];
    expect(ticketInsertPayload).toMatchObject({ priority: 'high' });
  });

  it('404s on a missing alert', async () => {
    dbMocks.selectResult.mockResolvedValueOnce([]);
    await expect(createTicketFromAlert('missing', actor)).rejects.toThrow(/alert not found/i);
  });
});
