import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Recorders for insert().values(v), update().set(v), and update().set().where(w) arguments
const valuesMock = vi.fn();
const setMock = vi.fn();
const whereMock = vi.fn();

const { emitMock, emitTriageFeedbackMock, auditMock, allocateMock, dbMocks, configMocks } = vi.hoisted(() => {
  const insertReturning = vi.fn();
  const updateReturning = vi.fn();
  const selectResult = vi.fn();
  const txExecuteMock = vi.fn().mockResolvedValue(undefined);
  const txUpdateReturning = vi.fn();
  return {
    emitMock: vi.fn().mockResolvedValue(undefined),
    emitTriageFeedbackMock: vi.fn().mockResolvedValue(undefined),
    auditMock: vi.fn().mockResolvedValue(undefined),
    allocateMock: vi.fn().mockResolvedValue('T-2026-0042'),
    dbMocks: { insertReturning, updateReturning, selectResult, txExecuteMock, txUpdateReturning },
    configMocks: {
      getOrgSlaOverride: vi.fn().mockResolvedValue({ responseMinutes: null, resolutionMinutes: null }),
      getPartnerPrioritySla: vi.fn().mockResolvedValue({ responseMinutes: null, resolutionMinutes: null }),
      getSystemStatusId: vi.fn().mockResolvedValue(null),
      getTicketStatusById: vi.fn().mockResolvedValue(null),
    }
  };
});

vi.mock('./ticketEvents', () => ({ emitTicketEvent: emitMock }));
vi.mock('./mlFeedbackEmitters', () => ({ emitTicketTriageFeedback: emitTriageFeedbackMock }));
vi.mock('./auditService', () => ({ createAuditLogAsync: auditMock }));
vi.mock('./ticketNumbers', () => ({ allocateInternalTicketNumber: allocateMock }));
vi.mock('./ticketConfigService', () => ({
  getOrgSlaOverride: (...args: unknown[]) => configMocks.getOrgSlaOverride(...args),
  getPartnerPrioritySla: (...args: unknown[]) => configMocks.getPartnerPrioritySla(...args),
  getSystemStatusId: (...args: unknown[]) => configMocks.getSystemStatusId(...args),
  getTicketStatusById: (...args: unknown[]) => configMocks.getTicketStatusById(...args),
}));

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
          where: vi.fn((w) => {
            whereMock(w);
            return { returning: vi.fn(() => dbMocks.updateReturning()) };
          })
        };
      })
    })),
    delete: vi.fn(() => ({
      where: vi.fn(() => ({ returning: vi.fn(() => dbMocks.insertReturning()) }))
    })),
    // Transaction mock: invokes callback with a tx stub that records SET/VALUES
    // calls through the same recorders so tests can assert on child table UPDATEs.
    transaction: vi.fn(async (fn: (tx: unknown) => unknown) => {
      const tx = {
        update: vi.fn(() => ({
          set: vi.fn((v) => {
            setMock(v);
            return {
              where: vi.fn((w) => {
                whereMock(w);
                return { returning: vi.fn(() => dbMocks.txUpdateReturning()) };
              })
            };
          })
        })),
        insert: vi.fn(() => ({
          values: vi.fn((v) => {
            valuesMock(v);
            return { returning: vi.fn(() => dbMocks.insertReturning()) };
          })
        })),
        execute: vi.fn((...args) => dbMocks.txExecuteMock(...args)),
      };
      return fn(tx);
    })
  }
}));
vi.mock('../db/schema', () => ({
  tickets: { id: 'id', orgId: 'orgId', status: 'status', assignedTo: 'assignedTo', statusId: 'statusId' },
  ticketComments: {},
  ticketAlertLinks: { ticketId: 'ticketId', alertId: 'alertId' },
  ticketParts: { ticketId: 'ticketId', orgId: 'orgId' },
  organizations: { id: 'id', partnerId: 'partnerId', name: 'name' },
  alerts: { id: 'id', orgId: 'orgId' },
  devices: { id: 'id', orgId: 'orgId' },
  users: { id: 'id', partnerId: 'partnerId' },
  ticketCategories: { id: 'id', partnerId: 'partnerId', responseSlaMinutes: 'responseSlaMinutes', resolutionSlaMinutes: 'resolutionSlaMinutes' },
  portalUsers: { id: 'id', orgId: 'orgId', name: 'name', email: 'email', status: 'status' },
  ticketStatusEnum: { enumValues: ['new', 'open', 'pending', 'on_hold', 'resolved', 'closed'] },
  ticketSourceEnum: { enumValues: ['portal', 'email', 'alert', 'manual', 'api', 'ai'] }
}));

