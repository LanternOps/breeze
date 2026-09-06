import { act, render, waitFor } from '@testing-library/react';
import type { DeviceOption, DeviceOptionPage } from '@breeze/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchWithAuth } from '../stores/auth';
import {
  useDeviceOptions,
  type UseDeviceOptionsInput,
  type UseDeviceOptionsResult,
} from './useDeviceOptions';

vi.mock('../stores/auth', () => ({ fetchWithAuth: vi.fn() }));

const fetchMock = vi.mocked(fetchWithAuth);

function option(id: string, hostname = id): DeviceOption {
  return {
    id,
    hostname,
    displayName: null,
    osType: 'windows',
    status: 'online',
    siteId: null,
    siteName: null,
  };
}

function page(
  data: DeviceOption[],
  overrides: Partial<DeviceOptionPage['page']> = {},
): DeviceOptionPage {
  return {
    data,
    page: {
      nextCursor: null,
      returned: data.length,
      total: data.length,
      hasMore: false,
      observedAt: '2026-08-24T12:00:00.000Z',
      ...overrides,
    },
  };
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let latest: UseDeviceOptionsResult | null = null;

function Probe({ input }: { input: UseDeviceOptionsInput }) {
  latest = useDeviceOptions(input);
  return <output data-testid="state">{latest.state}</output>;
}

beforeEach(() => {
  latest = null;
  fetchMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useDeviceOptions', () => {
  it('moves from loading to ready and treats an empty authorized set as submittable', async () => {
    const pending = deferred<Response>();
    fetchMock.mockReturnValueOnce(pending.promise);

    render(<Probe input={{}} />);
    expect(latest?.state).toBe('loading');
    expect(latest?.canSubmit).toBe(false);

    await act(async () => pending.resolve(response(page([option('device-a')]))));
    await waitFor(() => expect(latest?.state).toBe('ready'));
    expect(latest?.options.map((item) => item.id)).toEqual(['device-a']);
    expect(latest?.canSubmit).toBe(true);

    fetchMock.mockResolvedValueOnce(response(page([])));
    await act(async () => latest?.retry());
    await waitFor(() => expect(latest?.state).toBe('empty'));
    expect(latest?.canSubmit).toBe(true);
  });

  it('surfaces request errors, blocks submission, and retries the current query', async () => {
    fetchMock
      .mockResolvedValueOnce(response({ error: 'temporarily unavailable' }, 503))
      .mockResolvedValueOnce(response(page([option('device-a')])));

    render(<Probe input={{ siteId: 'site-a' }} />);
    await waitFor(() => expect(latest?.state).toBe('error'));
    expect(latest?.error?.message).toContain('temporarily unavailable');
    expect(latest?.canSubmit).toBe(false);

    act(() => latest?.retry());
    await waitFor(() => expect(latest?.state).toBe('ready'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps old labels stale during a scope change and ignores the late old response', async () => {
    const oldScope = deferred<Response>();
    const newScope = deferred<Response>();
    fetchMock
      .mockReturnValueOnce(oldScope.promise)
      .mockReturnValueOnce(newScope.promise);

    const { rerender } = render(<Probe input={{ siteId: 'site-a' }} />);
    await act(async () => oldScope.resolve(response(page([option('old', 'Old label')]))));
    await waitFor(() => expect(latest?.state).toBe('ready'));

    rerender(<Probe input={{ siteId: 'site-b' }} />);
    expect(latest?.state).toBe('stale');
    expect(latest?.options[0]?.hostname).toBe('Old label');
    expect(latest?.canSubmit).toBe(false);

    await act(async () => newScope.resolve(response(page([option('new', 'New label')]))));
    await waitFor(() => expect(latest?.options[0]?.hostname).toBe('New label'));

    // An abort is advisory: even if a transport resolves after cancellation,
    // the generation guard must keep it from overwriting the newer scope.
    expect(latest?.state).toBe('ready');
    expect(latest?.options.map((item) => item.id)).toEqual(['new']);
  });

  it('ignores a late error from a superseded query', async () => {
    const oldScope = deferred<Response>();
    fetchMock
      .mockReturnValueOnce(oldScope.promise)
      .mockResolvedValueOnce(response(page([option('new')])));

    const { rerender } = render(<Probe input={{ orgId: 'org-a' }} />);
    rerender(<Probe input={{ orgId: 'org-b' }} />);
    await waitFor(() => expect(latest?.options[0]?.id).toBe('new'));

    await act(async () => oldScope.reject(new Error('late network failure')));
    expect(latest?.state).toBe('ready');
    expect(latest?.error).toBeNull();
  });

  it('never lets scope A overwrite scope B when B resolves first', async () => {
    const scopeA = deferred<Response>();
    const scopeB = deferred<Response>();
    fetchMock
      .mockReturnValueOnce(scopeA.promise)
      .mockReturnValueOnce(scopeB.promise);

    const { rerender } = render(<Probe input={{ siteId: 'site-a' }} />);
    rerender(<Probe input={{ siteId: 'site-b' }} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    await act(async () => scopeB.resolve(response(page([option('device-b')]))));
    await waitFor(() => expect(latest?.options.map((item) => item.id)).toEqual(['device-b']));

    await act(async () => scopeA.resolve(response(page([option('device-a')]))));
    expect(latest?.options.map((item) => item.id)).toEqual(['device-b']);
    expect(latest?.state).toBe('ready');
  });

  it('marks unresolved selected IDs as truncated and hydrates includeIds outside search', async () => {
    fetchMock
      .mockResolvedValueOnce(response(page([option('visible')], { total: 1 })))
      .mockResolvedValueOnce(response(page([option('visible'), option('selected')], { total: 1 })));

    const { rerender } = render(
      <Probe input={{ search: 'visible', includeIds: ['selected'] }} />,
    );
    await waitFor(() => expect(latest?.state).toBe('truncated'));
    expect(latest?.canSubmit).toBe(false);

    rerender(<Probe input={{ search: 'visible', includeIds: ['selected'], status: 'online' }} />);
    await waitFor(() => expect(latest?.state).toBe('ready'));
    expect(latest?.options.map((item) => item.id)).toEqual(['visible', 'selected']);

    const requestedUrl = String(fetchMock.mock.calls.at(-1)?.[0]);
    expect(requestedUrl).toContain('search=visible');
    expect(requestedUrl).toContain('includeIds=selected');
  });

  it('is truncated only when an explicitly exhaustive query has more pages', async () => {
    fetchMock
      .mockResolvedValueOnce(response(page([option('one')], {
        total: 2,
        hasMore: true,
        nextCursor: 'next-page',
      })))
      .mockResolvedValueOnce(response(page([option('one')], {
        total: 2,
        hasMore: true,
        nextCursor: 'next-page',
      })));

    const { rerender } = render(<Probe input={{ requireCompleteSet: false }} />);
    await waitFor(() => expect(latest?.state).toBe('ready'));
    expect(latest?.canSubmit).toBe(true);

    rerender(<Probe input={{ requireCompleteSet: true }} />);
    await waitFor(() => expect(latest?.state).toBe('truncated'));
    expect(latest?.canSubmit).toBe(false);
  });

  it('loads and de-duplicates cursor pages without losing hydrated selections', async () => {
    fetchMock
      .mockResolvedValueOnce(response(page([option('one'), option('selected')], {
        total: 3,
        hasMore: true,
        nextCursor: 'cursor-2',
      })))
      .mockResolvedValueOnce(response(page([option('one'), option('two'), option('selected')], {
        total: 3,
      })));

    render(<Probe input={{ includeIds: ['selected'], requireCompleteSet: true }} />);
    await waitFor(() => expect(latest?.state).toBe('truncated'));

    await act(async () => latest?.loadMore());
    await waitFor(() => expect(latest?.state).toBe('ready'));
    expect(latest?.options.map((item) => item.id)).toEqual(['one', 'selected', 'two']);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('cursor=cursor-2');
  });

  it('does not refetch an oversized selection when every selected ID is already resolved', async () => {
    const loaded = Array.from({ length: 501 }, (_, index) => option(`device-${index}`));
    fetchMock.mockResolvedValueOnce(response(page(loaded, { total: 501 })));

    const { rerender } = render(<Probe input={{ requireCompleteSet: true }} />);
    await waitFor(() => expect(latest?.state).toBe('ready'));

    rerender(
      <Probe input={{ requireCompleteSet: true, includeIds: loaded.map((item) => item.id) }} />,
    );
    await act(async () => Promise.resolve());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(latest?.state).toBe('ready');
    expect(latest?.canSubmit).toBe(true);
  });

  it('aborts the previous generation and the active request on unmount', async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    const signals: AbortSignal[] = [];
    fetchMock.mockImplementation((_url, init) => {
      signals.push(init?.signal as AbortSignal);
      return signals.length === 1 ? first.promise : second.promise;
    });

    const { rerender, unmount } = render(<Probe input={{ osType: 'windows' }} />);
    rerender(<Probe input={{ osType: 'linux' }} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(signals[0]?.aborted).toBe(true);

    unmount();
    expect(signals[1]?.aborted).toBe(true);
  });

  it('debounces server-side search and omits an empty search parameter', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(response(page([option('existing')])));

    const { rerender } = render(<Probe input={{ search: '' }} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(latest?.state).toBe('ready');
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain('search=');

    rerender(<Probe input={{ search: 'lap' }} />);
    expect(latest?.state).toBe('stale');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('search=lap');
  });

  it('restores the settled query when a debounced search is cleared before it runs', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(response(page([option('existing')])));

    const { rerender } = render(<Probe input={{ search: '' }} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(latest?.state).toBe('ready');

    rerender(<Probe input={{ search: 'temporary' }} />);
    expect(latest?.state).toBe('stale');
    rerender(<Probe input={{ search: '' }} />);

    expect(latest?.state).toBe('ready');
    expect(latest?.canSubmit).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
