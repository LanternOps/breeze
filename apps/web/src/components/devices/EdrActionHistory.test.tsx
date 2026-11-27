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
    submittedAt: null, completedAt: null, requestedByName: null, vendorReason: null, awaitingConfirmation: false, ...over,
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

  it('#12789: shows the requester by name, never an id prefix', async () => {
    const uid = '7f3a91c2-0000-4000-8000-000000000001';
    fetchEdrActions.mockResolvedValue([
      row('a1', { requestedBy: uid, requestedByName: 'Dana Tech' }),
      row('a2', { requestedBy: uid, requestedByName: null }),
    ]);
    render(<EdrActionHistory deviceId="dev-1" />);
    await flush();
    expect(screen.getByTestId('edr-action-requester-a1')).toHaveTextContent('Dana Tech');
    expect(screen.getByTestId('edr-action-requester-a2')).toHaveTextContent('Unknown user');
    expect(screen.getByTestId('edr-action-history')).not.toHaveTextContent(uid.slice(0, 8));
  });

  it("#12789: a vendor rejection shows the vendor's reason as plain text", async () => {
    fetchEdrActions.mockResolvedValue([
      row('a1', { status: 'failed', error: 'vendor_rejected', vendorReason: 'Endpoint <b>does not exist</b>' }),
    ]);
    render(<EdrActionHistory deviceId="dev-1" />);
    await flush();
    expect(screen.getByTestId('edr-action-status-a1')).toHaveTextContent('Failed');
    expect(screen.getByTestId('edr-action-failure-a1')).toHaveTextContent('Rejected by the vendor');
    // Rendered as text, never as markup.
    expect(screen.getByTestId('edr-action-vendor-reason-a1').textContent).toBe('Endpoint <b>does not exist</b>');
    expect(screen.getByTestId('edr-action-vendor-reason-a1').querySelector('b')).toBeNull();
  });

  it('#12789: a Breeze-coded failure shows its translated reason; an unknown code a generic one', async () => {
    fetchEdrActions.mockResolvedValue([
      row('a1', { status: 'failed', error: 'isolation_unconfirmed' }),
      row('a2', { status: 'failed', error: 'something_new' }),
      row('a3', { status: 'succeeded', error: 'reconciled_applied' }),
    ]);
    render(<EdrActionHistory deviceId="dev-1" />);
    await flush();
    expect(screen.getByTestId('edr-action-failure-a1')).toHaveTextContent(/did not confirm.*may still apply when the device reconnects/i);
    expect(screen.getByTestId('edr-action-failure-a2')).toHaveTextContent('The action did not complete');
    expect(screen.queryByTestId('edr-action-failure-a3')).toBeNull();
    expect(screen.queryByTestId('edr-action-vendor-reason-a1')).toBeNull();
  });

  it('#12822: a vendor task never confirmed finished reads as unconfirmed, not as "did not finish"', async () => {
    fetchEdrActions.mockResolvedValue([row('a1', { action: 'scan', status: 'failed', error: 'vendor_status_timeout' })]);
    render(<EdrActionHistory deviceId="dev-1" />);
    await flush();
    const text = screen.getByTestId('edr-action-failure-a1').textContent ?? '';
    expect(text).toMatch(/did not confirm the task finished within 24 hours.*check the vendor console/i);
    expect(text).not.toMatch(/did not finish/i);
  });

  it('#12789: an accepted isolate reads as awaiting confirmation, not as done', async () => {
    fetchEdrActions.mockResolvedValue([row('a1', { status: 'submitted', awaitingConfirmation: true })]);
    render(<EdrActionHistory deviceId="dev-1" />);
    await flush();
    const status = screen.getByTestId('edr-action-status-a1');
    expect(status).toHaveTextContent(/waiting for the device to confirm/i);
    expect(status).not.toHaveTextContent(/succeeded|isolated/i);
  });

  it('renders nothing when there are no rows', async () => {
    fetchEdrActions.mockResolvedValue([]);
    const { container } = render(<EdrActionHistory deviceId="dev-1" />);
    await flush();
    expect(container).toBeEmptyDOMElement();
  });
});