import {
  createTicket, changeTicketStatus, assignTicket, addTicketComment,
  linkAlertToTicket, unlinkAlertFromTicket, createTicketFromAlert,
  updateTicketFields, editTicketComment, deleteTicketComment, portalCommentMutable,
  moveTicketOrg, softDeleteTicket, restoreTicket,
  TicketServiceError, TICKET_STATUS_TRANSITIONS, SYSTEM_COMMENT_TYPES
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

  it('manual ticket with a picked portal-user requester stamps submittedBy + backfilled name/email', async () => {
    // selects in order: org, portal user
    dbMocks.selectResult
      .mockResolvedValueOnce([{ id: 'o-1', partnerId: 'p-1' }])
      .mockResolvedValueOnce([{ id: 'pu-1', orgId: 'o-1', name: 'Jane Doe', email: 'jane@example.com' }]);
    dbMocks.insertReturning.mockResolvedValue([{ id: 't-6', orgId: 'o-1', internalNumber: 'T-2026-0042', status: 'new' }]);

    await createTicket({ orgId: 'o-1', subject: 'Crash', source: 'manual', submittedBy: 'pu-1' }, actor);

    const insertPayload = valuesMock.mock.calls[0]![0];
    expect(insertPayload).toMatchObject({
      submittedBy: 'pu-1',
      submitterName: 'Jane Doe',
      submitterEmail: 'jane@example.com'
    });
  });

  it('manual ticket with explicit submitterName/email overrides the portal-user backfill', async () => {
    dbMocks.selectResult
      .mockResolvedValueOnce([{ id: 'o-1', partnerId: 'p-1' }])
      .mockResolvedValueOnce([{ id: 'pu-1', orgId: 'o-1', name: 'Jane Doe', email: 'jane@example.com' }]);
    dbMocks.insertReturning.mockResolvedValue([{ id: 't-7', orgId: 'o-1', internalNumber: 'T-2026-0042', status: 'new' }]);

    await createTicket(
      { orgId: 'o-1', subject: 'Crash', source: 'manual', submittedBy: 'pu-1', submitterName: 'Front Desk User', submitterEmail: 'frontdesk@example.com' },
      actor
    );

    expect(valuesMock.mock.calls[0]![0]).toMatchObject({
      submittedBy: 'pu-1',
      submitterName: 'Front Desk User',
      submitterEmail: 'frontdesk@example.com'
    });
  });

  it('manual ticket with a free-text requester (no portal user) stamps name/email, no submittedBy', async () => {
    dbMocks.selectResult.mockResolvedValue([{ id: 'o-1', partnerId: 'p-1' }]);
    dbMocks.insertReturning.mockResolvedValue([{ id: 't-8', orgId: 'o-1', internalNumber: 'T-2026-0042', status: 'new' }]);

    await createTicket(
      { orgId: 'o-1', subject: 'Crash', source: 'manual', submitterName: 'Walk-in User', submitterEmail: 'walkin@example.com' },
      actor
    );

    // Only ONE select consumed (org) — no portal-user lookup for free-text.
    expect(dbMocks.selectResult).toHaveBeenCalledTimes(1);
    expect(valuesMock.mock.calls[0]![0]).toMatchObject({
      submittedBy: null,
      submitterName: 'Walk-in User',
      submitterEmail: 'walkin@example.com'
    });
  });

  it('rejects a requester portal user from a different org (cross-tenant) and writes nothing', async () => {
    dbMocks.selectResult
      .mockResolvedValueOnce([{ id: 'o-1', partnerId: 'p-1' }])
      .mockResolvedValueOnce([{ id: 'pu-x', orgId: 'o-OTHER', name: 'Intruder', email: 'x@evil.com' }]);

    const err = await createTicket(
      { orgId: 'o-1', subject: 'Crash', source: 'manual', submittedBy: 'pu-x' }, actor
    ).catch(e => e);

    expect(err).toBeInstanceOf(TicketServiceError);
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/organization/i);
    expect(allocateMock).not.toHaveBeenCalled();
    expect(valuesMock).not.toHaveBeenCalled();
  });

  it('rejects an unknown requester portal user with a 404', async () => {
    dbMocks.selectResult
      .mockResolvedValueOnce([{ id: 'o-1', partnerId: 'p-1' }])
      .mockResolvedValueOnce([]); // portal user lookup: no row

    const err = await createTicket(
      { orgId: 'o-1', subject: 'Crash', source: 'manual', submittedBy: 'pu-missing' }, actor
    ).catch(e => e);

    expect(err).toBeInstanceOf(TicketServiceError);
    expect(err.status).toBe(404);
    expect(valuesMock).not.toHaveBeenCalled();
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

  it('stamps SLA targets from the category when set', async () => {
    // selects: org, category (with SLA fields set)
    dbMocks.selectResult
      .mockResolvedValueOnce([{ id: 'o-1', partnerId: 'p-1' }])
      .mockResolvedValueOnce([{ id: 'cat-1', partnerId: 'p-1', responseSlaMinutes: 30, resolutionSlaMinutes: 120 }]);
    dbMocks.insertReturning.mockResolvedValue([{ id: 't-sla-1', orgId: 'o-1', internalNumber: 'T-2026-0042', status: 'new' }]);

    await createTicket({ orgId: 'o-1', subject: 'SLA test', source: 'manual', categoryId: 'cat-1', priority: 'urgent' }, actor);

    const insertPayload = valuesMock.mock.calls[0]![0];
    expect(insertPayload).toMatchObject({ responseSlaMinutes: 30, resolutionSlaMinutes: 120 });
  });

  it('falls back to priority defaults when the category has no SLA', async () => {
    // selects: org, category (with null SLA fields)
    dbMocks.selectResult
      .mockResolvedValueOnce([{ id: 'o-1', partnerId: 'p-1' }])
      .mockResolvedValueOnce([{ id: 'cat-1', partnerId: 'p-1', responseSlaMinutes: null, resolutionSlaMinutes: null }]);
    dbMocks.insertReturning.mockResolvedValue([{ id: 't-sla-2', orgId: 'o-1', internalNumber: 'T-2026-0042', status: 'new' }]);

    await createTicket({ orgId: 'o-1', subject: 'SLA fallback', source: 'manual', categoryId: 'cat-1', priority: 'urgent' }, actor);

    // urgent priority defaults: response=60, resolution=240
    const insertPayload = valuesMock.mock.calls[0]![0];
    expect(insertPayload).toMatchObject({ responseSlaMinutes: 60, resolutionSlaMinutes: 240 });
  });

  it('stamps no SLA for normal priority without category targets', async () => {
    // no categoryId → no category select
    dbMocks.selectResult.mockResolvedValueOnce([{ id: 'o-1', partnerId: 'p-1' }]);
    dbMocks.insertReturning.mockResolvedValue([{ id: 't-sla-3', orgId: 'o-1', internalNumber: 'T-2026-0042', status: 'new' }]);

    await createTicket({ orgId: 'o-1', subject: 'No SLA', source: 'manual', priority: 'normal' }, actor);

    const insertPayload = valuesMock.mock.calls[0]![0];
    expect(insertPayload).toMatchObject({ responseSlaMinutes: null, resolutionSlaMinutes: null });
  });

  it('stamps no SLA when priority is omitted entirely', async () => {
    // no priority key, no categoryId → implicit 'normal' default → null SLA targets
    dbMocks.selectResult.mockResolvedValueOnce([{ id: 'o-1', partnerId: 'p-1' }]);
    dbMocks.insertReturning.mockResolvedValue([{ id: 't-sla-4', orgId: 'o-1', internalNumber: 'T-2026-0042', status: 'new' }]);

    await createTicket({ orgId: 'o-1', subject: 'No priority field', source: 'manual' }, actor);

    const insertPayload = valuesMock.mock.calls[0]![0];
    expect(insertPayload).toMatchObject({ responseSlaMinutes: null, resolutionSlaMinutes: null });
  });

  it('stamps org override (120) when no category and org has sla override', async () => {
    dbMocks.selectResult.mockResolvedValueOnce([{ id: 'o-1', partnerId: 'p-1' }]);
    configMocks.getOrgSlaOverride.mockResolvedValueOnce({ responseMinutes: 120, resolutionMinutes: 480 });
    configMocks.getPartnerPrioritySla.mockResolvedValueOnce({ responseMinutes: 90, resolutionMinutes: 360 });
    dbMocks.insertReturning.mockResolvedValue([{ id: 't-sla-5', orgId: 'o-1', internalNumber: 'T-2026-0042', status: 'new' }]);

    await createTicket({ orgId: 'o-1', subject: 'Org SLA override', source: 'manual', priority: 'urgent' }, actor);

    const insertPayload = valuesMock.mock.calls[0]![0];
    // org beats partner: response 120 wins over partner 90
    expect(insertPayload).toMatchObject({ responseSlaMinutes: 120, resolutionSlaMinutes: 480 });
  });

  it('stamps partner setting (90) when no category and no org override', async () => {
    dbMocks.selectResult.mockResolvedValueOnce([{ id: 'o-1', partnerId: 'p-1' }]);
    configMocks.getOrgSlaOverride.mockResolvedValueOnce({ responseMinutes: null, resolutionMinutes: null });
    configMocks.getPartnerPrioritySla.mockResolvedValueOnce({ responseMinutes: 90, resolutionMinutes: 360 });
    dbMocks.insertReturning.mockResolvedValue([{ id: 't-sla-6', orgId: 'o-1', internalNumber: 'T-2026-0042', status: 'new' }]);

    await createTicket({ orgId: 'o-1', subject: 'Partner SLA', source: 'manual', priority: 'urgent' }, actor);

    const insertPayload = valuesMock.mock.calls[0]![0];
    // partner beats hardcoded default (urgent is 60/240): response 90 wins
    expect(insertPayload).toMatchObject({ responseSlaMinutes: 90, resolutionSlaMinutes: 360 });
  });

  it('persists submitterEmail/submitterName for source:email', async () => {
    dbMocks.selectResult.mockResolvedValue([{ id: 'o-1', partnerId: 'p-1' }]);
    dbMocks.insertReturning.mockResolvedValue([{ id: 't-email-1', orgId: 'o-1', internalNumber: 'T-2026-0042', status: 'new' }]);

    await createTicket(
      { orgId: 'o-1', subject: 'printer', source: 'email', submitterEmail: 'jane@x.com', submitterName: 'Jane' },
      actor
    );

    const insertPayload = valuesMock.mock.calls[0]![0];
    expect(insertPayload).toMatchObject({
      source: 'email',
      submitterEmail: 'jane@x.com',
      submitterName: 'Jane',
      submittedBy: null,
    });
  });

  it('email source with no submitterName sets submitterName to null (not actor name)', async () => {
    dbMocks.selectResult.mockResolvedValue([{ id: 'o-1', partnerId: 'p-1' }]);
    dbMocks.insertReturning.mockResolvedValue([{ id: 't-email-2', orgId: 'o-1', internalNumber: 'T-2026-0042', status: 'new' }]);

    await createTicket(
      { orgId: 'o-1', subject: 'printer', source: 'email', submitterEmail: 'jane@x.com' },
      { userId: 'u-sys', name: 'System' }
    );

    const insertPayload = valuesMock.mock.calls[0]![0];
    expect(insertPayload).toMatchObject({
      submitterEmail: 'jane@x.com',
      submitterName: null,
      submittedBy: null,
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
    const err = await changeTicketStatus('t-1', { status: 'pending' }, {}, actor).catch(e => e);
    expect(err).toBeInstanceOf(TicketServiceError);
    expect(err.status).toBe(409);
    expect(err.message).toMatch(/cannot transition/i);
  });

  it('stamps resolvedAt + resolutionNote on resolve and writes a status_change feed entry', async () => {
    dbMocks.selectResult.mockResolvedValue([{ id: 't-1', orgId: 'o-1', partnerId: 'p-1', status: 'open', resolvedAt: null }]);
    dbMocks.updateReturning.mockResolvedValue([{ id: 't-1', status: 'resolved' }]);
    dbMocks.insertReturning.mockResolvedValue([{ id: 'c-1' }]);

    await changeTicketStatus('t-1', { status: 'resolved' }, { resolutionNote: 'Replaced toner' }, actor);

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
    const err = await changeTicketStatus('t-1', { status: 'resolved' }, {}, actor).catch(e => e);
    expect(err).toBeInstanceOf(TicketServiceError);
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/resolution note/i);
  });

  it('throws 409 on concurrent modification and does NOT write a feed entry or emit', async () => {
    dbMocks.selectResult.mockResolvedValue([{ id: 't-1', orgId: 'o-1', partnerId: 'p-1', status: 'open', resolvedAt: null }]);
    // Simulate concurrent update: zero rows returned from update
    dbMocks.updateReturning.mockResolvedValue([]);

    const err = await changeTicketStatus('t-1', { status: 'pending' }, {}, actor).catch(e => e);
    expect(err).toBeInstanceOf(TicketServiceError);
    expect(err.status).toBe(409);
    expect(err.message).toMatch(/concurrently/i);
    // No comment insert, no event
    expect(valuesMock).not.toHaveBeenCalled();
    expect(emitMock).not.toHaveBeenCalled();
  });

  it('returns the ticket unchanged on same-status no-op', async () => {
    const ticket = { id: 't-1', orgId: 'o-1', partnerId: 'p-1', status: 'open', statusId: 'statusId' };
    dbMocks.selectResult.mockResolvedValue([ticket]);
    // getSystemStatusId must return the same statusId as the ticket so the no-op check passes
    configMocks.getSystemStatusId.mockResolvedValueOnce('statusId');

    const result = await changeTicketStatus('t-1', { status: 'open' }, {}, actor);
    expect(result).toBe(ticket);
    // No update issued
    expect(setMock).not.toHaveBeenCalled();
    expect(emitMock).not.toHaveBeenCalled();
  });

  it('fast path with custom statusId writes a feed entry when customStatusName is present', async () => {
    // same core 'open' but different statusId → fast path; custom status has a name
    const ticket = { id: 't-1', orgId: 'o-1', partnerId: 'p-1', status: 'open', statusId: 'old-status-id' };
    dbMocks.selectResult.mockResolvedValue([ticket]);
    configMocks.getTicketStatusById.mockResolvedValueOnce({
      id: 'new-status-id', partnerId: 'p-1', coreStatus: 'open', name: 'Waiting on Customer', isActive: true
    });
    dbMocks.updateReturning.mockResolvedValue([{ ...ticket, statusId: 'new-status-id' }]);
    dbMocks.insertReturning.mockResolvedValue([{ id: 'c-1' }]);

    await changeTicketStatus('t-1', { statusId: 'new-status-id' }, {}, actor);

    // Feed entry must be written with the custom status name as content
    const commentPayload = valuesMock.mock.calls[0]![0];
    expect(commentPayload).toMatchObject({
      commentType: 'status_change',
      content: 'Waiting on Customer',
      oldValue: 'open',
      newValue: 'open'
    });
    // Core status unchanged → no event
    expect(emitMock).not.toHaveBeenCalled();
  });

  it('fast path legacy same-core revert skips feed entry when customStatusName is absent', async () => {
    // legacy {status} call — resolvedStatusId resolves to the system row but
    // core status is the same → fast path; no customStatusName → no feed row
    const ticket = { id: 't-1', orgId: 'o-1', partnerId: 'p-1', status: 'open', statusId: 'custom-status-id' };
    dbMocks.selectResult.mockResolvedValue([ticket]);
    // getSystemStatusId returns a different id → fast path triggers
    configMocks.getSystemStatusId.mockResolvedValueOnce('system-status-id');
    dbMocks.updateReturning.mockResolvedValue([{ ...ticket, statusId: 'system-status-id' }]);

    await changeTicketStatus('t-1', { status: 'open' }, {}, actor);

    // statusId was updated (the update was issued)
    expect(setMock).toHaveBeenCalled();
    // But NO feed comment should be written — empty content + identical old/new values
    expect(valuesMock).not.toHaveBeenCalled();
    // No event either
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
    expect(emitTriageFeedbackMock).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'ticket.assignee_changed',
      dedupeKey: 'assignedTo:null:"u-2"',
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

    await changeTicketStatus('t-1', { status: 'open' }, {}, actor);

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

    await changeTicketStatus('t-1', { status: 'closed' }, {}, actor);

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

    await changeTicketStatus('t-1', { status: 'pending' }, { pendingReason: 'waiting on customer' }, actor);

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

    await changeTicketStatus('t-1', { status: 'open' }, {}, actor);

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
    expect(emitTriageFeedbackMock).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'ticket.priority_changed',
      dedupeKey: 'priority:"normal":"high"',
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

  it('updateTicketFields persists SLA overrides and labels them in the feed comment', async () => {
    dbMocks.selectResult.mockResolvedValue([BASE_TICKET]);
    dbMocks.updateReturning.mockResolvedValue([{ ...BASE_TICKET, responseSlaMinutes: 15 }]);
    dbMocks.insertReturning.mockResolvedValue([{ id: 'c-1' }]);

    await updateTicketFields('t-1', { responseSlaMinutes: 15 }, actor);

    const updatePayload = setMock.mock.calls[0]![0];
    expect(updatePayload).toMatchObject({ responseSlaMinutes: 15 });
    expect(valuesMock).toHaveBeenCalledWith(expect.objectContaining({
      commentType: 'system',
      content: expect.stringContaining('response SLA')
    }));
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

  it('editing the requester to a portal user backfills name/email and records a "requester" change', async () => {
    // selects in order: ticket, portal user
    dbMocks.selectResult
      .mockResolvedValueOnce([{ ...BASE_TICKET, submittedBy: null, submitterName: 'Tess Tech', submitterEmail: null }])
      .mockResolvedValueOnce([{ id: 'pu-1', orgId: 'o-1', name: 'Jane Doe', email: 'jane@example.com' }]);
    dbMocks.updateReturning.mockResolvedValue([{ ...BASE_TICKET, submittedBy: 'pu-1' }]);
    dbMocks.insertReturning.mockResolvedValue([{ id: 'c-1' }]);

    await updateTicketFields('t-1', { submittedBy: 'pu-1' }, actor);

    const updatePayload = setMock.mock.calls[0]![0];
    expect(updatePayload).toMatchObject({
      submittedBy: 'pu-1',
      submitterName: 'Jane Doe',
      submitterEmail: 'jane@example.com'
    });
    expect(valuesMock).toHaveBeenCalledWith(expect.objectContaining({ content: 'Updated requester' }));
    expect(emitMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'ticket.updated' }));
  });

  it('editing the requester to a portal user with explicit name/email overrides the backfill', async () => {
    dbMocks.selectResult
      .mockResolvedValueOnce([{ ...BASE_TICKET, submittedBy: null, submitterName: 'Tess Tech', submitterEmail: null }])
      .mockResolvedValueOnce([{ id: 'pu-1', orgId: 'o-1', name: 'Jane Doe', email: 'jane@example.com' }]);
    dbMocks.updateReturning.mockResolvedValue([{ ...BASE_TICKET, submittedBy: 'pu-1' }]);
    dbMocks.insertReturning.mockResolvedValue([{ id: 'c-1' }]);

    await updateTicketFields(
      't-1',
      { submittedBy: 'pu-1', submitterName: 'Front Desk User', submitterEmail: 'frontdesk@example.com' },
      actor
    );

    expect(setMock.mock.calls[0]![0]).toMatchObject({
      submittedBy: 'pu-1',
      submitterName: 'Front Desk User',
      submitterEmail: 'frontdesk@example.com'
    });
  });

  it('records a field change AND a requester change in one update (combined feed/event)', async () => {
    dbMocks.selectResult.mockResolvedValue([{ ...BASE_TICKET, submittedBy: null, submitterName: 'Pat', submitterEmail: null }]);
    dbMocks.updateReturning.mockResolvedValue([{ ...BASE_TICKET, priority: 'high', submitterName: 'Walk-in' }]);
    dbMocks.insertReturning.mockResolvedValue([{ id: 'c-1' }]);

    await updateTicketFields('t-1', { priority: 'high', submittedBy: null, submitterName: 'Walk-in', submitterEmail: null }, actor);

    expect(valuesMock).toHaveBeenCalledWith(expect.objectContaining({ content: 'Updated priority, requester' }));
    expect(emitMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'ticket.updated',
      payload: { changed: ['priority', 'requester'] }
    }));
  });

  it('editing the requester to free text clears the portal link', async () => {
    dbMocks.selectResult.mockResolvedValue([{ ...BASE_TICKET, submittedBy: 'pu-1', submitterName: 'Jane', submitterEmail: 'jane@example.com' }]);
    dbMocks.updateReturning.mockResolvedValue([{ ...BASE_TICKET, submittedBy: null }]);
    dbMocks.insertReturning.mockResolvedValue([{ id: 'c-1' }]);

    await updateTicketFields('t-1', { submittedBy: null, submitterName: 'Walk-in', submitterEmail: null }, actor);

    // No portal-user lookup needed when clearing — only the ticket select.
    expect(dbMocks.selectResult).toHaveBeenCalledTimes(1);
    expect(setMock.mock.calls[0]![0]).toMatchObject({
      submittedBy: null,
      submitterName: 'Walk-in',
      submitterEmail: null
    });
    expect(valuesMock).toHaveBeenCalledWith(expect.objectContaining({ content: 'Updated requester' }));
  });

  it('rejects a requester portal user from another org on update and writes nothing', async () => {
    dbMocks.selectResult
      .mockResolvedValueOnce([BASE_TICKET])
      .mockResolvedValueOnce([{ id: 'pu-x', orgId: 'o-OTHER', name: 'Intruder', email: 'x@evil.com' }]);

    const err = await updateTicketFields('t-1', { submittedBy: 'pu-x' }, actor).catch(e => e);
    expect(err).toBeInstanceOf(TicketServiceError);
    expect(err.status).toBe(400);
    expect(setMock).not.toHaveBeenCalled();
    expect(valuesMock).not.toHaveBeenCalled();
  });

  it('no-op when the requester is unchanged', async () => {
    dbMocks.selectResult.mockResolvedValue([{ ...BASE_TICKET, submittedBy: null, submitterName: 'Jane', submitterEmail: 'jane@example.com' }]);
    await updateTicketFields('t-1', { submittedBy: null, submitterName: 'Jane', submitterEmail: 'jane@example.com' }, actor);
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

describe('changeTicketStatus — SLA pause/resume (D4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    valuesMock.mockClear();
    setMock.mockClear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sets slaPausedAt when entering pending', async () => {
    const now = new Date('2026-06-11T10:00:00Z');
    vi.setSystemTime(now);

    dbMocks.selectResult.mockResolvedValue([{
      id: 't-1', orgId: 'o-1', partnerId: 'p-1',
      status: 'open',
      slaPausedAt: null,
      slaPausedMinutes: 0
    }]);
    dbMocks.updateReturning.mockResolvedValue([{ id: 't-1', status: 'pending' }]);
    dbMocks.insertReturning.mockResolvedValue([{ id: 'c-1' }]);

    await changeTicketStatus('t-1', { status: 'pending' }, {}, actor);

    const updatePayload = setMock.mock.calls[0]![0];
    expect(updatePayload.slaPausedAt).toBeInstanceOf(Date);
  });

  it('folds paused time into slaPausedMinutes when leaving on_hold', async () => {
    const now = new Date('2026-06-11T10:30:00Z');
    vi.setSystemTime(now);
    const pausedAt = new Date('2026-06-11T10:00:00Z'); // 30 minutes ago

    dbMocks.selectResult.mockResolvedValue([{
      id: 't-1', orgId: 'o-1', partnerId: 'p-1',
      status: 'on_hold',
      slaPausedAt: pausedAt,
      slaPausedMinutes: 10
    }]);
    dbMocks.updateReturning.mockResolvedValue([{ id: 't-1', status: 'open' }]);
    dbMocks.insertReturning.mockResolvedValue([{ id: 'c-1' }]);

    await changeTicketStatus('t-1', { status: 'open' }, {}, actor);

    const updatePayload = setMock.mock.calls[0]![0];
    expect(updatePayload.slaPausedAt).toBeNull();
    expect(updatePayload.slaPausedMinutes).toBe(40); // 10 existing + 30 elapsed
  });

  it('folds pause on resolve directly from pending', async () => {
    const now = new Date('2026-06-11T10:05:00Z');
    vi.setSystemTime(now);
    const pausedAt = new Date('2026-06-11T10:00:00Z'); // 5 minutes ago

    dbMocks.selectResult.mockResolvedValue([{
      id: 't-1', orgId: 'o-1', partnerId: 'p-1',
      status: 'pending',
      slaPausedAt: pausedAt,
      slaPausedMinutes: 0,
      resolvedAt: null
    }]);
    dbMocks.updateReturning.mockResolvedValue([{ id: 't-1', status: 'resolved' }]);
    dbMocks.insertReturning.mockResolvedValue([{ id: 'c-1' }]);

    await changeTicketStatus('t-1', { status: 'resolved' }, { resolutionNote: 'Fixed it' }, actor);

    const updatePayload = setMock.mock.calls[0]![0];
    expect(updatePayload.slaPausedAt).toBeNull();
    expect(updatePayload.slaPausedMinutes).toBe(5); // 0 existing + 5 elapsed
  });

  it('does not touch pause fields for open -> resolved', async () => {
    const now = new Date('2026-06-11T10:00:00Z');
    vi.setSystemTime(now);

    dbMocks.selectResult.mockResolvedValue([{
      id: 't-1', orgId: 'o-1', partnerId: 'p-1',
      status: 'open',
      slaPausedAt: null,
      slaPausedMinutes: 0,
      resolvedAt: null
    }]);
    dbMocks.updateReturning.mockResolvedValue([{ id: 't-1', status: 'resolved' }]);
    dbMocks.insertReturning.mockResolvedValue([{ id: 'c-1' }]);

    await changeTicketStatus('t-1', { status: 'resolved' }, { resolutionNote: 'Done' }, actor);

    const updatePayload = setMock.mock.calls[0]![0];
    expect(updatePayload).not.toHaveProperty('slaPausedAt');
    expect(updatePayload).not.toHaveProperty('slaPausedMinutes');
  });

  it('leaving pending with slaPausedAt: null (anomalous legacy row) clears slaPausedAt and does not set slaPausedMinutes', async () => {
    const now = new Date('2026-06-11T10:00:00Z');
    vi.setSystemTime(now);

    dbMocks.selectResult.mockResolvedValue([{
      id: 't-1', orgId: 'o-1', partnerId: 'p-1',
      status: 'pending',
      slaPausedAt: null,
      slaPausedMinutes: 10,
      resolvedAt: null
    }]);
    dbMocks.updateReturning.mockResolvedValue([{ id: 't-1', status: 'open' }]);
    dbMocks.insertReturning.mockResolvedValue([{ id: 'c-1' }]);

    await changeTicketStatus('t-1', { status: 'open' }, {}, actor);

    const updatePayload = setMock.mock.calls[0]![0];
    expect(updatePayload.slaPausedAt).toBeNull();
    expect(updatePayload).not.toHaveProperty('slaPausedMinutes');
  });

  it('pending -> on_hold touches neither pause field', async () => {
    const now = new Date('2026-06-11T11:00:00Z');
    vi.setSystemTime(now);
    const pausedAt = new Date('2026-06-11T10:00:00Z'); // 60 minutes ago

    dbMocks.selectResult.mockResolvedValue([{
      id: 't-1', orgId: 'o-1', partnerId: 'p-1',
      status: 'pending',
      slaPausedAt: pausedAt,
      slaPausedMinutes: 5
    }]);
    dbMocks.updateReturning.mockResolvedValue([{ id: 't-1', status: 'on_hold' }]);
    dbMocks.insertReturning.mockResolvedValue([{ id: 'c-1' }]);

    await changeTicketStatus('t-1', { status: 'on_hold' }, {}, actor);

    const updatePayload = setMock.mock.calls[0]![0];
    expect(updatePayload).not.toHaveProperty('slaPausedAt');
    expect(updatePayload).not.toHaveProperty('slaPausedMinutes');
  });

  it('floor boundary: 90 seconds paused yields slaPausedMinutes: 1 (floor of 1.5)', async () => {
    const now = new Date('2026-06-11T10:01:30Z');
    vi.setSystemTime(now);
    const pausedAt = new Date('2026-06-11T10:00:00Z'); // 90 seconds ago

    dbMocks.selectResult.mockResolvedValue([{
      id: 't-1', orgId: 'o-1', partnerId: 'p-1',
      status: 'on_hold',
      slaPausedAt: pausedAt,
      slaPausedMinutes: 0
    }]);
    dbMocks.updateReturning.mockResolvedValue([{ id: 't-1', status: 'open' }]);
    dbMocks.insertReturning.mockResolvedValue([{ id: 'c-1' }]);

    await changeTicketStatus('t-1', { status: 'open' }, {}, actor);

    const updatePayload = setMock.mock.calls[0]![0];
    expect(updatePayload.slaPausedAt).toBeNull();
    expect(updatePayload.slaPausedMinutes).toBe(1); // floor(1.5) = 1
  });
});

// Finding #9: these mutations previously emitted only a BullMQ event and left no
// tamper-evident audit_logs row. Each must now write an audit row mirroring the
// createTicket/changeTicketStatus/updateTicketFields reference pattern.
describe('Finding #9 — audit-log coverage for mutating ticket actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    valuesMock.mockClear();
    setMock.mockClear();
  });

  it('assignTicket writes a ticket.assign audit row with previous/new assignee', async () => {
    dbMocks.selectResult
      .mockResolvedValueOnce([{ id: 't-1', orgId: 'o-1', partnerId: 'p-1', status: 'new', assignedTo: 'u-old' }]) // ticket
      .mockResolvedValueOnce([{ id: 'u-2', partnerId: 'p-1' }]);                                                   // assignee
    dbMocks.updateReturning.mockResolvedValue([{ id: 't-1', assignedTo: 'u-2', status: 'open' }]);
    dbMocks.insertReturning.mockResolvedValue([{ id: 'c-1' }]);

    await assignTicket('t-1', 'u-2', actor);

    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({
      orgId: 'o-1',
      actorId: 'u-1',
      action: 'ticket.assign',
      resourceType: 'ticket',
      resourceId: 't-1',
      details: { from: 'u-old', to: 'u-2' },
      result: 'success'
    }));
  });

  it('addTicketComment writes a ticket.comment audit row with commentId + isInternal (no body)', async () => {
    dbMocks.selectResult.mockResolvedValue([{ id: 't-1', orgId: 'o-1', partnerId: 'p-1', status: 'open', firstResponseAt: new Date() }]);
    dbMocks.insertReturning.mockResolvedValue([{ id: 'c-9', isPublic: false }]);

    await addTicketComment('t-1', { content: 'secret internal note', isPublic: false }, actor);

    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({
      orgId: 'o-1',
      actorId: 'u-1',
      action: 'ticket.comment',
      resourceType: 'ticket',
      resourceId: 't-1',
      details: { commentId: 'c-9', isInternal: true },
      result: 'success'
    }));
    // The comment body must never be dumped into the audit details.
    const auditArg = auditMock.mock.calls[0]![0];
    expect(JSON.stringify(auditArg)).not.toContain('secret internal note');
  });

  it('linkAlertToTicket writes a ticket.alert_link audit row with the alertId', async () => {
    dbMocks.selectResult
      .mockResolvedValueOnce([{ id: 't-1', orgId: 'o-1', partnerId: 'p-1', status: 'open' }])
      .mockResolvedValueOnce([{ id: 'a-1', orgId: 'o-1', title: 'CPU high' }]);
    dbMocks.insertReturning.mockResolvedValue([{ id: 'link-1' }]);

    await linkAlertToTicket('t-1', 'a-1', actor);

    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({
      orgId: 'o-1',
      actorId: 'u-1',
      action: 'ticket.alert_link',
      resourceType: 'ticket',
      resourceId: 't-1',
      details: { alertId: 'a-1' },
      result: 'success'
    }));
  });

  it('unlinkAlertFromTicket writes a ticket.alert_unlink audit row with the alertId', async () => {
    dbMocks.selectResult.mockResolvedValue([{ id: 't-1', orgId: 'o-1', partnerId: 'p-1', status: 'open' }]);
    dbMocks.insertReturning.mockResolvedValueOnce([{ id: 'link-1' }]).mockResolvedValue([{ id: 'c-1' }]);

    await unlinkAlertFromTicket('t-1', 'a-1', actor);

    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({
      orgId: 'o-1',
      actorId: 'u-1',
      action: 'ticket.alert_unlink',
      resourceType: 'ticket',
      resourceId: 't-1',
      details: { alertId: 'a-1' },
      result: 'success'
    }));
  });

  it('does NOT audit when the mutation fails (e.g. concurrent assign conflict)', async () => {
    dbMocks.selectResult
      .mockResolvedValueOnce([{ id: 't-1', orgId: 'o-1', partnerId: 'p-1', status: 'open', assignedTo: null }])
      .mockResolvedValueOnce([{ id: 'u-2', partnerId: 'p-1' }]);
    dbMocks.updateReturning.mockResolvedValue([]); // concurrent modification → throws before audit

    await assignTicket('t-1', 'u-2', actor).catch(() => {});
    expect(auditMock).not.toHaveBeenCalled();
  });
});

