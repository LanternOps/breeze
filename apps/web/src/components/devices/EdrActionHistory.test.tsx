import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchEdrActions = vi.fn();
vi.mock('@/lib/edrProviders', () => ({
  fetchEdrActions: (...a: unknown[]) => fetchEdrActions(...a),
}));

import EdrActionHistory from './EdrActionHistory';

function row(id: string, over: Record<string, unknown> = {}) {
  return {
    id, orgId: 'o', provider: 'bitdefender', action: 'isolate', status: 'succeeded', requestedVia: 'ui',
    requestedBy: null, aiSessionId: null, approvalId: null, endpointId: 'e', detectionId: null,
    breezeDeviceId: 'dev-1', error: null, outcomeUnknown: false, requestedAt: '2026-10-01T10:00:00Z',
    submittedAt: null, completedAt: null, ...over,
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  fetchEdrActions.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('EdrActionHistory', () => {
  it('fetches the last 10 rows for the device and shows an AI badge only for ai rows', async () => {
    fetchEdrActions.mockResolvedValue([row('a1', { requestedVia: 'ai' }), row('a2')]);
    render(<EdrActionHistory deviceId="dev-1" />);
    await flush();
    expect(fetchEdrActions).toHaveBeenCalledWith({ deviceId: 'dev-1', limit: 10 });
    expect(screen.getByTestId('edr-action-row-a1')).toHaveTextContent('AI');
    expect(screen.getByTestId('edr-action-ai-a1')).toBeInTheDocument();
    expect(screen.queryByTestId('edr-action-ai-a2')).toBeNull();
  });

  it('shows outcomeUnknown rows as checking, not failed', async () => {
    fetchEdrActions.mockResolvedValue([row('a1', { status: 'queued', outcomeUnknown: true })]);
    render(<EdrActionHistory deviceId="dev-1" />);
    await flush();
    expect(screen.getByTestId('edr-action-status-a1')).toHaveTextContent(/checking/i);
  });

  it('polls every 15s only while a row is open', async () => {
    fetchEdrActions.mockResolvedValue([row('a1', { status: 'submitted' })]);
    render(<EdrActionHistory deviceId="dev-1" />);
    await flush();
    expect(fetchEdrActions).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(fetchEdrActions).toHaveBeenCalledTimes(2);

    fetchEdrActions.mockResolvedValue([row('a1', { status: 'succeeded' })]);
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(fetchEdrActions).toHaveBeenCalledTimes(3);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(fetchEdrActions).toHaveBeenCalledTimes(3);
  });

  it('does not poll when nothing is open', async () => {
    fetchEdrActions.mockResolvedValue([row('a1')]);
    render(<EdrActionHistory deviceId="dev-1" />);
    await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(fetchEdrActions).toHaveBeenCalledTimes(1);
  });

  it('clears the interval on unmount', async () => {
    fetchEdrActions.mockResolvedValue([row('a1', { status: 'queued' })]);
    const { unmount } = render(<EdrActionHistory deviceId="dev-1" />);
    await flush();
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(fetchEdrActions).toHaveBeenCalledTimes(1);
  });

  it('refetches when refreshKey changes', async () => {
    fetchEdrActions.mockResolvedValue([row('a1')]);
    const { rerender } = render(<EdrActionHistory deviceId="dev-1" refreshKey={0} />);
    await flush();
    rerender(<EdrActionHistory deviceId="dev-1" refreshKey={1} />);
    await flush();
    expect(fetchEdrActions).toHaveBeenCalledTimes(2);
  });

  it('renders nothing when there are no rows', async () => {
    fetchEdrActions.mockResolvedValue([]);
    const { container } = render(<EdrActionHistory deviceId="dev-1" />);
    await flush();
    expect(container).toBeEmptyDOMElement();
  });
});
