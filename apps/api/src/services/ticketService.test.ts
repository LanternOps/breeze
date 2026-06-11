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
  // Context helpers are passthroughs: the service routes its validation reads
  // through a system-scope DB context (RLS concern), invisible to unit tests.
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
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
  devices: { id: 'id', orgId: 'orgId' },
  users: { id: 'id', partnerId: 'partnerId' },
  ticketCategories: { id: 'id', partnerId: 'partnerId' },
  ticketStatusEnum: { enumValues: ['new', 'open', 'pending', 'on_hold', 'resolved', 'closed'] },
  ticketSourceEnum: { enumValues: ['portal', 'email', 'alert', 'manual', 'api', 'ai'] }
}));

import {
  createTicket, changeTicketStatus, assignTicket, addTicketComment,
  linkAlertToTicket, unlinkAlertFromTicket, createTicketFromAlert,
  updateTicketFields,
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
    dbMocks.selectResult
      .mockResolvedValueOnce([{ id: 'o-1', partnerId: 'p-1' }])   // org
      .mockResolvedValueOnce([{ id: 'u-99', partnerId: 'p-1' }]); // assignee
    dbMocks.insertReturning.mockResolvedValue([{ id: 't-2', orgId: 'o-1', internalNumber: 'T-2026-0043', status: 'open' }]);

    await createTicket({ orgId: 'o-1', subject: 'Test', source: 'manual', assigneeId: 'u-99' }, actor);

    const insertPayload = valuesMock.mock.calls[0]![0];
    expect(insertPayload).toMatchObject({ status: 'open', assignedTo: 'u-99' });
  });

  it('rejects a deviceId belonging to a different org with a 400 TicketServiceError', async () => {
    // selects in order: org, device (cross-org)
    dbMocks.selectResult
      .mockResolvedValueOnce([{ id: 'o-1', partnerId: 'p-1' }])
      .mockResolvedValueOnce([{ id: 'd-1', orgId: 'o-OTHER' }]);

    const err = await createTicket(
      { orgId: 'o-1', subject: 'Cross-org device', source: 'manual', deviceId: 'd-1' }, actor
    ).catch(e => e);

    expect(err).toBeInstanceOf(TicketServiceError);
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/same organization/i);
    // Rejected before number allocation and before any insert
    expect(allocateMock).not.toHaveBeenCalled();
    expect(valuesMock).not.toHaveBeenCalled();
  });

  it('rejects an unknown deviceId with a 404 TicketServiceError', async () => {
    dbMocks.selectResult
      .mockResolvedValueOnce([{ id: 'o-1', partnerId: 'p-1' }])
      .mockResolvedValueOnce([]); // device lookup: no row

    const err = await createTicket(
      { orgId: 'o-1', subject: 'Ghost device', source: 'manual', deviceId: 'd-missing' }, actor
    ).catch(e => e);

    expect(err).toBeInstanceOf(TicketServiceError);
    expect(err.status).toBe(404);
    expect(err.message).toMatch(/device not found/i);
    expect(valuesMock).not.toHaveBeenCalled();
  });

  it('accepts a deviceId belonging to the same org and passes it to the insert payload', async () => {
    dbMocks.selectResult
      .mockResolvedValueOnce([{ id: 'o-1', partnerId: 'p-1' }])
      .mockResolvedValueOnce([{ id: 'd-1', orgId: 'o-1' }]);
    dbMocks.insertReturning.mockResolvedValue([{ id: 't-4', orgId: 'o-1', internalNumber: 'T-2026-0045', status: 'new' }]);

    await createTicket({ orgId: 'o-1', subject: 'Same-org device', source: 'manual', deviceId: 'd-1' }, actor);

    const insertPayload = valuesMock.mock.calls[0]![0];
    expect(insertPayload).toMatchObject({ deviceId: 'd-1' });
  });

  it('non-portal ticket defaults submitterName to the actor but NEVER stamps submitterEmail', async () => {
    dbMocks.selectResult.mockResolvedValue([{ id: 'o-1', partnerId: 'p-1' }]);
    dbMocks.insertReturning.mockResolvedValue([{ id: 't-5', orgId: 'o-1', internalNumber: 'T-2026-0042', status: 'new' }]);

    await createTicket(
      { orgId: 'o-1', subject: 'Printer offline', source: 'manual' },
      { userId: 'u-1', name: 'Tech One', email: 'tech@msp.com' }
    );

    // submitterEmail must stay null even when the actor has an email: the
    // notify worker emails submitterEmail on every public comment/resolution
    // with portal-oriented copy and no self-actor suppression.
    const insertPayload = valuesMock.mock.calls[0]![0];
    expect(insertPayload).toMatchObject({
      submitterName: 'Tech One',
      submitterEmail: null,
      submittedBy: null
    });
  });

  it('non-portal ticket sets both submitter fields to null when actor has no name/email', async () => {
    dbMocks.selectResult.mockResolvedValue([{ id: 'o-1', partnerId: 'p-1' }]);
    dbMocks.insertReturning.mockResolvedValue([{ id: 't-6', orgId: 'o-1', internalNumber: 'T-2026-0042', status: 'new' }]);

    await createTicket(
      { orgId: 'o-1', subject: 'Headless ticket', source: 'alert' },
      { userId: 'u-sys' }
    );

    const insertPayload = valuesMock.mock.calls[0]![0];
    expect(insertPayload).toMatchObject({
      submitterName: null,
      submitterEmail: null,
      submittedBy: null
    });
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
    dbMocks.selectResult
      .mockResolvedValueOnce([{ id: 't-1', orgId: 'o-1', partnerId: 'p-1', status: 'new', assignedTo: null }])  // ticket
      .mockResolvedValueOnce([{ id: 'u-2', partnerId: 'p-1' }]);                                                 // assignee
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
    dbMocks.selectResult
      .mockResolvedValueOnce([{ id: 't-1', orgId: 'o-1', partnerId: 'p-1', status: 'open', assignedTo: null }])  // ticket
      .mockResolvedValueOnce([{ id: 'u-2', partnerId: 'p-1' }]); // assignee
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

describe('changeTicketStatus — additional lifecycle cases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    valuesMock.mockClear();
    setMock.mockClear();
  });

  it('reopen: resolved ticket → open clears resolvedAt, closedAt, closedBy, and pendingReason', async () => {
    const resolvedDate = new Date('2026-01-10T12:00:00Z');
    dbMocks.selectResult.mockResolvedValue([{
      id: 't-1', orgId: 'o-1', partnerId: 'p-1',
      status: 'resolved',
      resolvedAt: resolvedDate,
      closedAt: resolvedDate,
      closedBy: 'u-9',
      pendingReason: null
    }]);
    dbMocks.updateReturning.mockResolvedValue([{ id: 't-1', status: 'open' }]);
    dbMocks.insertReturning.mockResolvedValue([{ id: 'c-1' }]);

    await changeTicketStatus('t-1', 'open', {}, actor);

    const updatePayload = setMock.mock.calls[0]![0];
    expect(updatePayload).toMatchObject({
      status: 'open',
      resolvedAt: null,
      closedAt: null,
      closedBy: null,
      pendingReason: null
    });
  });

  it('close an already-resolved ticket: preserves resolvedAt, stamps closedAt/closedBy', async () => {
    const resolvedDate = new Date('2026-01-10T12:00:00Z');
    dbMocks.selectResult.mockResolvedValue([{
      id: 't-1', orgId: 'o-1', partnerId: 'p-1',
      status: 'resolved',
      resolvedAt: resolvedDate,
      closedAt: null,
      closedBy: null,
      pendingReason: null
    }]);
    dbMocks.updateReturning.mockResolvedValue([{ id: 't-1', status: 'closed' }]);
    dbMocks.insertReturning.mockResolvedValue([{ id: 'c-1' }]);

    await changeTicketStatus('t-1', 'closed', {}, actor);

    const updatePayload = setMock.mock.calls[0]![0];
    // resolvedAt must be the original date, NOT re-stamped
    expect(updatePayload.resolvedAt).toEqual(resolvedDate);
    expect(updatePayload.closedAt).toBeInstanceOf(Date);
    expect(updatePayload.closedBy).toBe(actor.userId);
  });

  it('pending with pendingReason carries it; pending → open clears it', async () => {
    // Step 1: open → pending with reason
    dbMocks.selectResult.mockResolvedValue([{
      id: 't-1', orgId: 'o-1', partnerId: 'p-1', status: 'open', resolvedAt: null
    }]);
    dbMocks.updateReturning.mockResolvedValue([{ id: 't-1', status: 'pending' }]);
    dbMocks.insertReturning.mockResolvedValue([{ id: 'c-1' }]);

    await changeTicketStatus('t-1', 'pending', { pendingReason: 'waiting on customer' }, actor);

    const pendingPayload = setMock.mock.calls[0]![0];
    expect(pendingPayload).toMatchObject({ status: 'pending', pendingReason: 'waiting on customer' });

    // Step 2: pending → open clears pendingReason
    vi.clearAllMocks();
    valuesMock.mockClear();
    setMock.mockClear();
    dbMocks.selectResult.mockResolvedValue([{
      id: 't-1', orgId: 'o-1', partnerId: 'p-1', status: 'pending', resolvedAt: null
    }]);
    dbMocks.updateReturning.mockResolvedValue([{ id: 't-1', status: 'open' }]);
    dbMocks.insertReturning.mockResolvedValue([{ id: 'c-1' }]);

    await changeTicketStatus('t-1', 'open', {}, actor);

    const openPayload = setMock.mock.calls[0]![0];
    expect(openPayload).toMatchObject({ status: 'open', pendingReason: null });
  });

  it('firstResponseAt already set + public comment → no update, firstResponseStamped false', async () => {
    // Use addTicketComment directly for this case
    const existingDate = new Date('2026-01-05T08:00:00Z');
    dbMocks.selectResult.mockResolvedValue([{
      id: 't-1', orgId: 'o-1', partnerId: 'p-1', status: 'open',
      firstResponseAt: existingDate
    }]);
    dbMocks.insertReturning.mockResolvedValue([{ id: 'c-5', isPublic: true }]);

    const result = await (await import('./ticketService')).addTicketComment(
      't-1', { content: 'Another public reply', isPublic: true }, actor
    );

    expect(result.firstResponseStamped).toBe(false);
    // No update() call touching firstResponseAt
    expect(setMock).not.toHaveBeenCalled();
  });
});