describe('changeTicketStatus — statusId path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    valuesMock.mockClear();
    setMock.mockClear();
  });

  it('(a) statusId with custom row mapped to pending → stamps both status:pending AND statusId; feed comment has correct values', async () => {
    const STATUS_UUID = 'aaaaaaaa-1111-4222-8333-444455556666';
    dbMocks.selectResult.mockResolvedValueOnce([{
      id: 't-1', orgId: 'o-1', partnerId: 'p-1', status: 'open', statusId: 'old-status-uuid',
      resolvedAt: null, slaPausedAt: null, slaPausedMinutes: 0
    }]);
    configMocks.getTicketStatusById.mockResolvedValueOnce({
      id: STATUS_UUID, partnerId: 'p-1', coreStatus: 'pending', name: 'Waiting on vendor',
      isActive: true, isSystem: false
    });
    dbMocks.updateReturning.mockResolvedValue([{ id: 't-1', status: 'pending', statusId: STATUS_UUID }]);
    dbMocks.insertReturning.mockResolvedValue([{ id: 'c-1' }]);

    await changeTicketStatus('t-1', { statusId: STATUS_UUID }, {}, actor);

    const updatePayload = setMock.mock.calls[0]![0];
    expect(updatePayload).toMatchObject({ status: 'pending', statusId: STATUS_UUID });

    const commentPayload = valuesMock.mock.calls[0]![0];
    expect(commentPayload).toMatchObject({
      commentType: 'status_change',
      oldValue: 'open',
      newValue: 'pending',
      content: 'Waiting on vendor'
    });
  });

  it('(b) statusId from another partner → TicketServiceError STATUS_NOT_FOUND 404', async () => {
    const STATUS_UUID = 'aaaaaaaa-1111-4222-8333-444455556666';
    dbMocks.selectResult.mockResolvedValueOnce([{
      id: 't-1', orgId: 'o-1', partnerId: 'p-1', status: 'open', statusId: null
    }]);
    configMocks.getTicketStatusById.mockResolvedValueOnce({
      id: STATUS_UUID, partnerId: 'p-OTHER', coreStatus: 'pending', name: 'Other partner status',
      isActive: true, isSystem: false
    });

    const err = await changeTicketStatus('t-1', { statusId: STATUS_UUID }, {}, actor).catch(e => e);
    expect(err).toBeInstanceOf(TicketServiceError);
    expect(err.code).toBe('STATUS_NOT_FOUND');
    expect(err.status).toBe(404);
  });

  it('(c) isActive:false row → TicketServiceError STATUS_INACTIVE 400', async () => {
    const STATUS_UUID = 'aaaaaaaa-1111-4222-8333-444455556666';
    dbMocks.selectResult.mockResolvedValueOnce([{
      id: 't-1', orgId: 'o-1', partnerId: 'p-1', status: 'open', statusId: null
    }]);
    configMocks.getTicketStatusById.mockResolvedValueOnce({
      id: STATUS_UUID, partnerId: 'p-1', coreStatus: 'pending', name: 'Deactivated',
      isActive: false, isSystem: false
    });

    const err = await changeTicketStatus('t-1', { statusId: STATUS_UUID }, {}, actor).catch(e => e);
    expect(err).toBeInstanceOf(TicketServiceError);
    expect(err.code).toBe('STATUS_INACTIVE');
    expect(err.status).toBe(400);
  });

  it('(d) legacy {status:open} path still works AND stamps statusId from getSystemStatusId', async () => {
    const SYS_STATUS_ID = 'sys-status-uuid';
    dbMocks.selectResult.mockResolvedValueOnce([{
      id: 't-1', orgId: 'o-1', partnerId: 'p-1', status: 'new', statusId: null,
      resolvedAt: null, slaPausedAt: null, slaPausedMinutes: 0
    }]);
    configMocks.getSystemStatusId.mockResolvedValueOnce(SYS_STATUS_ID);
    dbMocks.updateReturning.mockResolvedValue([{ id: 't-1', status: 'open', statusId: SYS_STATUS_ID }]);
    dbMocks.insertReturning.mockResolvedValue([{ id: 'c-1' }]);

    await changeTicketStatus('t-1', { status: 'open' }, {}, actor);

    const updatePayload = setMock.mock.calls[0]![0];
    expect(updatePayload).toMatchObject({ status: 'open', statusId: SYS_STATUS_ID });
  });

  it('(e) invalid transition via statusId (closed→pending) → 409 INVALID_TRANSITION', async () => {
    const STATUS_UUID = 'aaaaaaaa-1111-4222-8333-444455556666';
    dbMocks.selectResult.mockResolvedValueOnce([{
      id: 't-1', orgId: 'o-1', partnerId: 'p-1', status: 'closed', statusId: null
    }]);
    configMocks.getTicketStatusById.mockResolvedValueOnce({
      id: STATUS_UUID, partnerId: 'p-1', coreStatus: 'pending', name: 'Pending',
      isActive: true, isSystem: true
    });

    const err = await changeTicketStatus('t-1', { statusId: STATUS_UUID }, {}, actor).catch(e => e);
    expect(err).toBeInstanceOf(TicketServiceError);
    expect(err.code).toBe('INVALID_TRANSITION');
    expect(err.status).toBe(409);
  });

  it('(f) statusId resolving to coreStatus=resolved but no resolutionNote → 400', async () => {
    const STATUS_UUID = 'aaaaaaaa-1111-4222-8333-444455556666';
    dbMocks.selectResult.mockResolvedValueOnce([{
      id: 't-1', orgId: 'o-1', partnerId: 'p-1', status: 'open', statusId: null
    }]);
    configMocks.getTicketStatusById.mockResolvedValueOnce({
      id: STATUS_UUID, partnerId: 'p-1', coreStatus: 'resolved', name: 'Resolved',
      isActive: true, isSystem: true
    });

    const err = await changeTicketStatus('t-1', { statusId: STATUS_UUID }, {}, actor).catch(e => e);
    expect(err).toBeInstanceOf(TicketServiceError);
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/resolution note/i);
  });

  it('(g) no-op: same statusId AND same core → return ticket unchanged', async () => {
    const STATUS_UUID = 'aaaaaaaa-1111-4222-8333-444455556666';
    const ticket = { id: 't-1', orgId: 'o-1', partnerId: 'p-1', status: 'open', statusId: STATUS_UUID };
    dbMocks.selectResult.mockResolvedValueOnce([ticket]);
    configMocks.getTicketStatusById.mockResolvedValueOnce({
      id: STATUS_UUID, partnerId: 'p-1', coreStatus: 'open', name: 'Open',
      isActive: true, isSystem: true
    });

    const result = await changeTicketStatus('t-1', { statusId: STATUS_UUID }, {}, actor);
    expect(result).toBe(ticket);
    expect(setMock).not.toHaveBeenCalled();
    expect(emitMock).not.toHaveBeenCalled();
  });

  it('(h) fast path: same core status, different statusId → updates DB + feed but does NOT emit ticket.status_changed', async () => {
    const OLD_STATUS_UUID = 'old-status-uuid-1111-2222-3333-4444';
    const NEW_STATUS_UUID = 'new-status-uuid-5555-6666-7777-8888';
    dbMocks.selectResult.mockResolvedValueOnce([{
      id: 't-1', orgId: 'o-1', partnerId: 'p-1', status: 'open', statusId: OLD_STATUS_UUID,
      resolvedAt: null, slaPausedAt: null, slaPausedMinutes: 0
    }]);
    configMocks.getTicketStatusById.mockResolvedValueOnce({
      id: NEW_STATUS_UUID, partnerId: 'p-1', coreStatus: 'open', name: 'In Progress',
      isActive: true, isSystem: false
    });
    dbMocks.updateReturning.mockResolvedValue([{ id: 't-1', status: 'open', statusId: NEW_STATUS_UUID }]);
    dbMocks.insertReturning.mockResolvedValue([{ id: 'c-1' }]);

    await changeTicketStatus('t-1', { statusId: NEW_STATUS_UUID }, {}, actor);

    // DB update and feed comment must still happen
    expect(setMock).toHaveBeenCalledWith(expect.objectContaining({ statusId: NEW_STATUS_UUID }));
    expect(valuesMock).toHaveBeenCalledWith(expect.objectContaining({ commentType: 'status_change' }));

    // WHERE clause must include 3 conditions: id, status, AND statusId CAS
    expect(whereMock).toHaveBeenCalledTimes(1);
    const whereArg = whereMock.mock.calls[0]![0];
    // drizzle-orm `and(...)` with 3 args produces an object whose `.conditions` array has length 3
    expect(whereArg).toBeDefined();
    if (whereArg && 'conditions' in whereArg) {
      expect((whereArg as { conditions: unknown[] }).conditions).toHaveLength(3);
    }

    // But no status_changed event — core status is identical (both 'open')
    expect(emitMock).not.toHaveBeenCalled();
  });

  it('(i) fast path CAS: concurrent label swap → 409 CONCURRENT_MODIFICATION', async () => {
    const OLD_STATUS_UUID = 'old-status-uuid-1111-2222-3333-4444';
    const NEW_STATUS_UUID = 'new-status-uuid-5555-6666-7777-8888';
    dbMocks.selectResult.mockResolvedValueOnce([{
      id: 't-1', orgId: 'o-1', partnerId: 'p-1', status: 'open', statusId: OLD_STATUS_UUID,
      resolvedAt: null, slaPausedAt: null, slaPausedMinutes: 0
    }]);
    configMocks.getTicketStatusById.mockResolvedValueOnce({
      id: NEW_STATUS_UUID, partnerId: 'p-1', coreStatus: 'open', name: 'In Progress',
      isActive: true, isSystem: false
    });
    // Simulate concurrent update — another request already swapped the label
    dbMocks.updateReturning.mockResolvedValue([]);

    const err = await changeTicketStatus('t-1', { statusId: NEW_STATUS_UUID }, {}, actor).catch(e => e);
    expect(err).toBeInstanceOf(TicketServiceError);
    expect(err.status).toBe(409);
    expect(err.code).toBe('CONCURRENT_MODIFICATION');
    expect(err.message).toMatch(/concurrently/i);
    // No comment insert, no event
    expect(valuesMock).not.toHaveBeenCalled();
    expect(emitMock).not.toHaveBeenCalled();
  });

  it('both status + statusId → 400 INVALID_INPUT', async () => {
    dbMocks.selectResult.mockResolvedValueOnce([{
      id: 't-1', orgId: 'o-1', partnerId: 'p-1', status: 'open', statusId: null
    }]);

    const err = await changeTicketStatus('t-1', { status: 'pending', statusId: 'some-uuid' }, {}, actor).catch(e => e);
    expect(err).toBeInstanceOf(TicketServiceError);
    expect(err.code).toBe('INVALID_INPUT');
    expect(err.status).toBe(400);
  });

  it('neither status nor statusId → 400 INVALID_INPUT', async () => {
    dbMocks.selectResult.mockResolvedValueOnce([{
      id: 't-1', orgId: 'o-1', partnerId: 'p-1', status: 'open', statusId: null
    }]);

    const err = await changeTicketStatus('t-1', {}, {}, actor).catch(e => e);
    expect(err).toBeInstanceOf(TicketServiceError);
    expect(err.code).toBe('INVALID_INPUT');
    expect(err.status).toBe(400);
  });
});

