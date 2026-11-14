import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { writes, failNext, runOutsideMock, systemCtxMock } = vi.hoisted(() => {
  const writes: Array<{ set: Record<string, unknown> }> = [];
  const failNext = { value: null as Error | null };
  const runOutsideMock = vi.fn((fn: () => unknown) => fn());
  const systemCtxMock = vi.fn(async (fn: () => unknown) => fn());
  return { writes, failNext, runOutsideMock, systemCtxMock };
});

vi.mock('../../db', () => ({
  db: {
    update: () => ({
      set: (set: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            if (failNext.value) { const e = failNext.value; failNext.value = null; throw e; }
            writes.push({ set });
            return [{ id: 'o1' }];
          },
        }),
      }),
    }),
  },
  runOutsideDbContext: runOutsideMock,
  withSystemDbAccessContext: systemCtxMock,
}));
vi.mock('../sentry', () => ({ captureException: vi.fn() }));

import { captureException } from '../sentry';
import { CONTEXT_WINDOW_MEMO_TTL_MS } from './gateway/openai/contextWindow';
import {
  __resetContextWindowObservationsForTests,
  recordObservedContextWindow,
  settledContextWindowObservations,
} from './contextWindowObservation';

const OBS = { offeringId: 'o1', partnerId: 'p1', configVersion: 4, contextWindow: 8192 };

beforeEach(() => {
  writes.length = 0;
  failNext.value = null;
  vi.clearAllMocks();
});
afterEach(() => {
  __resetContextWindowObservationsForTests();
  vi.useRealTimers();
});

describe('recordObservedContextWindow (#11396 T6)', () => {
  it('writes observed, observed_at and observed_config_version in the system context, outside any request context', async () => {
    recordObservedContextWindow(OBS);
    await settledContextWindowObservations();
    expect(writes).toHaveLength(1);
    expect(writes[0]!.set).toEqual({
      contextWindowObserved: 8192,
      contextWindowObservedAt: expect.any(Date),
      contextWindowObservedConfigVersion: 4,
    });
    expect(runOutsideMock).toHaveBeenCalledOnce();
    expect(systemCtxMock).toHaveBeenCalledOnce();
  });

  it('returns void synchronously: the caller never awaits the write', () => {
    expect(recordObservedContextWindow(OBS)).toBeUndefined();
  });

  it('a thrown write is logged and reported, never rethrown', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    failNext.value = new Error('db down');
    expect(() => recordObservedContextWindow(OBS)).not.toThrow();
    await expect(settledContextWindowObservations()).resolves.toBeUndefined();
    expect(writes).toHaveLength(0);
    expect(captureException).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('a failed write does not dedupe: the next rejection tries again', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    failNext.value = new Error('db down');
    recordObservedContextWindow(OBS);
    await settledContextWindowObservations();
    recordObservedContextWindow(OBS);
    await settledContextWindowObservations();
    expect(writes).toHaveLength(1);
    warn.mockRestore();
  });

  it('the same observation is written once per TTL', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    recordObservedContextWindow(OBS);
    recordObservedContextWindow(OBS);
    await settledContextWindowObservations();
    expect(writes).toHaveLength(1);
    vi.setSystemTime(Date.now() + CONTEXT_WINDOW_MEMO_TTL_MS + 1);
    recordObservedContextWindow(OBS);
    await settledContextWindowObservations();
    expect(writes).toHaveLength(2);
  });

  it('a different window, config_version or offering is a new observation', async () => {
    recordObservedContextWindow(OBS);
    recordObservedContextWindow({ ...OBS, contextWindow: 4096 });
    recordObservedContextWindow({ ...OBS, configVersion: 5 });
    recordObservedContextWindow({ ...OBS, offeringId: 'o2' });
    await settledContextWindowObservations();
    expect(writes).toHaveLength(4);
  });

  it('an implausible window is never written', async () => {
    recordObservedContextWindow({ ...OBS, contextWindow: 70 });
    await settledContextWindowObservations();
    expect(writes).toHaveLength(0);
  });
});
