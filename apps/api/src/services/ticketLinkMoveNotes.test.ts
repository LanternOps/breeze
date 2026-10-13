import { describe, it, expect, vi, beforeEach } from 'vitest';

const { insertMock, selectRows, emitMock, captureMock, afterCommitMock } = vi.hoisted(() => ({
  insertMock: vi.fn(),
  selectRows: { current: [] as Array<Record<string, unknown>> },
  emitMock: vi.fn(),
  captureMock: vi.fn(),
  afterCommitMock: vi.fn(),
}));

vi.mock('../db', () => ({
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  runAfterDbContextCommit: afterCommitMock,
  db: {
    select: () => ({ from: () => ({ where: async () => selectRows.current }) }),
    insert: () => ({ values: insertMock }),
  },
}));
vi.mock('./ticketEvents', () => ({ emitTicketEvent: emitMock }));
vi.mock('./sentry', () => ({ captureException: captureMock }));

import {
  noteTicketLinksRemovedByOrgMove,
  plannedLinkRemovalNotes,
  removedTicketLinksFromRows,
  scheduleTicketLinkRemovalNotes,
} from './ticketLinkMoveNotes';

const link = (sourceMoved: boolean, targetMoved: boolean) => ({
  orgId: 'o', sourceTicketId: 's', targetTicketId: 't', linkType: 'caused_by' as const, sourceMoved, targetMoved,
});

beforeEach(() => {
  vi.clearAllMocks();
  selectRows.current = [
    { id: 's', orgId: 'o', partnerId: 'p', internalNumber: 'T-1', ticketNumber: 'x', deletedAt: null },
    { id: 't', orgId: 'o', partnerId: 'p', internalNumber: null, ticketNumber: 'LEG-2', deletedAt: null },
  ];
  insertMock.mockResolvedValue(undefined);
});

describe('plannedLinkRemovalNotes', () => {
  it('notes only the survivor when one leg moved, both legs when both moved', () => {
    expect(plannedLinkRemovalNotes([link(true, false)]).map((n) => [n.ticketId, n.direction])).toEqual([['t', 'incoming']]);
    expect(plannedLinkRemovalNotes([link(false, true)]).map((n) => [n.ticketId, n.direction])).toEqual([['s', 'outgoing']]);
    expect(plannedLinkRemovalNotes([link(true, true)]).map((n) => n.ticketId)).toEqual(['s', 't']);
  });
});

describe('removedTicketLinksFromRows', () => {
  it('maps RETURNING rows and treats anything but true as not moved', () => {
    expect(removedTicketLinksFromRows([{ org_id: 'o', source_ticket_id: 's', target_ticket_id: 't', link_type: 'related', source_moved: true, target_moved: null }]))
      .toEqual([{ orgId: 'o', sourceTicketId: 's', targetTicketId: 't', linkType: 'related', sourceMoved: true, targetMoved: false }]);
    expect(removedTicketLinksFromRows(undefined)).toEqual([]);
  });
});

describe('noteTicketLinksRemovedByOrgMove', () => {
  it('writes an internal system note naming the other ticket with the inverse label', async () => {
    await noteTicketLinksRemovedByOrgMove([link(true, false)]);
    expect(insertMock).toHaveBeenCalledTimes(1);
    expect(insertMock.mock.calls[0]![0]).toMatchObject({
      ticketId: 't', commentType: 'system', isPublic: false, oldValue: 's',
      content: 'Removed link "causes T-1" because of an organization move',
    });
    expect(emitMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'ticket.link_removed', ticketId: 't', payload: { linkType: 'caused_by', otherTicketId: 's', reason: 'org_move' },
    }));
  });

  it('never throws: a failed note is reported and the next one is still written', async () => {
    insertMock.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(undefined);
    await expect(noteTicketLinksRemovedByOrgMove([link(true, true)])).resolves.toBeUndefined();
    expect(insertMock).toHaveBeenCalledTimes(2);
    expect(captureMock).toHaveBeenCalledTimes(1);
  });

  it('skips a soft-deleted survivor', async () => {
    selectRows.current[1]!.deletedAt = new Date();
    await noteTicketLinksRemovedByOrgMove([link(true, false)]);
    expect(insertMock).not.toHaveBeenCalled();
  });
});

describe('scheduleTicketLinkRemovalNotes', () => {
  it('defers to after the outermost commit, and does nothing for no links', () => {
    scheduleTicketLinkRemovalNotes([]);
    expect(afterCommitMock).not.toHaveBeenCalled();
    scheduleTicketLinkRemovalNotes([link(true, false)]);
    expect(afterCommitMock).toHaveBeenCalledWith('ticketLinks.orgMoveNotes', expect.any(Function));
  });
});
