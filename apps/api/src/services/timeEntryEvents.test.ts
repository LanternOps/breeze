import { describe, it, expect, vi, beforeEach } from 'vitest';

const { addMock, captureExceptionMock } = vi.hoisted(() => ({
  addMock: vi.fn(),
  captureExceptionMock: vi.fn()
}));

vi.mock('bullmq', () => ({
  Queue: class {
    add = addMock;
  }
}));
vi.mock('./redis', () => ({ getBullMQConnection: vi.fn(() => ({})) }));
vi.mock('./sentry', () => ({ captureException: captureExceptionMock }));

import { emitTimeEntryEvent } from './timeEntryEvents';

describe('emitTimeEntryEvent', () => {
  beforeEach(() => {
    addMock.mockClear();
    captureExceptionMock.mockClear();
  });

  it('enqueues the event with its type as the job name', async () => {
    await emitTimeEntryEvent({
      type: 'time_entry.created',
      timeEntryId: 'te-1',
      partnerId: 'p-1',
      ticketId: 't-1',
      actorUserId: 'u-1',
      payload: { userId: 'u-1', durationMinutes: 30, isBillable: true }
    });
    expect(addMock).toHaveBeenCalledWith(
      'time_entry.created',
      expect.objectContaining({ timeEntryId: 'te-1', partnerId: 'p-1' }),
      expect.objectContaining({ attempts: 3 })
    );
  });

  it('never throws to the caller when the queue is down', async () => {
    addMock.mockRejectedValueOnce(new Error('redis down'));
    await expect(emitTimeEntryEvent({
      type: 'time_entry.approved',
      timeEntryId: 'te-2',
      partnerId: 'p-1',
      ticketId: null,
      actorUserId: 'u-9',
      payload: { ids: ['te-2'], approvedBy: 'u-9' }
    })).resolves.toBeUndefined();
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
  });
});
