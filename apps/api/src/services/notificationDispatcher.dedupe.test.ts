import { beforeEach, describe, expect, it, vi } from 'vitest';

const queueAddMock = vi.hoisted(() => vi.fn());

// `dispatchAlertNotifications` reaches the queue through getNotificationQueue(),
// which constructs a real bullmq Queue against a real Redis connection. Mock the
// constructor so the assertion is about the job OPTIONS we pass, not about Redis.
vi.mock('bullmq', () => ({
  // Must be constructible — getNotificationQueue() calls `new Queue(...)`.
  Queue: class {
    add = queueAddMock;
    getDelayed = async () => [];
  },
  Worker: class {},
  Job: class {}
}));

vi.mock('../services/redis', () => ({
  getBullMQConnection: vi.fn(() => ({})),
  isRedisAvailable: vi.fn(() => true)
}));

const subscribeMock = vi.hoisted(() => vi.fn());
vi.mock('./eventBus', () => ({ getEventBus: () => ({ subscribe: subscribeMock }) }));

import { dispatchAlertNotifications, subscribeToAlertEvents } from './notificationDispatcher';

describe('alert.triggered redelivery cannot double-notify', () => {
  beforeEach(() => {
    queueAddMock.mockReset();
    queueAddMock.mockResolvedValue({ id: 'job-1' });
  });

  it('enqueues process-alert under a stable job id derived from the alert and event', async () => {
    await dispatchAlertNotifications('alert-1', 'event-1');
    await dispatchAlertNotifications('alert-1', 'event-1');

    const jobIds = queueAddMock.mock.calls.map(([, , opts]) => opts?.jobId);
    // Identical ids are the whole point: BullMQ rejects the second add, so the
    // duplicate never fans out a second email/SMS/Slack/PagerDuty set.
    expect(jobIds).toEqual([
      'process-alert-alert-1-event-1',
      'process-alert-alert-1-event-1'
    ]);
  });

  it('gives two different events on the same alert different job ids', async () => {
    await dispatchAlertNotifications('alert-1', 'event-1');
    await dispatchAlertNotifications('alert-1', 'event-2');

    const jobIds = queueAddMock.mock.calls.map(([, , opts]) => opts?.jobId);
    expect(new Set(jobIds).size).toBe(2);
  });

  it('defaults the dedupe token to the alert id for callers that have no event', async () => {
    await dispatchAlertNotifications('alert-2');

    expect(queueAddMock.mock.calls.at(-1)?.[2]?.jobId).toBe('process-alert-alert-2-alert-2');
  });

  describe('the alert.triggered subscriber is what makes the token per-event', () => {
    // Without this, the whole dedupe can be dead and the suite above still
    // passes: it calls dispatchAlertNotifications directly, so it tests
    // argument FORMATTING, not the wiring that supplies the argument.
    function handlerFor(type: string) {
      subscribeMock.mockReset();
      subscribeToAlertEvents();
      const call = subscribeMock.mock.calls.find(([t]) => t === type);
      return call![1] as (e: unknown) => Promise<void>;
    }

    it('collapses a redelivered alert.triggered onto one job id', async () => {
      const handler = handlerFor('alert.triggered');
      const event = { id: 'event-1', payload: { alertId: 'alert-1' } };

      await handler(event);
      await handler(event);

      const jobIds = queueAddMock.mock.calls.map(([, , o]) => o?.jobId);
      expect(jobIds).toEqual(['process-alert-alert-1-event-1', 'process-alert-alert-1-event-1']);
    });

    it('keeps two distinct events on one alert distinct', async () => {
      const handler = handlerFor('alert.triggered');

      await handler({ id: 'event-1', payload: { alertId: 'alert-1' } });
      await handler({ id: 'event-2', payload: { alertId: 'alert-1' } });

      const jobIds = queueAddMock.mock.calls.map(([, , o]) => o?.jobId);
      expect(new Set(jobIds).size).toBe(2);
    });
  });
});
