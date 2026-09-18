import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import DeviceCard from './DeviceCard';
import type { Device } from './DeviceList';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn()
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload)
  }) as unknown as Response;

const baseDevice: Device = {
  id: 'device-1',
  hostname: 'edge-01',
  os: 'windows',
  osVersion: '11',
  status: 'online',
  cpuPercent: 58,
  ramPercent: 71,
  lastSeen: '2026-02-09T10:00:00.000Z',
  orgId: 'org-1',
  orgName: 'Org One',
  siteId: 'site-1',
  siteName: 'HQ',
  agentVersion: '1.0.0',
  tags: []
};

describe('DeviceCard sparkline history', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders CPU/RAM sparklines from metrics API data', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({
        metrics: [
          { timestamp: '2026-02-09T10:00:00.000Z', cpu: 40, ram: 50 },
          { timestamp: '2026-02-09T10:05:00.000Z', cpu: 45, ram: 55 },
          { timestamp: '2026-02-09T10:10:00.000Z', cpu: 52, ram: 63 }
        ]
      })
    );

    render(<DeviceCard device={baseDevice} />);

    await screen.findByTestId('cpu-sparkline-device-1');
    expect(screen.queryByText('Loading trend...')).toBeNull();
    expect(screen.queryByText('No trend data')).toBeNull();

    await screen.findByTestId('ram-sparkline-device-1');

    expect(fetchWithAuthMock).toHaveBeenCalledWith('/devices/device-1/metrics?range=1h', { signal: expect.any(AbortSignal) });
  });

  it('shows an explicit empty state when no metric history exists', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ metrics: [] }));

    render(<DeviceCard device={baseDevice} />);

    await waitFor(() => {
      expect(screen.getAllByText('No trend data').length).toBe(2);
    });
  });
});

// The sr-only status text previously fell back to a raw Title-Case of the
// enum value ("Decommissioned"), so a screen reader announced a different
// word than every visible "Removed" string on the same card. Assert it goes
// through the same i18n label source as the visible text.
describe('DeviceCard sr-only status text', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ metrics: [] }));
  });

  it('announces "Removed" (not the raw enum) for a decommissioned device', () => {
    render(<DeviceCard device={{ ...baseDevice, status: 'decommissioned' }} />);

    expect(screen.getByText('Removed')).toBeInTheDocument();
    expect(screen.queryByText('Decommissioned')).not.toBeInTheDocument();
  });
});