describe('assignTicket — additional status cases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    valuesMock.mockClear();
    setMock.mockClear();
  });

  it('assigns on new ticket: set payload includes status open', async () => {
    dbMocks.selectResult.mockResolvedValue([{
      id: 't-1', orgId: 'o-1', partnerId: 'p-1', status: 'new', assignedTo: null
    }]);
    dbMocks.updateReturning.mockResolvedValue([{ id: 't-1', assignedTo: 'u-2', status: 'open' }]);
    dbMocks.insertReturning.mockResolvedValue([{ id: 'c-1' }]);

    await assignTicket('t-1', 'u-2', actor);

    const updatePayload = setMock.mock.calls[0]![0];
    expect(updatePayload).toMatchObject({ assignedTo: 'u-2', status: 'open' });
  });

  it('assigns on open ticket: set payload does NOT include status', async () => {
    dbMocks.selectResult.mockResolvedValue([{
      id: 't-1', orgId: 'o-1', partnerId: 'p-1', status: 'open', assignedTo: null
    }]);
    dbMocks.updateReturning.mockResolvedValue([{ id: 't-1', assignedTo: 'u-2', status: 'open' }]);
    dbMocks.insertReturning.mockResolvedValue([{ id: 'c-1' }]);

    await assignTicket('t-1', 'u-2', actor);

    const updatePayload = setMock.mock.calls[0]![0];
    expect(updatePayload).toMatchObject({ assignedTo: 'u-2' });
    expect(updatePayload).not.toHaveProperty('status');
  });
});

