import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import AiCostIndicator from './AiCostIndicator';
import { fetchWithAuth, useAuthStore } from '../../stores/auth';
import { formatCurrency } from '@/lib/i18n/format';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: vi.fn((selector: (state: { isAuthenticated: boolean }) => boolean) =>
    selector({ isAuthenticated: true })
  ),
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);
const useAuthStoreMock = vi.mocked(useAuthStore);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload)
  }) as unknown as Response;

describe('AiCostIndicator polling behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    useAuthStoreMock.mockImplementation((selector: any) => selector({ isAuthenticated: true }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stops polling after an immediate unauthorized response', async () => {
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({}, false, 401));

    render(<AiCostIndicator />);

    await act(async () => {
      await Promise.resolve();
    });

    expect(fetchWithAuthMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(180_000);
      await Promise.resolve();
    });

    // After a 401, polling should have stopped — still only 1 call
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(1);
  });
});

describe('AiCostIndicator post-turn refresh (defect: stale header through a completed exchange)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    useAuthStoreMock.mockImplementation((selector: any) => selector({ isAuthenticated: true }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const zeroUsage = {
    daily: { totalCostCents: 0, messageCount: 0 },
    monthly: { totalCostCents: 0, messageCount: 0 },
    budget: null,
  };
  const oneMessageUsage = {
    daily: { totalCostCents: 11, messageCount: 1 },
    monthly: { totalCostCents: 11, messageCount: 1 },
    budget: null,
  };

  it('refetches immediately when isStreaming flips true -> false, without waiting for the 60s poll', async () => {
    fetchWithAuthMock
      .mockResolvedValueOnce(makeJsonResponse(zeroUsage))
      .mockResolvedValueOnce(makeJsonResponse(oneMessageUsage));

    const { rerender, container } = render(<AiCostIndicator isStreaming />);

    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain(formatCurrency(0));

    // The exchange completes — the store flips isStreaming to false.
    rerender(<AiCostIndicator isStreaming={false} />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // Refetched right away — no 60s timer advance needed — and the header
    // reflects the new spend/message count instead of staying at $0.00 / 0 msgs.
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain(formatCurrency(0.11));
  });

  it('does not refetch on mount or re-render when isStreaming is omitted (back-compat, poll-only)', async () => {
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse(zeroUsage));

    const { rerender } = render(<AiCostIndicator />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(1);

    rerender(<AiCostIndicator />);
    await act(async () => {
      await Promise.resolve();
    });
    // No isStreaming prop → the post-turn refresh effect never fires.
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(1);
  });

  it('does not refetch on the false -> true edge (turn starting, not completing)', async () => {
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse(zeroUsage));

    const { rerender } = render(<AiCostIndicator isStreaming={false} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(1);

    rerender(<AiCostIndicator isStreaming />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(1);
  });
});
