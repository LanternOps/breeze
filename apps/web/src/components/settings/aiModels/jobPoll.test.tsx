// #12456: Verify / Refresh answer 202 and finish in a background job; the open
// drawer and the connection card must pick the result up without a reload.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type { AiOfferingDto } from '@breeze/shared';
import { jsonRes, GW, GATEWAY_CONNECTION, SNAPSHOT } from './testFixtures';
import { NO_SURFACE_TURNS, offeringRow } from './offeringFixtures';

const fetchWithAuth = vi.fn();
vi.mock('../../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
vi.mock('../../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

import OfferingDrawer from './OfferingDrawer';
import ConnectionDrawer from './ConnectionDrawer';
import PartnerAiModelsTab from './PartnerAiModelsTab';
import { JOB_POLL_INTERVAL_MS, JOB_POLL_MAX_TICKS } from './useJobPoll';

const OFF1 = '55555555-5555-4555-8555-555555555550';
const verification = (chat: 'absent' | 'passed'): NonNullable<AiOfferingDto['verification']> => ({
  state: 'verified', at: chat === 'passed' ? '2026-11-21T10:05:00Z' : '2026-11-21T10:00:00Z', harnessVersion: 'h1', summary: null,
  surfaces: { ...NO_SURFACE_TURNS, chat: { state: chat, at: null, profile: 'standard', promptTokens: chat === 'passed' ? 4321 : null, cachedTokens: null, summary: null } },
});
const gwOffering = (v: AiOfferingDto['verification'], i = 0) =>
  offeringRow({ id: i === 0 ? OFF1 : `55555555-5555-4555-8555-55555555555${i}`, connectionId: GW, funding: 'partner_key', source: 'discovered', modelId: `m-${i}`, displayName: `M${i}`, verification: v });
const snap = (offerings: AiOfferingDto[], at: string) => ({
  ...SNAPSHOT,
  connections: [SNAPSHOT.connections[0], { ...GATEWAY_CONNECTION, lastDiscoveredAt: at }],
  offerings,
});
const T0 = '2026-11-21T10:00:00Z';
const T1 = '2026-11-21T10:05:00Z';

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
async function click(testId: string) {
  await act(async () => { fireEvent.click(screen.getByTestId(testId)); });
  await flush();
}
const tick = (ms = JOB_POLL_INTERVAL_MS) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const discovery = () => screen.getByTestId(`ai-connection-discovery-${GW}`).textContent;
const snapshotReads = () => fetchWithAuth.mock.calls.filter((c) => c[0] === '/ai/models').length;

beforeEach(() => {
  fetchWithAuth.mockReset();
  vi.useFakeTimers();
});
afterEach(() => { vi.useRealTimers(); });

describe('drawers announce a queued job', () => {
  it('OfferingDrawer calls onJobQueued after a 202, not after a failed verify', async () => {
    const onJobQueued = vi.fn();
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ queued: true }, 202)).mockResolvedValueOnce(jsonRes({ error: 'nope', code: 'not_found' }, 404));
    render(<OfferingDrawer offering={gwOffering(null)} offerings={[]} onClose={vi.fn()} onSaved={vi.fn()} onJobQueued={onJobQueued} />);
    await click('ai-offering-verify');
    expect(onJobQueued).toHaveBeenCalledTimes(1);
    await click('ai-offering-verify');
    expect(onJobQueued).toHaveBeenCalledTimes(1);
  });

  it('ConnectionDrawer calls onJobQueued after a refresh 202', async () => {
    const onJobQueued = vi.fn();
    fetchWithAuth.mockResolvedValueOnce(jsonRes({ queued: true }, 202));
    render(<ConnectionDrawer connection={GATEWAY_CONNECTION} catalog={[]} catalogEnabled={false} onClose={vi.fn()} onSaved={vi.fn()} onJobQueued={onJobQueued} />);
    await click('ai-connection-refresh');
    expect(onJobQueued).toHaveBeenCalledTimes(1);
  });
});