describe('updateTicketFields', () => {
  const BASE_TICKET = {
    id: 't-1', orgId: 'o-1', partnerId: 'p-1', status: 'open',
    subject: 'Printer offline', description: null, categoryId: null,
    priority: 'normal', dueDate: null, deviceId: null, tags: []
  };

  beforeEach(() => {
    vi.clearAllMocks();
    valuesMock.mockClear();
    setMock.mockClear();
  });

  it('applies changed fields, writes ONE system feed entry with the humanized field list, emits ticket.updated, audits', async () => {
    dbMocks.selectResult.mockResolvedValue([BASE_TICKET]);
    dbMocks.updateReturning.mockResolvedValue([{ ...BASE_TICKET, subject: 'New subject', priority: 'high' }]);
    dbMocks.insertReturning.mockResolvedValue([{ id: 'c-1' }]);

    const t = await updateTicketFields('t-1', { subject: 'New subject', priority: 'high' }, actor);
    expect(t).toMatchObject({ subject: 'New subject', priority: 'high' });

    // Update payload contains the changed fields + updatedAt stamp
    const updatePayload = setMock.mock.calls[0]![0];
    expect(updatePayload).toMatchObject({ subject: 'New subject', priority: 'high' });
    expect(updatePayload.updatedAt).toBeInstanceOf(Date);

    // Exactly ONE feed entry: system, private, lists the changed fields
    expect(valuesMock).toHaveBeenCalledTimes(1);
    const commentPayload = valuesMock.mock.calls[0]![0];
    expect(commentPayload).toMatchObject({
      ticketId: 't-1',
      commentType: 'system',
      isPublic: false,
      authorName: 'Tess Tech',
      content: 'Updated subject, priority'
    });

    expect(emitMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'ticket.updated',
      ticketId: 't-1',
      orgId: 'o-1',
      partnerId: 'p-1',
      actorUserId: 'u-1',
      payload: { changed: ['subject', 'priority'] }
    }));
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({
      orgId: 'o-1',
      actorId: 'u-1',
      action: 'ticket.update',
      resourceType: 'ticket',
      resourceId: 't-1',
      result: 'success'
    }));
  });

  it('no-op update (values identical) returns the ticket unchanged without update/feed/event/audit', async () => {
    dbMocks.selectResult.mockResolvedValue([BASE_TICKET]);

    const t = await updateTicketFields('t-1', { subject: 'Printer offline', priority: 'normal' }, actor);
    expect(t).toBe(BASE_TICKET);

    expect(setMock).not.toHaveBeenCalled();
    expect(valuesMock).not.toHaveBeenCalled();
    expect(emitMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('rejects a deviceId belonging to a different org with a 400 TicketServiceError and writes nothing', async () => {
    // selects in order: ticket, device (cross-org)
    dbMocks.selectResult
      .mockResolvedValueOnce([BASE_TICKET])
      .mockResolvedValueOnce([{ id: 'd-1', orgId: 'o-OTHER' }]);

    const err = await updateTicketFields('t-1', { deviceId: 'd-1' }, actor).catch(e => e);
    expect(err).toBeInstanceOf(TicketServiceError);
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/same organization/i);
    expect(setMock).not.toHaveBeenCalled();
    expect(valuesMock).not.toHaveBeenCalled();
    expect(emitMock).not.toHaveBeenCalled();
  });

  it('rejects an unknown deviceId with a 404 TicketServiceError', async () => {
    dbMocks.selectResult
      .mockResolvedValueOnce([BASE_TICKET])
      .mockResolvedValueOnce([]); // device lookup: no row

    const err = await updateTicketFields('t-1', { deviceId: 'd-missing' }, actor).catch(e => e);
    expect(err).toBeInstanceOf(TicketServiceError);
    expect(err.status).toBe(404);
    expect(err.message).toMatch(/device not found/i);
    expect(setMock).not.toHaveBeenCalled();
  });

  it('clearing deviceId (null) skips the device lookup and records the change', async () => {
    dbMocks.selectResult.mockResolvedValue([{ ...BASE_TICKET, deviceId: 'd-1' }]);
    dbMocks.updateReturning.mockResolvedValue([{ ...BASE_TICKET, deviceId: null }]);
    dbMocks.insertReturning.mockResolvedValue([{ id: 'c-1' }]);

    await updateTicketFields('t-1', { deviceId: null }, actor);

    // Only ONE select consumed (the ticket lookup) — no device lookup for null
    expect(dbMocks.selectResult).toHaveBeenCalledTimes(1);
    expect(emitMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'ticket.updated',
      payload: { changed: ['deviceId'] }
    }));
    expect(valuesMock).toHaveBeenCalledWith(expect.objectContaining({ content: 'Updated device' }));
  });

  it('throws 404 when the ticket does not exist', async () => {
    dbMocks.selectResult.mockResolvedValue([]);
    const err = await updateTicketFields('t-missing', { subject: 'x' }, actor).catch(e => e);
    expect(err).toBeInstanceOf(TicketServiceError);
    expect(err.status).toBe(404);
    expect(err.message).toMatch(/ticket not found/i);
  });

  it('treats equal dueDate (different Date instances) as a no-op but a new dueDate as a change', async () => {
    const due = new Date('2026-07-01T00:00:00Z');
    dbMocks.selectResult.mockResolvedValue([{ ...BASE_TICKET, dueDate: due }]);

    // Same instant, different instance → no-op
    await updateTicketFields('t-1', { dueDate: new Date('2026-07-01T00:00:00Z') }, actor);
    expect(setMock).not.toHaveBeenCalled();
    expect(emitMock).not.toHaveBeenCalled();

    // Different instant → change, humanized as "due date"
    dbMocks.updateReturning.mockResolvedValue([{ ...BASE_TICKET, dueDate: new Date('2026-08-01T00:00:00Z') }]);
    dbMocks.insertReturning.mockResolvedValue([{ id: 'c-1' }]);
    await updateTicketFields('t-1', { dueDate: new Date('2026-08-01T00:00:00Z') }, actor);
    expect(valuesMock).toHaveBeenCalledWith(expect.objectContaining({ content: 'Updated due date' }));
    expect(emitMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'ticket.updated',
      payload: { changed: ['dueDate'] }
    }));
  });

  it('treats deep-equal tags as a no-op', async () => {
    dbMocks.selectResult.mockResolvedValue([{ ...BASE_TICKET, tags: ['vip', 'hardware'] }]);
    await updateTicketFields('t-1', { tags: ['vip', 'hardware'] }, actor);
    expect(setMock).not.toHaveBeenCalled();
    expect(emitMock).not.toHaveBeenCalled();
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
    // selects in order: alert, org (inside createTicket), device (inside createTicket),
    // ticket (inside linkAlertToTicket), alert (inside linkAlertToTicket)
    dbMocks.selectResult
      .mockResolvedValueOnce([{ id: 'a-1', orgId: 'o-1', deviceId: 'd-1', title: 'Disk 90%', message: 'C: at 92%', severity: 'high' }])
      .mockResolvedValueOnce([{ id: 'o-1', partnerId: 'p-1' }])
      .mockResolvedValueOnce([{ id: 'd-1', orgId: 'o-1' }])
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

  it('link failure after create → rejects with plain Error (not TicketServiceError), making create+link atomic', async () => {
    // Selects: alert, org (createTicket), ticket (linkAlertToTicket), alert (linkAlertToTicket)
    dbMocks.selectResult
      .mockResolvedValueOnce([{ id: 'a-2', orgId: 'o-1', deviceId: null, title: 'CPU high', message: null, severity: 'critical' }])
      .mockResolvedValueOnce([{ id: 'o-1', partnerId: 'p-1' }])
      .mockResolvedValueOnce([{ id: 't-10', orgId: 'o-1', partnerId: 'p-1', status: 'new', internalNumber: 'T-2026-0042' }])
      .mockResolvedValueOnce([{ id: 'a-2', orgId: 'o-2', title: 'CPU high' }]); // different org → link throws 400
    dbMocks.insertReturning.mockResolvedValue([{ id: 't-10', orgId: 'o-1', internalNumber: 'T-2026-0042' }]);

    const err = await createTicketFromAlert('a-2', actor).catch(e => e);
    // Must NOT be TicketServiceError — must be a plain Error so it bubbles past
    // the route's handleServiceError catch and triggers a transaction rollback.
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(TicketServiceError);
    expect(err.message).toMatch(/created but alert link failed/i);
  });
});