// #4622 W04: this card had no `deviceClass` handling for 'manual' at all when
// the class was first introduced, so the grid offered the FULL agent kebab
// (Terminal/Run Script/Reboot/Decommission/Permanent Delete) on a manual
// asset's foreign `manual_assets.id` — the same #4014 failure class the
// network arm was already fixed for. Locks in the fix: Edit/Delete only, no
// metrics fetch.
describe('DeviceCard manual asset class (#4622 W04)', () => {
  const manualDevice: Device = {
    ...baseDevice,
    id: 'manual-1',
    hostname: 'spare-laptop',
    deviceClass: 'manual',
    assetType: 'workstation',
    status: 'unknown',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('never fires the agent metrics-history request for a manual row', async () => {
    render(<DeviceCard device={manualDevice} />);
    // Give any accidental effect a tick to fire before asserting its absence.
    await Promise.resolve();
    expect(fetchWithAuthMock).not.toHaveBeenCalled();
  });

  it('offers Edit and Delete, never the agent actions menu, for a manual row', () => {
    const onClick = vi.fn();
    const onAction = vi.fn();
    render(<DeviceCard device={manualDevice} onClick={onClick} onAction={onAction} />);

    expect(screen.getByTestId('device-manual-1-edit-manual')).toBeInTheDocument();
    expect(screen.getByTestId('device-manual-1-delete-manual')).toBeInTheDocument();
    expect(screen.queryByTestId('device-manual-1-actions-menu')).not.toBeInTheDocument();
    expect(screen.queryByTestId('device-manual-1-open-network')).not.toBeInTheDocument();

    screen.getByTestId('device-manual-1-edit-manual').click();
    expect(onClick).toHaveBeenCalledWith(manualDevice);

    screen.getByTestId('device-manual-1-delete-manual').click();
    expect(onAction).toHaveBeenCalledWith('delete-manual', manualDevice);
  });

  it('renders the Unknown status chip, never Offline, and no CPU/RAM reading', () => {
    render(<DeviceCard device={manualDevice} />);
    expect(screen.getByText('Unknown')).toBeInTheDocument();
    expect(screen.queryByText('Offline')).not.toBeInTheDocument();
  });
});

// DevicesPage conditionally mounts cards only in grid mode. Keep requests
// pending so replacing that subtree exposes leaks hidden by immediate mocks.
describe('DeviceCard request lifetime (#6044)', () => {
  const pending: Array<{ signal: AbortSignal | null | undefined }> = [];

  beforeEach(() => {
    vi.useFakeTimers();
    pending.length = 0;
    fetchWithAuthMock.mockReset();
    fetchWithAuthMock.mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      pending.push({ signal: options?.signal });
      options?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
  });

  afterEach(async () => {
    cleanup();
    await act(async () => { await vi.runAllTimersAsync(); });
    vi.useRealTimers();
  });

  it('cancels each old grid batch across list switches and refresh remounts', async () => {
    const devices = [baseDevice, { ...baseDevice, id: 'device-2' }];
    const grid = (generation = 0) => <div key={generation}>{devices.map(device =>
      <DeviceCard key={device.id} device={device} />)}</div>;
    const { rerender, unmount } = render(grid());
    await act(async () => {});
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(2);

    for (let generation = 1; generation <= 3; generation++) {
      rerender(<div data-testid="list-view" />);
      expect(screen.getByTestId('list-view')).toBeInTheDocument();
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
      expect(pending.every(request => request.signal?.aborted)).toBe(true);
      expect(fetchWithAuthMock).toHaveBeenCalledTimes(generation * 2);
      rerender(grid(generation));
      await act(async () => {});
      expect(pending.filter(request => !request.signal?.aborted)).toHaveLength(2);
    }

    // A refresh that preserves the cards must not start another request.
    rerender(grid(3));
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(8);
    // A quick subtree replacement reuses the active batch.
    rerender(grid(4));
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(8);
    expect(pending.filter(request => !request.signal?.aborted)).toHaveLength(2);
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(pending.every(request => request.signal?.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(8);
  });

  it('aborts unused requests after the remount grace period when the device changes', async () => {
    const { rerender } = render(<DeviceCard device={baseDevice} />);
    await act(async () => {});
    rerender(<DeviceCard device={{ ...baseDevice, id: 'device-2' }} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(pending[0].signal?.aborted).toBe(true);
    expect(pending[1].signal?.aborted).toBe(false);
    rerender(<DeviceCard device={{ ...baseDevice, id: 'device-2', deviceClass: 'manual' }} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(pending[1].signal?.aborted).toBe(true);
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(2);
  });

  it('retains a bounded request timeout when supplying a caller signal', async () => {
    render(<DeviceCard device={baseDevice} />);
    await act(async () => {});
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(pending[0].signal?.aborted).toBe(true);
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});


describe('DeviceCard shared metrics requests (#6044)', () => {
  const requests: Array<{ resolve: (response: Response) => void; signal?: AbortSignal | null }> = [];

  beforeEach(() => {
    vi.useFakeTimers();
    requests.length = 0;
    fetchWithAuthMock.mockReset();
    fetchWithAuthMock.mockImplementation((_url, options) => new Promise((resolve, reject) => {
      requests.push({ resolve, signal: options?.signal });
      options?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
  });

  afterEach(async () => {
    cleanup();
    await act(async () => { await vi.runAllTimersAsync(); });
    vi.useRealTimers();
  });

  it('limits 20 cards to six pending requests and drains the queue as responses finish', async () => {
    render(<>{Array.from({ length: 20 }, (_, i) =>
      <DeviceCard key={i} device={{ ...baseDevice, id: `limited-${i}` }} />)}</>);
    await act(async () => {});
    expect(requests).toHaveLength(6);
    for (let completed = 0; completed < 20; completed++) {
      await act(async () => { requests[completed].resolve(makeJsonResponse({ metrics: [{ cpu: 12, ram: 34 }, { cpu: 56, ram: 78 }] })); });
      expect(requests).toHaveLength(Math.min(20, completed + 7));
      expect(screen.getByTestId(`cpu-sparkline-limited-${completed}`)).toBeInTheDocument();
    }
  });

  it('reuses one pending request through a remount storm and clears it on settle', async () => {
    const device = { ...baseDevice, id: 'storm' };
    let view = render(<DeviceCard device={device} />);
    await act(async () => {});
    for (let i = 0; i < 10; i++) {
      view.unmount();
      await act(async () => { await vi.advanceTimersByTimeAsync(50); });
      view = render(<DeviceCard device={device} />);
      await act(async () => {});
    }
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(1);
    expect(requests[0].signal?.aborted).toBe(false);
    await act(async () => { requests[0].resolve(makeJsonResponse({ metrics: [{ cpu: 1, ram: 2 }, { cpu: 3, ram: 4 }] })); });
    expect(screen.getByTestId('cpu-sparkline-storm')).toBeInTheDocument();
    view.unmount();
    render(<DeviceCard device={device} />);
    await act(async () => {});
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(2);
  });

  it('removes unmounted queued cards before a slot opens', async () => {
    const blockers = Array.from({ length: 6 }, (_, i) =>
      <DeviceCard key={i} device={{ ...baseDevice, id: `blocker-${i}` }} />);
    const { rerender } = render(<>{blockers}<DeviceCard device={{ ...baseDevice, id: 'queued' }} /></>);
    await act(async () => {});
    expect(requests).toHaveLength(6);
    rerender(<>{blockers}</>);
    await act(async () => { requests[0].resolve(makeJsonResponse({ metrics: [] })); });
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(6);
  });

  it.each(['fetch', 'body'] as const)('releases the slot and clears deduplication after a %s failure', async failure => {
    if (failure === 'fetch') fetchWithAuthMock.mockRejectedValueOnce(new Error('Network failed'));
    else fetchWithAuthMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.reject(new Error('Invalid JSON')),
    } as Response);
    const failedDevice = { ...baseDevice, id: `failed-${failure}` };
    const failed = render(<DeviceCard device={failedDevice} />);
    render(<>{Array.from({ length: 6 }, (_, i) =>
      <DeviceCard key={i} device={{ ...baseDevice, id: `after-${failure}-${i}` }} />)}</>);
    await act(async () => {});
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(7);
    expect(requests).toHaveLength(6);
    failed.unmount();
    render(<DeviceCard device={failedDevice} />);
    await act(async () => { requests[0].resolve(makeJsonResponse({ metrics: [] })); });
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(8);
    expect(fetchWithAuthMock).toHaveBeenLastCalledWith(`/devices/${failedDevice.id}/metrics?range=1h`, { signal: expect.any(AbortSignal) });
  });

  it('keeps a shared request alive when just one subscriber unmounts', async () => {
    const device = { ...baseDevice, id: 'shared' };
    const first = render(<DeviceCard device={device} />);
    render(<DeviceCard device={device} />);
    await act(async () => {});
    first.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(requests).toHaveLength(1);
    expect(requests[0].signal?.aborted).toBe(false);
    await act(async () => { requests[0].resolve(makeJsonResponse({ metrics: [{ cpu: 1, ram: 2 }, { cpu: 3, ram: 4 }] })); });
    expect(screen.getByTestId('cpu-sparkline-shared')).toBeInTheDocument();
  });
});