// Base comment and ticket fixture shared by comment-mutation tests.
const BASE_COMMENT = {
  id: 'c1', ticketId: 't1', userId: 'tech-1', portalUserId: null,
  commentType: 'comment', content: 'old', deletedAt: null,
  isPublic: true, authorType: 'staff', createdAt: new Date('2026-01-01T10:00:00Z'),
  editedAt: null, authorName: 'Tech'
};
const BASE_TICKET = { id: 't1', orgId: 'o1', partnerId: 'p1', status: 'open' };

describe('SYSTEM_COMMENT_TYPES', () => {
  it('contains the four expected type strings', () => {
    expect(SYSTEM_COMMENT_TYPES).toContain('status_change');
    expect(SYSTEM_COMMENT_TYPES).toContain('assignment');
    expect(SYSTEM_COMMENT_TYPES).toContain('time_entry');
    expect(SYSTEM_COMMENT_TYPES).toContain('system');
    expect(SYSTEM_COMMENT_TYPES.size).toBe(4);
  });
});

describe('editTicketComment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    valuesMock.mockClear();
    setMock.mockClear();
  });

  it('lets the author edit their own comment and stamps editedAt + audit with previousContent', async () => {
    const updatedRow = { ...BASE_COMMENT, content: 'new', editedAt: new Date() };
    dbMocks.selectResult
      .mockResolvedValueOnce([BASE_COMMENT])  // loadCommentWithTicket: comment lookup
      .mockResolvedValueOnce([BASE_TICKET]);  // loadCommentWithTicket: getTicketOrThrow
    dbMocks.updateReturning.mockResolvedValue([updatedRow]);

    const result = await editTicketComment('c1', { content: 'new' }, { userId: 'tech-1', name: 'Tech' }, { canManageAny: false });

    expect(result.content).toBe('new');
    expect(result.editedAt).toBeInstanceOf(Date);

    const updatePayload = setMock.mock.calls[0]![0];
    expect(updatePayload.content).toBe('new');
    expect(updatePayload.editedAt).toBeInstanceOf(Date);

    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: 'ticket.comment.edit',
      details: expect.objectContaining({ commentId: 'c1', previousContent: 'old' }),
      result: 'success'
    }));

    // Fix 1: edit must NOT emit a ticket event — doing so re-triggers "new reply"
    // emails to the portal requester. Regression guard: if emitMock is called here
    // the spurious customer notification bug has returned.
    expect(emitMock).not.toHaveBeenCalled();
  });

  it('rejects a non-author without canManageAny (403)', async () => {
    dbMocks.selectResult
      .mockResolvedValueOnce([BASE_COMMENT])
      .mockResolvedValueOnce([BASE_TICKET]);

    const err = await editTicketComment('c1', { content: 'x' }, { userId: 'other-tech' }, { canManageAny: false }).catch(e => e);
    expect(err).toBeInstanceOf(TicketServiceError);
    expect(err.status).toBe(403);
  });

  it('allows a non-author WITH canManageAny', async () => {
    const updatedRow = { ...BASE_COMMENT, content: 'x', editedAt: new Date() };
    dbMocks.selectResult
      .mockResolvedValueOnce([BASE_COMMENT])
      .mockResolvedValueOnce([BASE_TICKET]);
    dbMocks.updateReturning.mockResolvedValue([updatedRow]);

    const result = await editTicketComment('c1', { content: 'x' }, { userId: 'admin' }, { canManageAny: true });
    expect(result.content).toBe('x');
  });

  it('throws 404 when expectedTicketId is provided but does not match the comment ticketId', async () => {
    // Comment belongs to ticket 't1'; caller supplies a different URL ticket id.
    dbMocks.selectResult
      .mockResolvedValueOnce([BASE_COMMENT])  // loadCommentWithTicket: comment lookup (ticketId='t1')
      .mockResolvedValueOnce([BASE_TICKET]);  // loadCommentWithTicket: getTicketOrThrow

    const err = await editTicketComment('c1', { content: 'x' }, { userId: 'tech-1' }, { canManageAny: true, expectedTicketId: 'other-ticket-id' }).catch(e => e);
    expect(err).toBeInstanceOf(TicketServiceError);
    expect(err.status).toBe(404);
    // Must not reveal the comment exists or write any audit/event
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('passes through when expectedTicketId is omitted (backward-compat)', async () => {
    const updatedRow = { ...BASE_COMMENT, content: 'compat', editedAt: new Date() };
    dbMocks.selectResult
      .mockResolvedValueOnce([BASE_COMMENT])
      .mockResolvedValueOnce([BASE_TICKET]);
    dbMocks.updateReturning.mockResolvedValue([updatedRow]);

    // No expectedTicketId in opts — must still succeed
    const result = await editTicketComment('c1', { content: 'compat' }, { userId: 'tech-1' }, { canManageAny: false });
    expect(result.content).toBe('compat');
  });

  it('rejects editing a system-type comment (400)', async () => {
    const sysComment = { ...BASE_COMMENT, id: 'c-sys', commentType: 'system' };
    dbMocks.selectResult
      .mockResolvedValueOnce([sysComment])
      .mockResolvedValueOnce([BASE_TICKET]);

    const err = await editTicketComment('c-sys', { content: 'x' }, { userId: 'tech-1' }, { canManageAny: true }).catch(e => e);
    expect(err).toBeInstanceOf(TicketServiceError);
    expect(err.status).toBe(400);
  });

  it('rejects editing an already-deleted comment (409)', async () => {
    const deletedComment = { ...BASE_COMMENT, id: 'c-del', deletedAt: new Date() };
    dbMocks.selectResult
      .mockResolvedValueOnce([deletedComment])
      .mockResolvedValueOnce([BASE_TICKET]);

    const err = await editTicketComment('c-del', { content: 'x' }, { userId: 'tech-1' }, { canManageAny: true }).catch(e => e);
    expect(err).toBeInstanceOf(TicketServiceError);
    expect(err.status).toBe(409);
  });

  it('throws 404 when the comment does not exist', async () => {
    dbMocks.selectResult.mockResolvedValueOnce([]); // no comment found

    const err = await editTicketComment('missing', { content: 'x' }, { userId: 'tech-1' }, { canManageAny: true }).catch(e => e);
    expect(err).toBeInstanceOf(TicketServiceError);
    expect(err.status).toBe(404);
  });

  it('rejects all SYSTEM_COMMENT_TYPES (status_change, assignment, time_entry)', async () => {
    for (const type of ['status_change', 'assignment', 'time_entry']) {
      vi.clearAllMocks();
      const typedComment = { ...BASE_COMMENT, commentType: type };
      dbMocks.selectResult
        .mockResolvedValueOnce([typedComment])
        .mockResolvedValueOnce([BASE_TICKET]);

      const err = await editTicketComment('c1', { content: 'x' }, { userId: 'tech-1' }, { canManageAny: true }).catch(e => e);
      expect(err.status).toBe(400);
    }
  });
});

