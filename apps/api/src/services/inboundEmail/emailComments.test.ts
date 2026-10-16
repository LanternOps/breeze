import { beforeEach, describe, expect, it, vi } from 'vitest';

const { insertReturningMock, selectLimitMock, emitMock, outboxMock } = vi.hoisted(() => ({
  insertReturningMock: vi.fn(),
  selectLimitMock: vi.fn(),
  emitMock: vi.fn(),
  outboxMock: vi.fn(),
}));

vi.mock('../../db', () => ({
  db: {
    insert: vi.fn(() => ({ values: vi.fn(() => ({ returning: insertReturningMock })) })),
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: selectLimitMock })) })) })),
  },
}));
vi.mock('../ticketEvents', () => ({ emitTicketEvent: emitMock }));
vi.mock('../ticketService', () => ({ writeTicketCommentedOutbox: outboxMock }));

import { db } from '../../db';
import { insertEmailAuthoredComment } from './emailComments';

const TICKET_ID = '00000000-0000-4000-8000-000000000001';
const ORG_ID = '00000000-0000-4000-8000-000000000002';

describe('insertEmailAuthoredComment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    insertReturningMock.mockResolvedValue([
      { id: 'comment-1', originPrincipalKind: 'user', originPrincipalId: null },
    ]);
    selectLimitMock.mockResolvedValue([{ orgId: ORG_ID }]);
  });

  // #8326: a customer's emailed reply reaches webhooks and automations through
  // the same ticket.commented outbox row as every other comment writer.
  it('writes the ticket.commented outbox row with the ticket org and the stored origin', async () => {
    await insertEmailAuthoredComment({
      ticketId: TICKET_ID,
      orgId: '', // the inbound pipeline's wart: the outbox must not use it
      senderPortalUserId: null,
      authorName: 'Jane Known',
      content: 'It is back.',
    });

    expect(outboxMock).toHaveBeenCalledTimes(1);
    expect(outboxMock).toHaveBeenCalledWith({
      orgId: ORG_ID,
      ticketId: TICKET_ID,
      commentId: 'comment-1',
      isPublic: true,
      originPrincipalKind: 'user',
      originPrincipalId: null,
    });
    // The notify-worker event is unchanged: still flagged inbound, so the
    // requester never gets their own email echoed back.
    expect(emitMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'ticket.commented',
      payload: { commentId: 'comment-1', isPublic: true, inbound: true },
    }));
  });

  it('writes neither the event nor the outbox row for the new-ticket attachments carrier', async () => {
    await insertEmailAuthoredComment({
      ticketId: TICKET_ID,
      orgId: ORG_ID,
      authorName: 'Jane Known',
      content: 'Attachments from the original email.',
      emitEvent: false,
    });

    expect(emitMock).not.toHaveBeenCalled();
    expect(outboxMock).not.toHaveBeenCalled();
    expect(db.select).not.toHaveBeenCalled();
  });

  it('fails, so the caller transaction rolls back, when the ticket is not visible', async () => {
    selectLimitMock.mockResolvedValueOnce([]);
    await expect(insertEmailAuthoredComment({
      ticketId: TICKET_ID,
      orgId: '',
      authorName: 'Jane Known',
      content: 'It is back.',
    })).rejects.toThrow(/resolve the ticket/);
    expect(outboxMock).not.toHaveBeenCalled();
  });
});
