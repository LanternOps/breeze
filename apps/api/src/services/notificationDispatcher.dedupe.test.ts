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

import { dispatchAlertNotifications, handleAlertLifecycleEvent } from './notificationDispatcher';

describe('alert.triggered redelivery cannot double-notify', () => {
  beforeEach(() => {
    queueAddMock.mockReset();
    // Default: a fresh/healthy job, never 'failed' — so the (d) failed-job
    // recovery path (getState/retry) stays a no-op for every test in this
    // file EXCEPT the ones that explicitly override this mock to exercise
    // it. Without getState, every pre-existing test here would throw inside
    // retryIfFailedJob's try/catch and only warn — silently untested and
    // noisy, not a genuine pass of the happy path.
    queueAddMock.mockResolvedValue({ id: 'job-1', getState: vi.fn().mockResolvedValue('waiting') });
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

  describe('handleAlertLifecycleEvent is what makes the token per-event', () => {
    // Without this, the whole dedupe can be dead and the suite above still
    // passes: it calls dispatchAlertNotifications directly, so it tests
    // argument FORMATTING, not the wiring that supplies the argument.
    const triggeredEvent = (id: string, alertId: string) =>
      ({ id, type: 'alert.triggered', orgId: 'org-1', payload: { alertId } }) as never;

    it('collapses a redelivered alert.triggered onto one job id', async () => {
      await handleAlertLifecycleEvent(triggeredEvent('event-1', 'alert-1'));
      await handleAlertLifecycleEvent(triggeredEvent('event-1', 'alert-1'));

      const jobIds = queueAddMock.mock.calls.map(([, , o]) => o?.jobId);
      expect(jobIds).toEqual(['process-alert-alert-1-event-1', 'process-alert-alert-1-event-1']);
    });

    it('keeps two distinct events on one alert distinct', async () => {
      await handleAlertLifecycleEvent(triggeredEvent('event-1', 'alert-1'));
      await handleAlertLifecycleEvent(triggeredEvent('event-2', 'alert-1'));

      const jobIds = queueAddMock.mock.calls.map(([, , o]) => o?.jobId);
      expect(new Set(jobIds).size).toBe(2);
    });

    // #4085: the handler used to swallow this in its own try/catch. Now the
    // registry's local wrapper provides that swallow, so this handler must
    // propagate the rejection for queue-mode retry to work at all.
    it('propagates a dispatch failure instead of swallowing it', async () => {
      queueAddMock.mockRejectedValueOnce(new Error('redis exploded'));

      await expect(
        handleAlertLifecycleEvent(triggeredEvent('event-1', 'alert-1'))
      ).rejects.toThrow('redis exploded');
    });

    it('warns (not silently no-ops) when the event is missing alertId', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await handleAlertLifecycleEvent({
        id: 'event-1',
        type: 'alert.triggered',
        orgId: 'org-1',
        payload: {},
      } as never);

      expect(queueAddMock).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      warnSpy.mockRestore();
    });
  });

  describe('(d) failed-job recovery on a duplicate jobId', () => {
    // BullMQ returns the EXISTING job for a duplicate id without enqueuing a
    // new one. Before #4085, a redelivered alert.triggered landing on a
    // previously-FAILED process-alert hash was a silent permanent drop — the
    // job just sat there failed forever, since nothing ever called retry().
    it('retries the returned job when its state is failed', async () => {
      const retry = vi.fn().mockResolvedValue(undefined);
      const failedJob = { id: 'job-1', getState: vi.fn().mockResolvedValue('failed'), retry };
      queueAddMock.mockResolvedValueOnce(failedJob);

      await dispatchAlertNotifications('alert-1', 'event-1');

      expect(failedJob.getState).toHaveBeenCalledTimes(1);
      expect(retry).toHaveBeenCalledTimes(1);
    });

    it('does not retry a job that is not in the failed state', async () => {
      const retry = vi.fn().mockResolvedValue(undefined);
      const waitingJob = { id: 'job-1', getState: vi.fn().mockResolvedValue('waiting'), retry };
      queueAddMock.mockResolvedValueOnce(waitingJob);

      await dispatchAlertNotifications('alert-1', 'event-1');

      expect(retry).not.toHaveBeenCalled();
    });

    it('swallows a retry race (e.g. the job was purged between getState and retry) instead of throwing', async () => {
      const retry = vi.fn().mockRejectedValue(new Error('job not found'));
      const failedJob = { id: 'job-1', getState: vi.fn().mockResolvedValue('failed'), retry };
      queueAddMock.mockResolvedValueOnce(failedJob);

      await expect(dispatchAlertNotifications('alert-1', 'event-1')).resolves.toBeUndefined();
      expect(retry).toHaveBeenCalledTimes(1);
    });

    it('swallows a getState failure the same way (benign — do not throw)', async () => {
      const retry = vi.fn();
      const flakyJob = { id: 'job-1', getState: vi.fn().mockRejectedValue(new Error('redis blip')), retry };
      queueAddMock.mockResolvedValueOnce(flakyJob);

      await expect(dispatchAlertNotifications('alert-1', 'event-1')).resolves.toBeUndefined();
      expect(retry).not.toHaveBeenCalled();
    });
  });
});
