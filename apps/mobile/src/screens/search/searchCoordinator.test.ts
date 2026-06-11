import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The coordinator imports the real searchAll from services/search, which
// transitively pulls expo-secure-store / react-native. We never call the
// real path (every test injects its own searcher), but vitest still has
// to resolve the module graph — so stub the leaf modules here.
vi.mock('expo-secure-store', () => ({ getItemAsync: vi.fn() }));
vi.mock('../../services/serverConfig', () => ({ getServerUrl: vi.fn() }));

import { createSearchCoordinator } from './searchCoordinator';
import type { MobileSearchResult } from '../../services/search';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const sampleResult: MobileSearchResult = {
  kind: 'device',
  id: 'd1',
  title: 'macbook',
  subtitle: 'macos',
  meta: {
    orgId: 'o1',
    siteId: null,
    hostname: 'macbook',
    displayName: null,
    osType: 'macos',
    status: 'online',
    lastSeenAt: null,
    siteName: null,
  },
};

describe('searchCoordinator', () => {
  it('debounces successive setQuery calls into a single network call', async () => {
    const searcher = vi.fn().mockResolvedValue({ results: [sampleResult] });
    const coord = createSearchCoordinator({ debounceMs: 250, searcher });

    coord.setQuery('m');
    coord.setQuery('ma');
    coord.setQuery('mac');

    // Pre-debounce: nothing dispatched yet, but loading is on.
    expect(searcher).not.toHaveBeenCalled();
    expect(coord.getSnapshot().loading).toBe(true);

    await vi.advanceTimersByTimeAsync(250);
    // Microtask drain so the .then() in the coordinator sees the resolution.
    await Promise.resolve();

    expect(searcher).toHaveBeenCalledTimes(1);
    expect(searcher).toHaveBeenCalledWith('mac', 20, expect.any(AbortSignal));
    expect(coord.getSnapshot().results).toHaveLength(1);
    expect(coord.getSnapshot().loading).toBe(false);
  });

  it('aborts an in-flight request when a new query supersedes it', async () => {
    const aborted: boolean[] = [];
    const searcher = vi.fn().mockImplementation(
      (_q: string, _limit: number, signal: AbortSignal) =>
        new Promise<{ results: MobileSearchResult[] }>((resolve, reject) => {
          signal.addEventListener('abort', () => {
            aborted.push(true);
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
          // Resolve only on demand from the outer test — but the second
          // setQuery is supposed to abort us before this fires.
          setTimeout(() => resolve({ results: [] }), 5_000);
        }),
    );

    const coord = createSearchCoordinator({ debounceMs: 250, searcher });

    coord.setQuery('mac');
    await vi.advanceTimersByTimeAsync(250);
    // First call is now pending.
    expect(searcher).toHaveBeenCalledTimes(1);

    // New query: cancels the pending one and starts another debounced fetch.
    coord.setQuery('macbook');
    expect(aborted).toEqual([true]);

    await vi.advanceTimersByTimeAsync(250);
    expect(searcher).toHaveBeenCalledTimes(2);
    expect(searcher.mock.calls[1][0]).toBe('macbook');
  });

  it('surfaces server errors via the error snapshot field', async () => {
    const searcher = vi.fn().mockRejectedValue(new Error('Rate limit exceeded'));
    const coord = createSearchCoordinator({ debounceMs: 250, searcher });

    coord.setQuery('mac');
    await vi.advanceTimersByTimeAsync(250);
    // Two microtask drains: one for searcher rejection, one for the
    // .catch handler to update the snapshot.
    await Promise.resolve();
    await Promise.resolve();

    const snap = coord.getSnapshot();
    expect(snap.error).toBe('Rate limit exceeded');
    expect(snap.results).toEqual([]);
    expect(snap.loading).toBe(false);
  });

  it('preserves the API discriminated-union shape across all three kinds', async () => {
    const apiResults: MobileSearchResult[] = [
      sampleResult,
      {
        kind: 'alert',
        id: 'a1',
        title: 'Disk full',
        subtitle: 'critical',
        meta: {
          orgId: 'o1',
          severity: 'critical',
          status: 'active',
          deviceId: 'd1',
          deviceName: 'macbook',
          message: null,
          triggeredAt: null,
        },
      },
      {
        kind: 'session',
        id: 's1',
        title: 'macbook diag',
        subtitle: '4 turns',
        meta: {
          orgId: 'o1',
          status: 'active',
          turnCount: 4,
          lastActivityAt: null,
          createdAt: null,
        },
      },
    ];
    const searcher = vi.fn().mockResolvedValue({ results: apiResults });

    const coord = createSearchCoordinator({ debounceMs: 0, searcher });
    coord.setQuery('mac');
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();

    const snap = coord.getSnapshot();
    expect(snap.results.map((r) => r.kind).sort()).toEqual(['alert', 'device', 'session']);
    // Discriminator narrowing: only `alert` carries `severity`.
    const alert = snap.results.find((r) => r.kind === 'alert');
    expect(alert && alert.kind === 'alert' ? alert.meta.severity : null).toBe('critical');
  });

  it('clear() cancels pending work and resets to the empty snapshot', async () => {
    const searcher = vi.fn().mockResolvedValue({ results: [sampleResult] });
    const coord = createSearchCoordinator({ debounceMs: 250, searcher });

    coord.setQuery('mac');
    coord.clear();
    await vi.advanceTimersByTimeAsync(250);

    expect(searcher).not.toHaveBeenCalled();
    expect(coord.getSnapshot()).toEqual({
      query: '',
      results: [],
      loading: false,
      error: null,
    });
  });
});