describe('category tenant validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    valuesMock.mockClear();
    setMock.mockClear();
    allocateMock.mockResolvedValue('T-2026-0042');
  });

  it('createTicket rejects a category from another partner with 400', async () => {
    dbMocks.selectResult
      .mockResolvedValueOnce([{ id: 'o-1', partnerId: 'p-1' }])        // org
      .mockResolvedValueOnce([{ id: 'cat-1', partnerId: 'p-OTHER' }]); // category

    const err = await createTicket(
      { orgId: 'o-1', subject: 'x', source: 'manual', categoryId: 'cat-1' }, actor
    ).catch(e => e);

    expect(err).toBeInstanceOf(TicketServiceError);
    expect(err.status).toBe(400);
    expect(allocateMock).not.toHaveBeenCalled();
  });

  it('createTicket rejects a nonexistent category with 404', async () => {
    dbMocks.selectResult
      .mockResolvedValueOnce([{ id: 'o-1', partnerId: 'p-1' }]) // org
      .mockResolvedValueOnce([]);                                // category missing

    const err = await createTicket(
      { orgId: 'o-1', subject: 'x', source: 'manual', categoryId: 'cat-ghost' }, actor
    ).catch(e => e);

    expect(err).toBeInstanceOf(TicketServiceError);
    expect(err.status).toBe(404);
  });

  it('createTicket accepts a same-partner category', async () => {
    dbMocks.selectResult
      .mockResolvedValueOnce([{ id: 'o-1', partnerId: 'p-1' }])    // org
      .mockResolvedValueOnce([{ id: 'cat-1', partnerId: 'p-1' }]); // category
    dbMocks.insertReturning.mockResolvedValue([{ id: 't-3', orgId: 'o-1', internalNumber: 'T-2026-0044', status: 'new' }]);

    await createTicket({ orgId: 'o-1', subject: 'x', source: 'manual', categoryId: 'cat-1' }, actor);

    expect(valuesMock.mock.calls[0]![0]).toMatchObject({ categoryId: 'cat-1' });
  });

  it('updateTicketFields rejects a cross-partner category with 400', async () => {
    dbMocks.selectResult
      .mockResolvedValueOnce([{ id: 't-1', orgId: 'o-1', partnerId: 'p-1', categoryId: null, subject: 'Printer' }]) // ticket
      .mockResolvedValueOnce([{ id: 'cat-1', partnerId: 'p-OTHER' }]);                                              // category

    const err = await updateTicketFields('t-1', { categoryId: 'cat-1' }, actor).catch(e => e);

    expect(err).toBeInstanceOf(TicketServiceError);
    expect(err.status).toBe(400);
    expect(setMock).not.toHaveBeenCalled();
  });

  it('updateTicketFields allows clearing the category (null) without a lookup', async () => {
    dbMocks.selectResult
      .mockResolvedValueOnce([{ id: 't-1', orgId: 'o-1', partnerId: 'p-1', categoryId: 'cat-1', subject: 'Printer' }]); // ticket only
    dbMocks.updateReturning.mockResolvedValue([{ id: 't-1', categoryId: null }]);
    dbMocks.insertReturning.mockResolvedValue([{ id: 'c-1' }]); // system feed comment insert

    const t = await updateTicketFields('t-1', { categoryId: null }, actor);
    expect(t?.categoryId).toBeNull();
    expect(dbMocks.selectResult).toHaveBeenCalledTimes(1); // no category lookup
  });
});