describe('deleteTicketComment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    valuesMock.mockClear();
    setMock.mockClear();
  });

  it('soft-deletes (sets deletedAt) and audits with previousContent', async () => {
    dbMocks.selectResult
      .mockResolvedValueOnce([BASE_COMMENT])
      .mockResolvedValueOnce([BASE_TICKET]);
    // delete path: update returns the soft-deleted row (required by TOCTOU guard)
    dbMocks.updateReturning.mockResolvedValue([{ id: 'c1' }]);

    const res = await deleteTicketComment('c1', { userId: 'tech-1' }, { canManageAny: false });

    expect(res.id).toBe('c1');

    const updatePayload = setMock.mock.calls[0]![0];
    expect(updatePayload.deletedAt).toBeInstanceOf(Date);
    expect(updatePayload).not.toHaveProperty('content'); // only deletedAt stamped

    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: 'ticket.comment.delete',
      details: expect.objectContaining({ commentId: 'c1', previousContent: 'old' }),
      result: 'success'
    }));

    // Fix 1: delete must NOT emit a ticket event — doing so sends a ghost "new
    // reply" email to the portal requester. Regression guard: if emitMock is called
    // here the spurious customer notification bug has returned.
    expect(emitMock).not.toHaveBeenCalled();
  });

  it('rejects a non-author without canManageAny (403)', async () => {
    dbMocks.selectResult
      .mockResolvedValueOnce([BASE_COMMENT])
      .mockResolvedValueOnce([BASE_TICKET]);

    const err = await deleteTicketComment('c1', { userId: 'other' }, { canManageAny: false }).catch(e => e);
    expect(err).toBeInstanceOf(TicketServiceError);
    expect(err.status).toBe(403);
  });

  it('allows a non-author WITH canManageAny', async () => {
    dbMocks.selectResult
      .mockResolvedValueOnce([BASE_COMMENT])
      .mockResolvedValueOnce([BASE_TICKET]);
    dbMocks.updateReturning.mockResolvedValue([{ id: 'c1' }]);

    const res = await deleteTicketComment('c1', { userId: 'admin' }, { canManageAny: true });
    expect(res.id).toBe('c1');
  });

  it('throws 404 when expectedTicketId is provided but does not match the comment ticketId', async () => {
    // Comment belongs to ticket 't1'; caller supplies a different URL ticket id.
    dbMocks.selectResult
      .mockResolvedValueOnce([BASE_COMMENT])  // loadCommentWithTicket: comment lookup (ticketId='t1')
      .mockResolvedValueOnce([BASE_TICKET]);  // loadCommentWithTicket: getTicketOrThrow

    const err = await deleteTicketComment('c1', { userId: 'tech-1' }, { canManageAny: true, expectedTicketId: 'other-ticket-id' }).catch(e => e);
    expect(err).toBeInstanceOf(TicketServiceError);
    expect(err.status).toBe(404);
    // Must not reveal the comment exists or write any audit/event
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('passes through when expectedTicketId is omitted (backward-compat)', async () => {
    dbMocks.selectResult
      .mockResolvedValueOnce([BASE_COMMENT])
      .mockResolvedValueOnce([BASE_TICKET]);
    dbMocks.updateReturning.mockResolvedValue([{ id: 'c1' }]);

    // No expectedTicketId in opts — must still succeed
    const res = await deleteTicketComment('c1', { userId: 'tech-1' }, { canManageAny: false });
    expect(res.id).toBe('c1');
  });

  it('rejects deleting a system-type comment (400)', async () => {
    const sysComment = { ...BASE_COMMENT, commentType: 'status_change' };
    dbMocks.selectResult
      .mockResolvedValueOnce([sysComment])
      .mockResolvedValueOnce([BASE_TICKET]);

    const err = await deleteTicketComment('c1', { userId: 'tech-1' }, { canManageAny: true }).catch(e => e);
    expect(err.status).toBe(400);
  });

  it('rejects deleting an already-deleted comment (409)', async () => {
    const deletedComment = { ...BASE_COMMENT, deletedAt: new Date() };
    dbMocks.selectResult
      .mockResolvedValueOnce([deletedComment])
      .mockResolvedValueOnce([BASE_TICKET]);

    const err = await deleteTicketComment('c1', { userId: 'tech-1' }, { canManageAny: true }).catch(e => e);
    expect(err.status).toBe(409);
  });

  it('throws 409 when the soft-delete update races and returns zero rows (TOCTOU)', async () => {
    dbMocks.selectResult
      .mockResolvedValueOnce([BASE_COMMENT])
      .mockResolvedValueOnce([BASE_TICKET]);
    // Simulate concurrent soft-delete: the UPDATE matched nothing.
    dbMocks.updateReturning.mockResolvedValue([]);

    const err = await deleteTicketComment('c1', { userId: 'tech-1' }, { canManageAny: false }).catch(e => e);
    expect(err).toBeInstanceOf(TicketServiceError);
    expect(err.status).toBe(409);
    // Audit and event must NOT have fired.
    expect(auditMock).not.toHaveBeenCalled();
    expect(emitMock).not.toHaveBeenCalled();
  });
});

