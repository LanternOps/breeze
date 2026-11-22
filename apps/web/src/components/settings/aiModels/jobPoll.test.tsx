// #12456: Verify / Refresh answer 202 and finish in a background job; the open
// drawer and the connection card must pick the result up without a reload.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type { AiOfferingDto } from '@breeze/shared';
import { jsonRes, CONN, GW, GATEWAY_CONNECTION, SNAPSHOT } from './testFixtures';
import { NO_SURFACE_TURNS, OFF, offeringRow } from './offeringFixtures';

const fetchWithAuth = vi.fn();
vi.mock('../../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
vi.mock('../../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

import OfferingDrawer from './OfferingDrawer';
import ConnectionDrawer from './ConnectionDrawer';
import PartnerAiModelsTab from './PartnerAiModelsTab';
import { JOB_POLL_INTERVAL_MS, JOB_POLL_MAX_TICKS } from './useJobPoll';

const verification = (at: string, state: 'verified' | 'failed' = 'verified'): NonNullable<AiOfferingDto['verification']> =>
  ({ state, at, harnessVersion: 'h1', summary: null, surfaces: NO_SURFACE_TURNS });
const offering = (v: AiOfferingDto['verification']) => offeringRow({ id: OFF, connectionId: CONN, funding: 'partner_key', verification: v });

/** Click, then flush the queued 202 (runAction resolves on microtasks). */
async function click(testId: string) {
  await act(async () => { fireEvent.click(screen.getByTestId(testId)); });
  await act(async () => { await Promise.resolve(); });
}
const tick = (ms = JOB_POLL_INTERVAL_MS) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

beforeEach(() => {
  fetchWithAuth.mockReset();
  vi.useFakeTimers();
});
afterEach(() => { vi.useRealTimers(); });

describe('OfferingDrawer — refetch after async verify (#12456)', () => {
  it('re-reads until the verification changes, then stops', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ queued: true }, 202));
    const onSaved = vi.fn();
    const { rerender } = render(<OfferingDrawer offering={offering(verification('2026-11-21T10:00:00Z'))} offerings={[]} onClose={vi.fn()} onSaved={onSaved} />);
    expect(onSaved).not.toHaveBeenCalled(); // nothing pending: no polling
    await tick(JOB_POLL_INTERVAL_MS * 3);
    expect(onSaved).not.toHaveBeenCalled();

    await click('ai-offering-verify');
    await tick();
    expect(onSaved).toHaveBeenCalledTimes(1); // job still running: unchanged row, keep polling
    await tick();
    expect(onSaved).toHaveBeenCalledTimes(2);

    // The job lands: the parent's snapshot now carries the new verification.
    rerender(<OfferingDrawer offering={offering(verification('2026-11-21T10:05:00Z'))} offerings={[]} onClose={vi.fn()} onSaved={onSaved} />);
    await tick(JOB_POLL_INTERVAL_MS * 5);
    expect(onSaved).toHaveBeenCalledTimes(2);
  });

  it('gives up after the tick cap when the job never lands', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ queued: true }, 202));
    const onSaved = vi.fn();
    render(<OfferingDrawer offering={offering(null)} offerings={[]} onClose={vi.fn()} onSaved={onSaved} />);
    await click('ai-offering-verify');
    await tick(JOB_POLL_INTERVAL_MS * (JOB_POLL_MAX_TICKS + 10));
    expect(onSaved).toHaveBeenCalledTimes(JOB_POLL_MAX_TICKS);
  });

  it('stops polling when the drawer unmounts', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ queued: true }, 202));
    const onSaved = vi.fn();
    const { unmount } = render(<OfferingDrawer offering={offering(null)} offerings={[]} onClose={vi.fn()} onSaved={onSaved} />);
    await click('ai-offering-verify');
    await tick();
    expect(onSaved).toHaveBeenCalledTimes(1);
    unmount();
    await tick(JOB_POLL_INTERVAL_MS * 5);
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('does not poll when the verify request fails', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ error: 'nope', code: 'not_found' }, 404));
    const onSaved = vi.fn();
    render(<OfferingDrawer offering={offering(null)} offerings={[]} onClose={vi.fn()} onSaved={onSaved} />);
    await click('ai-offering-verify');
    await tick(JOB_POLL_INTERVAL_MS * 3);
    expect(onSaved).not.toHaveBeenCalled();
  });
});

describe('ConnectionDrawer — refetch after async refresh (#12456)', () => {
  it('stops polling on unmount and re-reads while the discovery stamp is unchanged', async () => {
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ queued: true }, 202));
    const onSaved = vi.fn();
    const conn = { ...GATEWAY_CONNECTION, lastDiscoveredAt: '2026-11-21T10:00:00Z' };
    const { unmount } = render(<ConnectionDrawer connection={conn} catalog={[]} catalogEnabled={false} onClose={vi.fn()} onSaved={onSaved} />);
    await click('ai-connection-refresh');
    await tick();
    expect(onSaved).toHaveBeenCalledTimes(1);
    unmount();
    await tick(JOB_POLL_INTERVAL_MS * 5);
    expect(onSaved).toHaveBeenCalledTimes(1);
  });
});

describe('PartnerAiModelsTab — card updates after refresh 202 (#12456)', () => {
  const snap = (count: number, at: string) => ({
    ...SNAPSHOT,
    connections: [SNAPSHOT.connections[0], { ...GATEWAY_CONNECTION, lastDiscoveredAt: at }],
    offerings: Array.from({ length: count }, (_, i) => offeringRow({ id: `55555555-5555-4555-8555-55555555555${i}`, connectionId: GW, funding: 'partner_key', modelId: `m-${i}`, displayName: `M${i}` })),
  });

  it('shows the new model count without a reload, then stops polling', async () => {
    fetchWithAuth
      .mockResolvedValueOnce(jsonRes(snap(4, '2026-11-21T10:00:00Z')))   // initial load
      .mockResolvedValueOnce(jsonRes({ queued: true }, 202))             // POST refresh
      .mockResolvedValueOnce(jsonRes(snap(4, '2026-11-21T10:00:00Z')))   // poll 1: job still running
      .mockResolvedValue(jsonRes(snap(7, '2026-11-21T10:05:00Z')));      // poll 2+: landed
    render(<PartnerAiModelsTab />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByTestId(`ai-connection-discovery-${GW}`).textContent).toMatch(/Found 4 models/);

    await act(async () => { fireEvent.click(screen.getByTestId(`ai-connection-edit-${GW}`)); });
    await click('ai-connection-refresh');
    await tick();
    expect(screen.getByTestId(`ai-connection-discovery-${GW}`).textContent).toMatch(/Found 4 models/);
    await tick();
    expect(screen.getByTestId(`ai-connection-discovery-${GW}`).textContent).toMatch(/Found 7 models/);

    const callsWhenLanded = fetchWithAuth.mock.calls.length;
    await tick(JOB_POLL_INTERVAL_MS * 5);
    expect(fetchWithAuth.mock.calls.length).toBe(callsWhenLanded);
  });
});
