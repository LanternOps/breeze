import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getLatestVersion, _resetLatestVersionCache } from './latestVersion';

describe('latestVersion', () => {
  beforeEach(() => {
    _resetLatestVersionCache();
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns parsed tag from GitHub on first call', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ tag_name: 'v0.65.10' }), { status: 200 }),
    );
    const r = await getLatestVersion();
    expect(r.latest).toBe('0.65.10');
    expect(r.source).toBe('github');
    expect(fetchSpy).toHaveBeenCalledOnce();
    const url = fetchSpy.mock.calls[0]![0] as string;
    expect(url).toContain('api.github.com/repos/LanternOps/breeze/releases/latest');
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)['User-Agent']).toBe('breeze-rmm-api');
  });

  it('returns cached value on second call within TTL', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ tag_name: 'v0.65.10' }), { status: 200 }),
    );
    await getLatestVersion();
    const r2 = await getLatestVersion();
    expect(r2.latest).toBe('0.65.10');
    expect(r2.source).toBe('cache');
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('re-fetches after TTL expires', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ tag_name: 'v0.65.10' }), { status: 200 }),
    );
    const start = Date.now();
    const realNow = Date.now;
    Date.now = () => start;
    try {
      await getLatestVersion();
      Date.now = () => start + 60 * 60 * 1000 + 1;
      await getLatestVersion();
    } finally {
      Date.now = realNow;
    }
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('aborts and returns null when fetch exceeds the timeout', async () => {
    vi.spyOn(global, 'fetch').mockImplementationOnce((_url, init) => {
      return new Promise((_resolve, reject) => {
        const signal = (init as RequestInit | undefined)?.signal;
        signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    });
    vi.useFakeTimers();
    try {
      const pending = getLatestVersion();
      await vi.advanceTimersByTimeAsync(10_001);
      const r = await pending;
      expect(r.latest).toBeNull();
      expect(r.source).toBe('error');
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns null and source=error on HTTP 5xx', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(new Response('boom', { status: 500 }));
    const r = await getLatestVersion();
    expect(r.latest).toBeNull();
    expect(r.source).toBe('error');
  });

  it('returns null and source=error on HTTP 404', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(new Response('not found', { status: 404 }));
    const r = await getLatestVersion();
    expect(r.latest).toBeNull();
    expect(r.source).toBe('error');
  });

  it('returns null on network failure', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('ENOTFOUND'));
    const r = await getLatestVersion();
    expect(r.latest).toBeNull();
    expect(r.source).toBe('error');
  });

  it('returns null on malformed JSON', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(new Response('not json', { status: 200 }));
    const r = await getLatestVersion();
    expect(r.latest).toBeNull();
    expect(r.source).toBe('error');
  });

  it('rejects prerelease tags', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ tag_name: 'v0.65.10-rc1' }), { status: 200 }),
    );
    const r = await getLatestVersion();
    expect(r.latest).toBeNull();
    expect(r.source).toBe('error');
  });

  it('rejects malformed tag', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ tag_name: 'release-2026-01-01' }), { status: 200 }),
    );
    const r = await getLatestVersion();
    expect(r.latest).toBeNull();
  });

  it('does not abort a slow-but-healthy GitHub response before 10s (#6629)', async () => {
    // Cold GitHub latency of ~4-6s used to trip the old 5s timeout.
    vi.spyOn(global, 'fetch').mockImplementationOnce((_url, init) => {
      return new Promise((resolve, reject) => {
        const signal = (init as RequestInit | undefined)?.signal;
        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        setTimeout(
          () => resolve(new Response(JSON.stringify({ tag_name: 'v1.2.3' }), { status: 200 })),
          6000,
        );
      });
    });
    vi.useFakeTimers();
    try {
      const pending = getLatestVersion();
      await vi.advanceTimersByTimeAsync(6001);
      const r = await pending;
      expect(r.latest).toBe('1.2.3');
      expect(r.source).toBe('github');
    } finally {
      vi.useRealTimers();
    }
  });

  describe('cache TTLs (#6629)', () => {
    const MIN = 60 * 1000;
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-09-23T12:00:00Z'));
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('serves an error result from cache within the short error TTL (no retry storm)', async () => {
      const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
        new Response('boom', { status: 500 }),
      );
      await getLatestVersion();
      vi.advanceTimersByTime(5 * MIN - 1);
      const r = await getLatestVersion();
      expect(r.source).toBe('cache');
      expect(r.latest).toBeNull();
      expect(fetchSpy).toHaveBeenCalledOnce();
    });

    it('expires an error result after the short error TTL, not the 1h success TTL', async () => {
      const fetchSpy = vi
        .spyOn(global, 'fetch')
        .mockResolvedValueOnce(new Response('boom', { status: 500 }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ tag_name: 'v1.2.3' }), { status: 200 }),
        );
      const first = await getLatestVersion();
      expect(first.source).toBe('error');
      vi.advanceTimersByTime(5 * MIN + 1);
      const second = await getLatestVersion();
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(second.source).toBe('github');
      expect(second.latest).toBe('1.2.3');
    });

    it('keeps a successful result cached for the full hour', async () => {
      const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async () =>
        new Response(JSON.stringify({ tag_name: 'v1.2.3' }), { status: 200 }),
      );
      await getLatestVersion();
      vi.advanceTimersByTime(60 * MIN - 1);
      const cached = await getLatestVersion();
      expect(cached.source).toBe('cache');
      expect(fetchSpy).toHaveBeenCalledOnce();
      vi.advanceTimersByTime(2);
      const refreshed = await getLatestVersion();
      expect(refreshed.source).toBe('github');
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });
  });

  it('strips leading v from tag', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ tag_name: 'v1.2.3' }), { status: 200 }),
    );
    const r = await getLatestVersion();
    expect(r.latest).toBe('1.2.3');
  });

  it('accepts tag without leading v', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ tag_name: '1.2.3' }), { status: 200 }),
    );
    const r = await getLatestVersion();
    expect(r.latest).toBe('1.2.3');
  });
});