describe('softDeleteTicket', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    valuesMock.mockClear();
    setMock.mockClear();
  });

  it('stamps deletedAt/deletedBy, audits ticket.delete, and emits NO event', async () => {
    dbMocks.selectResult.mockResolvedValueOnce([{ ...BASE_TICKET, ticketNumber: 'ABC123', subject: 'Spam', deletedAt: null }]);
    dbMocks.updateReturning.mockResolvedValue([{ id: 't1' }]); // CAS returns the row

    const res = await softDeleteTicket('t1', actor);
    expect(res).toEqual({ id: 't1' });

    const updatePayload = setMock.mock.calls[0]![0];
    expect(updatePayload.deletedAt).toBeInstanceOf(Date);
    expect(updatePayload.deletedBy).toBe('u-1');

    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: 'ticket.delete',
      resourceType: 'ticket',
      resourceId: 't1',
      details: expect.objectContaining({ ticketNumber: 'ABC123', subject: 'Spam' }),
      result: 'success'
    }));
    // Deleting must not emit a lifecycle event (would notify the portal requester).
    expect(emitMock).not.toHaveBeenCalled();
  });

  it('rejects an already-deleted ticket (409) without updating or auditing', async () => {
    dbMocks.selectResult.mockResolvedValueOnce([{ ...BASE_TICKET, deletedAt: new Date() }]);

    const err = await softDeleteTicket('t1', actor).catch(e => e);
    expect(err).toBeInstanceOf(TicketServiceError);
    expect(err.status).toBe(409);
    expect(setMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('throws 409 when the CAS update loses a race (no row returned)', async () => {
    dbMocks.selectResult.mockResolvedValueOnce([{ ...BASE_TICKET, deletedAt: null }]);
    dbMocks.updateReturning.mockResolvedValue([]); // concurrent delete won

    const err = await softDeleteTicket('t1', actor).catch(e => e);
    expect(err).toBeInstanceOf(TicketServiceError);
    expect(err.status).toBe(409);
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('throws 404 when the ticket does not exist', async () => {
    dbMocks.selectResult.mockResolvedValueOnce([]);
    const err = await softDeleteTicket('nope', actor).catch(e => e);
    expect(err).toBeInstanceOf(TicketServiceError);
    expect(err.status).toBe(404);
  });
});

describe('restoreTicket', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    valuesMock.mockClear();
    setMock.mockClear();
  });

  it('clears deletedAt/deletedBy and audits ticket.restore', async () => {
    dbMocks.selectResult.mockResolvedValueOnce([{ ...BASE_TICKET, ticketNumber: 'ABC123', subject: 'Spam', deletedAt: new Date() }]);
    dbMocks.updateReturning.mockResolvedValue([{ id: 't1', deletedAt: null }]);

    const res = await restoreTicket('t1', actor);
    expect(res).toMatchObject({ id: 't1', deletedAt: null });

    const updatePayload = setMock.mock.calls[0]![0];
    expect(updatePayload.deletedAt).toBeNull();
    expect(updatePayload.deletedBy).toBeNull();

    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: 'ticket.restore',
      resourceId: 't1',
      result: 'success'
    }));
  });

  it('rejects restoring a ticket that is not deleted (409)', async () => {
    dbMocks.selectResult.mockResolvedValueOnce([{ ...BASE_TICKET, deletedAt: null }]);

    const err = await restoreTicket('t1', actor).catch(e => e);
    expect(err).toBeInstanceOf(TicketServiceError);
    expect(err.status).toBe(409);
    expect(setMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });
});

