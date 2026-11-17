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
  clearDisprovenContextWindow,
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

describe('clearDisprovenContextWindow (#11393 floor)', () => {
  const DISPROOF = { offeringId: 'o1', partnerId: 'p1', configVersion: 4, disprovenWindow: 8192, observedAt: Date.parse('2026-11-11T09:00:00Z'), servedPromptTokens: 9000 };

  it('clears observed, observed_at and observed_config_version in the system context, outside any request context', async () => {
    clearDisprovenContextWindow(DISPROOF);
    await settledContextWindowObservations();
    expect(writes).toHaveLength(1);
    expect(writes[0]!.set).toEqual({
      contextWindowObserved: null,
      contextWindowObservedAt: null,
      contextWindowObservedConfigVersion: null,
    });
    expect(runOutsideMock).toHaveBeenCalledOnce();
    expect(systemCtxMock).toHaveBeenCalledOnce();
  });

  it('returns void and never rethrows a failed write (logged and reported)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    failNext.value = new Error('db down');
    expect(clearDisprovenContextWindow(DISPROOF)).toBeUndefined();
    await expect(settledContextWindowObservations()).resolves.toBeUndefined();
    expect(captureException).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('is written once per disproven window for the TTL (a busy session does not write per request)', async () => {
    clearDisprovenContextWindow(DISPROOF);
    clearDisprovenContextWindow({ ...DISPROOF, servedPromptTokens: 9500 });
    await settledContextWindowObservations();
    expect(writes).toHaveLength(1);
  });

  it('a disproof of a NEWER row holding the same value is not deduped against the older one', async () => {
    clearDisprovenContextWindow(DISPROOF);
    clearDisprovenContextWindow({ ...DISPROOF, observedAt: DISPROOF.observedAt + 60_000 });
    await settledContextWindowObservations();
    expect(writes).toHaveLength(2);
  });

  it('a served prompt that does not exceed the window clears nothing', async () => {
    clearDisprovenContextWindow({ ...DISPROOF, servedPromptTokens: 8192 });
    await settledContextWindowObservations();
    expect(writes).toHaveLength(0);
  });

  it('after a clear, the same window stated again by a rejection is written again (not deduped)', async () => {
    recordObservedContextWindow(OBS);
    await settledContextWindowObservations();
    clearDisprovenContextWindow(DISPROOF);
    await settledContextWindowObservations();
    recordObservedContextWindow(OBS);
    await settledContextWindowObservations();
    expect(writes.map((w) => w.set.contextWindowObserved)).toEqual([8192, null, 8192]);
  });

  it('a window stated again after a different one is written again: A, B, A lands A (review finding)', async () => {
    recordObservedContextWindow(OBS);
    await settledContextWindowObservations();
    recordObservedContextWindow({ ...OBS, contextWindow: 4096 });
    await settledContextWindowObservations();
    recordObservedContextWindow(OBS);
    await settledContextWindowObservations();
    expect(writes.map((w) => w.set.contextWindowObserved)).toEqual([8192, 4096, 8192]);
  });

  it('a failed clear is tagged as a clear for Sentry, a failed set as a set', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    failNext.value = new Error('db down');
    clearDisprovenContextWindow(DISPROOF);
    await settledContextWindowObservations();
    expect(vi.mocked(captureException).mock.calls[0]![2]).toMatchObject({ operation: 'clear' });
    failNext.value = new Error('db down');
    recordObservedContextWindow(OBS);
    await settledContextWindowObservations();
    expect(vi.mocked(captureException).mock.calls[1]![2]).toMatchObject({ operation: 'set' });
    warn.mockRestore();
  });

  it('after a new observation, a later disproof of the same window clears again', async () => {
    clearDisprovenContextWindow(DISPROOF);
    await settledContextWindowObservations();
    recordObservedContextWindow(OBS);
    await settledContextWindowObservations();
    clearDisprovenContextWindow(DISPROOF);
    await settledContextWindowObservations();
    expect(writes.map((w) => w.set.contextWindowObserved)).toEqual([null, 8192, null]);
  });
});