describe('PartnerAiModelsTab — refetch after async verify/refresh (#12456)', () => {
  it('refresh 202: the card goes from 4 to 7 models without a reload, then polling stops', async () => {
    const four = [0, 1, 2, 3].map((i) => gwOffering(null, i));
    const seven = [0, 1, 2, 3, 4, 5, 6].map((i) => gwOffering(null, i));
    fetchWithAuth
      .mockResolvedValueOnce(jsonRes(snap(four, T0)))        // initial load
      .mockResolvedValueOnce(jsonRes({ queued: true }, 202)) // POST refresh
      .mockResolvedValueOnce(jsonRes(snap(four, T0)))        // poll 1: job still running
      .mockResolvedValue(jsonRes(snap(seven, T1)));          // poll 2+: landed
    render(<PartnerAiModelsTab />);
    await tick(0);
    expect(discovery()).toMatch(/Found 4 models/);

    await act(async () => { fireEvent.click(screen.getByTestId(`ai-connection-edit-${GW}`)); });
    await click('ai-connection-refresh');
    await tick();
    expect(discovery()).toMatch(/Found 4 models/);
    await tick();
    expect(discovery()).toMatch(/Found 7 models/);

    const reads = snapshotReads();
    await tick(JOB_POLL_INTERVAL_MS * 5);
    expect(snapshotReads()).toBe(reads);
  });

  it('verify 202: the open drawer updates from pending to passed', async () => {
    fetchWithAuth
      .mockResolvedValueOnce(jsonRes(snap([gwOffering(verification('absent'))], T0)))
      .mockResolvedValueOnce(jsonRes({ queued: true }, 202))
      .mockResolvedValue(jsonRes(snap([gwOffering(verification('passed'))], T1)));
    render(<PartnerAiModelsTab />);
    await tick(0);
    await act(async () => { fireEvent.click(screen.getByTestId(`ai-offering-edit-${OFF1}`)); });
    expect(screen.getByTestId('ai-offering-drawer').textContent).not.toMatch(/4,?321/);
    await click('ai-offering-verify');
    await tick();
    expect(screen.getByTestId('ai-offering-drawer').textContent).toMatch(/4,?321/);
  });

  it('keeps polling after the drawer is closed (the card must not go stale)', async () => {
    fetchWithAuth
      .mockResolvedValueOnce(jsonRes(snap([gwOffering(null)], T0)))
      .mockResolvedValueOnce(jsonRes({ queued: true }, 202))
      .mockResolvedValue(jsonRes(snap([gwOffering(null), gwOffering(null, 1)], T1)));
    render(<PartnerAiModelsTab />);
    await tick(0);
    await act(async () => { fireEvent.click(screen.getByTestId(`ai-connection-edit-${GW}`)); });
    await click('ai-connection-refresh');
    await act(async () => { fireEvent.click(screen.getByTestId('ai-connection-cancel')); });
    expect(screen.queryByTestId('ai-connection-drawer')).toBeNull();
    await tick();
    expect(discovery()).toMatch(/Found 2 models/);
  });

  it('a failed background read keeps the last good snapshot and keeps polling', async () => {
    fetchWithAuth
      .mockResolvedValueOnce(jsonRes(snap([gwOffering(null)], T0)))
      .mockResolvedValueOnce(jsonRes({ queued: true }, 202))
      .mockResolvedValueOnce(jsonRes({ error: 'x' }, 500))
      .mockResolvedValue(jsonRes(snap([gwOffering(null), gwOffering(null, 1)], T1)));
    render(<PartnerAiModelsTab />);
    await tick(0);
    await act(async () => { fireEvent.click(screen.getByTestId(`ai-connection-edit-${GW}`)); });
    await click('ai-connection-refresh');
    await tick();
    expect(screen.queryByTestId('ai-models-load-error')).toBeNull();
    expect(discovery()).toMatch(/Found 1 model/);
    await tick();
    expect(discovery()).toMatch(/Found 2 models/);
  });

  it('gives up after the tick cap when the job never lands', async () => {
    fetchWithAuth
      .mockResolvedValueOnce(jsonRes(snap([gwOffering(null)], T0)))
      .mockResolvedValueOnce(jsonRes({ queued: true }, 202))
      .mockResolvedValue(jsonRes(snap([gwOffering(null)], T0)));
    render(<PartnerAiModelsTab />);
    await tick(0);
    await act(async () => { fireEvent.click(screen.getByTestId(`ai-connection-edit-${GW}`)); });
    await click('ai-connection-refresh');
    await tick(JOB_POLL_INTERVAL_MS * (JOB_POLL_MAX_TICKS + 10));
    expect(snapshotReads()).toBe(1 + JOB_POLL_MAX_TICKS);
  });

  it('does not poll when nothing was queued, and stops on unmount', async () => {
    fetchWithAuth
      .mockResolvedValueOnce(jsonRes(snap([gwOffering(null)], T0)))
      .mockResolvedValueOnce(jsonRes({ queued: true }, 202))
      .mockResolvedValue(jsonRes(snap([gwOffering(null)], T0)));
    const { unmount } = render(<PartnerAiModelsTab />);
    await tick(JOB_POLL_INTERVAL_MS * 3);
    expect(snapshotReads()).toBe(1); // idle: no polling

    await act(async () => { fireEvent.click(screen.getByTestId(`ai-connection-edit-${GW}`)); });
    await click('ai-connection-refresh');
    await tick();
    expect(snapshotReads()).toBe(2);
    unmount();
    await tick(JOB_POLL_INTERVAL_MS * 5);
    expect(snapshotReads()).toBe(2);
  });
});