describe('portalCommentMutable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    valuesMock.mockClear();
    setMock.mockClear();
  });

  it('returns ok:true when portal author has no later non-portal comments', async () => {
    const portalComment = {
      ...BASE_COMMENT,
      userId: null,
      portalUserId: 'pu-42',
      authorType: 'portal',
      createdAt: new Date('2026-01-01T10:00:00Z')
    };
    dbMocks.selectResult
      .mockResolvedValueOnce([portalComment])  // comment lookup
      .mockResolvedValueOnce([]);              // later comments: none

    const result = await portalCommentMutable('c1', 'pu-42');
    expect(result).toEqual({ ok: true });
  });

  it('returns not_found when comment does not exist', async () => {
    dbMocks.selectResult.mockResolvedValueOnce([]);

    const result = await portalCommentMutable('missing', 'pu-42');
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('returns not_found when comment is soft-deleted', async () => {
    const deletedComment = {
      ...BASE_COMMENT,
      userId: null,
      portalUserId: 'pu-42',
      authorType: 'portal',
      deletedAt: new Date()
    };
    dbMocks.selectResult.mockResolvedValueOnce([deletedComment]);

    const result = await portalCommentMutable('c1', 'pu-42');
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('returns not_author when portalUserId does not match', async () => {
    const portalComment = {
      ...BASE_COMMENT,
      userId: null,
      portalUserId: 'pu-99',
      authorType: 'portal',
      deletedAt: null
    };
    dbMocks.selectResult.mockResolvedValueOnce([portalComment]);

    const result = await portalCommentMutable('c1', 'pu-42');
    expect(result).toEqual({ ok: false, reason: 'not_author' });
  });

  it('returns staff_replied when a later comment exists with authorType !== portal', async () => {
    const portalComment = {
      ...BASE_COMMENT,
      userId: null,
      portalUserId: 'pu-42',
      authorType: 'portal',
      deletedAt: null,
      createdAt: new Date('2026-01-01T10:00:00Z')
    };
    const laterStaffComment = { authorType: 'staff' };
    dbMocks.selectResult
      .mockResolvedValueOnce([portalComment])        // comment lookup
      .mockResolvedValueOnce([laterStaffComment]);   // later rows with authorType

    const result = await portalCommentMutable('c1', 'pu-42');
    expect(result).toEqual({ ok: false, reason: 'staff_replied' });
  });

  it('returns ok:true when later comments are all portal type', async () => {
    const portalComment = {
      ...BASE_COMMENT,
      userId: null,
      portalUserId: 'pu-42',
      authorType: 'portal',
      deletedAt: null,
      createdAt: new Date('2026-01-01T10:00:00Z')
    };
    const laterPortalComment = { authorType: 'portal' };
    dbMocks.selectResult
      .mockResolvedValueOnce([portalComment])
      .mockResolvedValueOnce([laterPortalComment]);

    const result = await portalCommentMutable('c1', 'pu-42');
    expect(result).toEqual({ ok: true });
  });
});

describe('moveTicketOrg', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    valuesMock.mockClear();
    setMock.mockClear();
    whereMock.mockClear();
    dbMocks.txExecuteMock.mockClear();
    dbMocks.txUpdateReturning.mockClear();
  });

  it('moves ticket to a same-partner org, detaches device, re-stamps child org_id on 3 tables', async () => {
    // Ticket { id:'t1', orgId:'oA', partnerId:'p1', deviceId:'d1' }
    // Target org { id:'oB', partnerId:'p1', name:'Beta Corp' }
    dbMocks.selectResult
      .mockResolvedValueOnce([{ id: 't1', orgId: 'oA', partnerId: 'p1', deviceId: 'd1' }]) // getTicketOrThrow
      .mockResolvedValueOnce([                                                               // org lookup (IN clause)
        { id: 'oA', partnerId: 'p1', name: 'Alpha Corp' },
        { id: 'oB', partnerId: 'p1', name: 'Beta Corp' }
      ]);
    // txUpdateReturning returns the updated ticket row from the tx.update() call
    dbMocks.txUpdateReturning.mockResolvedValue([{ id: 't1', orgId: 'oB', deviceId: null }]);
    dbMocks.txExecuteMock.mockResolvedValue(undefined); // 3 child-table raw UPDATEs
    dbMocks.insertReturning.mockResolvedValue([{ id: 'c-sys' }]); // tx.insert ticketComments

    const result = await moveTicketOrg('t1', 'oB', { userId: 'admin' });

    expect(result.orgId).toBe('oB');
    expect(result.deviceId).toBeNull();

    // The tx.update call should have set orgId + deviceId:null
    expect(setMock).toHaveBeenCalledWith(expect.objectContaining({ orgId: 'oB', deviceId: null }));

    // 3 raw SQL executes for the child tables (time_entries, ticket_parts, ticket_alert_links)
    expect(dbMocks.txExecuteMock).toHaveBeenCalledTimes(3);

    // System feed comment inserted with "Moved to <org name>"
    expect(valuesMock).toHaveBeenCalledWith(expect.objectContaining({
      ticketId: 't1',
      commentType: 'system',
      content: 'Moved to Beta Corp'
    }));

    // ticket.updated event emitted
    expect(emitMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'ticket.updated',
      ticketId: 't1',
      orgId: 'oB',
      payload: { changed: ['orgId'] }
    }));

    // Dual-org audit: source + target
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({
      orgId: 'oA',
      action: 'ticket.move_org.source',
      resourceId: 't1'
    }));
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({
      orgId: 'oB',
      action: 'ticket.move_org.target',
      resourceId: 't1'
    }));
  });

  it('rejects a cross-partner target (400)', async () => {
    // Ticket in org oA (partner p1), target org oX (partner p2)
    dbMocks.selectResult
      .mockResolvedValueOnce([{ id: 't1', orgId: 'oA', partnerId: 'p1', deviceId: null }]) // ticket
      .mockResolvedValueOnce([
        { id: 'oA', partnerId: 'p1', name: 'Alpha Corp' },
        { id: 'oX', partnerId: 'p2', name: 'Cross Corp' }  // different partner!
      ]);

    const err = await moveTicketOrg('t1', 'oX', { userId: 'admin' }).catch(e => e);
    expect(err).toBeInstanceOf(TicketServiceError);
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/same partner/i);
    // No transaction started
    expect(setMock).not.toHaveBeenCalled();
    expect(emitMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('no-ops when target equals the current org', async () => {
    const ticket = { id: 't1', orgId: 'oA', partnerId: 'p1', deviceId: null };
    dbMocks.selectResult.mockResolvedValueOnce([ticket]); // getTicketOrThrow

    const result = await moveTicketOrg('t1', 'oA', { userId: 'admin' });
    // Returns the existing ticket unchanged
    expect(result).toBe(ticket);
    // No org lookup, no transaction, no event, no audit
    expect(dbMocks.selectResult).toHaveBeenCalledTimes(1);
    expect(setMock).not.toHaveBeenCalled();
    expect(emitMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('rejects when target org is not found (404)', async () => {
    // Org lookup returns only the source org — target is missing
    dbMocks.selectResult
      .mockResolvedValueOnce([{ id: 't1', orgId: 'oA', partnerId: 'p1', deviceId: null }])
      .mockResolvedValueOnce([{ id: 'oA', partnerId: 'p1', name: 'Alpha Corp' }]); // no oB row

    const err = await moveTicketOrg('t1', 'oB', { userId: 'admin' }).catch(e => e);
    expect(err).toBeInstanceOf(TicketServiceError);
    expect(err.status).toBe(404);
    expect(err.message).toMatch(/target organization not found/i);
    expect(setMock).not.toHaveBeenCalled();
  });
});