describe('assignee tenant validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    valuesMock.mockClear();
    setMock.mockClear();
    allocateMock.mockResolvedValue('T-2026-0042');
  });

  it('createTicket rejects an assignee from another partner with 400', async () => {
    dbMocks.selectResult
      .mockResolvedValueOnce([{ id: 'o-1', partnerId: 'p-1' }])      // org
      .mockResolvedValueOnce([{ id: 'u-evil', partnerId: 'p-OTHER' }]); // assignee

    const err = await createTicket(
      { orgId: 'o-1', subject: 'x', source: 'manual', assigneeId: 'u-evil' }, actor
    ).catch(e => e);

    expect(err).toBeInstanceOf(TicketServiceError);
    expect(err.status).toBe(400);
    expect(allocateMock).not.toHaveBeenCalled(); // rejected before burning a counter value
  });

  it('createTicket rejects a nonexistent assignee with 404', async () => {
    dbMocks.selectResult
      .mockResolvedValueOnce([{ id: 'o-1', partnerId: 'p-1' }]) // org
      .mockResolvedValueOnce([]);                                // assignee missing

    const err = await createTicket(
      { orgId: 'o-1', subject: 'x', source: 'manual', assigneeId: 'u-ghost' }, actor
    ).catch(e => e);

    expect(err).toBeInstanceOf(TicketServiceError);
    expect(err.status).toBe(404);
  });

  it('createTicket accepts a same-partner assignee', async () => {
    dbMocks.selectResult
      .mockResolvedValueOnce([{ id: 'o-1', partnerId: 'p-1' }])  // org
      .mockResolvedValueOnce([{ id: 'u-99', partnerId: 'p-1' }]); // assignee
    dbMocks.insertReturning.mockResolvedValue([{ id: 't-2', orgId: 'o-1', internalNumber: 'T-2026-0043', status: 'open' }]);

    await createTicket({ orgId: 'o-1', subject: 'Test', source: 'manual', assigneeId: 'u-99' }, actor);

    expect(valuesMock.mock.calls[0]![0]).toMatchObject({ status: 'open', assignedTo: 'u-99' });
  });

  it('assignTicket rejects an assignee from another partner with 400', async () => {
    dbMocks.selectResult
      .mockResolvedValueOnce([{ id: 't-1', orgId: 'o-1', partnerId: 'p-1', status: 'new', assignedTo: null }]) // ticket
      .mockResolvedValueOnce([{ id: 'u-evil', partnerId: 'p-OTHER' }]);                                        // assignee

    const err = await assignTicket('t-1', 'u-evil', actor).catch(e => e);

    expect(err).toBeInstanceOf(TicketServiceError);
    expect(err.status).toBe(400);
    expect(setMock).not.toHaveBeenCalled();
  });

  it('assignTicket resolves partner via the org when ticket.partnerId is null (legacy row)', async () => {
    dbMocks.selectResult
      .mockResolvedValueOnce([{ id: 't-1', orgId: 'o-1', partnerId: null, status: 'new', assignedTo: null }]) // ticket
      .mockResolvedValueOnce([{ partnerId: 'p-1' }])                                                          // org fallback
      .mockResolvedValueOnce([{ id: 'u-2', partnerId: 'p-1' }]);                                              // assignee
    dbMocks.updateReturning.mockResolvedValue([{ id: 't-1', assignedTo: 'u-2', status: 'open' }]);

    const t = await assignTicket('t-1', 'u-2', actor);
    expect(t?.assignedTo).toBe('u-2');
  });

  it('assignTicket skips validation when unassigning (null assignee)', async () => {
    dbMocks.selectResult
      .mockResolvedValueOnce([{ id: 't-1', orgId: 'o-1', partnerId: 'p-1', status: 'open', assignedTo: 'u-2' }]); // ticket only
    dbMocks.updateReturning.mockResolvedValue([{ id: 't-1', assignedTo: null }]);

    const t = await assignTicket('t-1', null, actor);
    expect(t?.assignedTo).toBeNull();
    expect(dbMocks.selectResult).toHaveBeenCalledTimes(1); // no user lookup
  });

  it('assignTicket fails closed (500, not a blame-the-input 400) when the ticket partner is unresolvable', async () => {
    // Legacy ticket with null partnerId whose org row is also missing — broken
    // data. The guard must not report this as a cross-partner assignee problem.
    dbMocks.selectResult
      .mockResolvedValueOnce([{ id: 't-1', orgId: 'o-gone', partnerId: null, status: 'new', assignedTo: null }]) // ticket
      .mockResolvedValueOnce([])                                  // org fallback: missing
      .mockResolvedValueOnce([{ id: 'u-2', partnerId: 'p-1' }]); // assignee exists

    const err = await assignTicket('t-1', 'u-2', actor).catch(e => e);

    expect(err).toBeInstanceOf(TicketServiceError);
    expect(err.status).toBe(500);
    expect(err.code).toBe('TICKET_PARTNER_UNRESOLVABLE');
    expect(setMock).not.toHaveBeenCalled();
  });
});
