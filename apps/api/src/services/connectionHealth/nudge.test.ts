import { beforeEach, describe, expect, it, vi } from 'vitest';

// The unit setup mocks this module globally (src/__tests__/setup.ts) so hot
// paths never open a BullMQ connection; this file tests the real one.
vi.unmock('./nudge');

const addMock = vi.fn(async (..._a: unknown[]) => ({ id: 'job' }));
const onMock = vi.fn();
let createThrows = false;
const outside: string[] = [];
vi.mock('../bullmqQueue', () => ({
  createInstrumentedQueue: vi.fn(() => {
    if (createThrows) throw new Error('redis not configured');
    return { add: (...a: unknown[]) => addMock(...a), on: onMock, close: vi.fn() };
  }),
}));
vi.mock('../../db', () => ({
  runOutsideDbContext: (fn: () => unknown) => { outside.push('outside'); return fn(); },
}));

import {
  CONNECTION_HEALTH_QUEUE,
  NUDGE_DELAY_MS,
  NUDGE_JOB_NAME,
  nudgeConnectionHealth,
  nudgeJobId,
  resetNudgeQueueForTests,
} from './nudge';

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.clearAllMocks();
  outside.length = 0;
  createThrows = false;
  resetNudgeQueueForTests();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('nudgeConnectionHealth', () => {
  it('adds one delayed, deduplicated reconcile-kind job outside any DB context', async () => {
    expect(nudgeConnectionHealth('oauth_grant')).toBeUndefined();
    await flush();
    expect(CONNECTION_HEALTH_QUEUE).toBe('connection-health-reconcile');
    expect(addMock).toHaveBeenCalledWith(NUDGE_JOB_NAME, { kind: 'oauth_grant' }, {
      jobId: 'reconcile-kind-oauth_grant',
      delay: 60_000,
      removeOnComplete: true,
      removeOnFail: true,
    });
    expect(outside).toEqual(['outside']);
    expect(NUDGE_DELAY_MS).toBe(60_000);
    expect(NUDGE_JOB_NAME).toBe('reconcile-kind');
  });

  it('uses a jobId BullMQ accepts (no colon)', () => {
    expect(nudgeJobId('m365_sync')).toBe('reconcile-kind-m365_sync');
    expect(nudgeJobId('m365_sync')).not.toContain(':');
  });

  it('never throws and never rejects: a failed queue or add is logged and dropped', async () => {
    createThrows = true;
    expect(() => nudgeConnectionHealth('huntress')).not.toThrow();
    createThrows = false;
    resetNudgeQueueForTests();
    addMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect(() => nudgeConnectionHealth('huntress')).not.toThrow();
    await flush();
    expect(console.warn).toHaveBeenCalled();
  });

  it('listens for queue errors so a Redis outage cannot crash the process', () => {
    nudgeConnectionHealth('edr');
    expect(onMock).toHaveBeenCalledWith('error', expect.any(Function));
  });
});
