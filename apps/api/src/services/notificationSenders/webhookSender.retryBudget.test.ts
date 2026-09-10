import { afterEach, describe, expect, it, vi } from 'vitest';

const { safeFetchMock } = vi.hoisted(() => ({ safeFetchMock: vi.fn() }));
vi.mock('../urlSafety', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../urlSafety')>();
  return { ...actual, safeFetch: safeFetchMock };
});

import { sendWebhookNotification, validateWebhookConfig, webhookTotalAttempts } from './webhookSender';

const payload = {
  alertId: 'alert-1',
  alertName: 'Synthetic alert',
  severity: 'high',
  summary: 'bounded retry test',
  orgId: 'org-1',
  triggeredAt: '2026-09-07T00:00:00.000Z',
};

describe('webhook sender retry budget', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    safeFetchMock.mockReset();
  });

  it('performs one bounded network attempt and never sleeps in a worker slot', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    safeFetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => 'synthetic retryable failure',
    } as Response);

    const pending = sendWebhookNotification(
      { url: 'https://example.com/hook', retryCount: 1, timeout: 1_000 },
      payload,
    );
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(result.success).toBe(false);
    expect(result.retryable).toBe(true);
    expect(safeFetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    [0, 1],
    [1, 2],
    [2, 3],
    [99, 3],
    [-4, 1],
    [1.9, 2],
    ['99', 3],
    [undefined, 3],
  ])('converts configured retries %j to %d bounded total attempts', (retryCount, attempts) => {
    expect(webhookTotalAttempts({ retryCount })).toBe(attempts);
  });

  it('marks 4xx configuration failures non-retryable', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    safeFetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => 'not found',
    } as Response);

    await expect(sendWebhookNotification(
      { url: 'https://example.com/hook' }, payload,
    )).resolves.toMatchObject({ success: false, retryable: false });
    expect(safeFetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([408, 425, 429, 503])('marks transient HTTP %d failures retryable', async (status) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    safeFetchMock.mockResolvedValue({
      ok: false,
      status,
      text: async () => 'synthetic transient failure',
    } as Response);

    await expect(sendWebhookNotification(
      { url: 'https://example.com/hook' }, payload,
    )).resolves.toMatchObject({ success: false, retryable: true });
    expect(safeFetchMock).toHaveBeenCalledTimes(1);
  });

  it('clamps a legacy oversized timeout, aborts once, and never adds a backoff sleep', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    safeFetchMock.mockImplementation((_url: string, options?: RequestInit) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    }));

    const pending = sendWebhookNotification(
      { url: 'https://example.com/hook', retryCount: 2, timeout: Number.MAX_SAFE_INTEGER }, payload,
    );
    await vi.advanceTimersByTimeAsync(59_999);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toMatchObject({
      success: false,
      error: 'Request timed out',
      retryable: true,
    });
    expect(safeFetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([-1, 1.5, 3, Number.MAX_SAFE_INTEGER, '1000'])('rejects an unsafe retryCount %j', (retryCount) => {
    const result = validateWebhookConfig({
      url: 'https://example.com/hook',
      retryCount,
    });

    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('retryCount');
  });

  it.each([0, 1, 2])('accepts bounded integer retryCount %d for durable queue scheduling', (retryCount) => {
    expect(validateWebhookConfig({ url: 'https://example.com/hook', retryCount })).toEqual({
      valid: true,
      errors: [],
    });
  });
});
