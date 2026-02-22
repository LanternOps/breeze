import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import AiCostIndicator from './AiCostIndicator';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: vi.fn(),
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

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
