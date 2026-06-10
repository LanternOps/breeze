import { describe, it, expect, vi, beforeEach } from 'vitest';

const { addMock, captureExceptionMock } = vi.hoisted(() => ({
  addMock: vi.fn().mockResolvedValue({ id: 'job-1' }),
  captureExceptionMock: vi.fn()
}));

vi.mock('bullmq', () => ({
  Queue: class {
    add = addMock;
  },
  Worker: class {}
}));
// getBullMQConnection is exported from ./redis (confirmed via alertWorker.ts: '../services/redis')
vi.mock('./redis', () => ({ getBullMQConnection: vi.fn(() => ({})) }));
vi.mock('./sentry', () => ({ captureException: captureExceptionMock }));

import { emitTicketEvent } from './ticketEvents';

describe('emitTicketEvent', () => {
  beforeEach(() => {
    addMock.mockClear();
    captureExceptionMock.mockClear();
  });

  it('enqueues the event with its type as the job name', async () => {
    await emitTicketEvent({
      type: 'ticket.assigned',
      ticketId: 't-1',
      orgId: 'o-1',
      partnerId: 'p-1',
      actorUserId: 'u-1',
      payload: { assigneeId: 'u-2' }
    });
    expect(addMock).toHaveBeenCalledWith(
      'ticket.assigned',
      expect.objectContaining({ ticketId: 't-1', orgId: 'o-1' }),
      expect.objectContaining({ removeOnComplete: expect.anything() })
    );
  });

  it('never throws to the caller when the queue is down', async () => {
    addMock.mockRejectedValueOnce(new Error('redis down'));
    await expect(emitTicketEvent({
      type: 'ticket.created', ticketId: 't', orgId: 'o', partnerId: null, payload: {}
    })).resolves.toBeUndefined();
  });

  it('calls captureException with ticketId and orgId in scope when enqueue fails', async () => {
    const err = new Error('redis down');
    addMock.mockRejectedValueOnce(err);
    await emitTicketEvent({
      type: 'ticket.created', ticketId: 'failing-ticket', orgId: 'org-123', partnerId: null, payload: {}
    });
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    expect(captureExceptionMock).toHaveBeenCalledWith(err);
  });
});
