import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ProcessDrilldownPanel from './ProcessDrilldownPanel';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...args: any[]) => fetchWithAuth(...args) }));

function jsonResponse(body: any) {
  return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);
}

describe('ProcessDrilldownPanel', () => {
  beforeEach(() => { fetchWithAuth.mockReset(); });

  it('fetches the nearest sample for the clicked time and renders rows sorted by CPU', async () => {
    fetchWithAuth.mockReturnValue(jsonResponse({
      sample: {
        timestamp: '2026-06-13T12:31:40.000Z',
        agentTimestamp: null,
        topProcesses: [
          { name: 'node', pid: 2, cpu: 5, ramMb: 50 },
          { name: 'chrome', pid: 1, cpu: 88, ramMb: 1200 },
        ],
      },
    }));

    render(<ProcessDrilldownPanel deviceId="dev-1" at="2026-06-13T12:32:00.000Z" onClose={() => {}} />);

    await waitFor(() => expect(screen.getByTestId('process-drilldown-row-0')).toBeInTheDocument());
    // default sort = CPU desc → chrome (88) first
    expect(screen.getByTestId('process-drilldown-row-0')).toHaveTextContent('chrome');
    // header shows the actual sample time (not the clicked time), formatted in the
    // runtime's locale/timezone — compute the expected string the same way to stay TZ-independent.
    const expectedTime = new Date('2026-06-13T12:31:40.000Z').toLocaleString();
    expect(screen.getByTestId('process-drilldown-sample-time')).toHaveTextContent(expectedTime);
    expect(fetchWithAuth).toHaveBeenCalledWith(
      expect.stringContaining('/devices/dev-1/process-samples?at=2026-06-13T12%3A32%3A00.000Z')
    );
  });

  it('Live toggle switches to the on-demand processes endpoint', async () => {
    fetchWithAuth.mockReturnValue(jsonResponse({ sample: { timestamp: '2026-06-13T12:31:40.000Z', agentTimestamp: null, topProcesses: [] } }));
    render(<ProcessDrilldownPanel deviceId="dev-1" at="2026-06-13T12:32:00.000Z" onClose={() => {}} />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalled());

    // Real GET /devices/:id/processes shape is { data: [...processes], meta }.
    fetchWithAuth.mockReturnValue(jsonResponse({ data: [{ name: 'live', pid: 9, cpuPercent: 3, memoryMb: 7 }], meta: { total: 1 } }));
    fireEvent.click(screen.getByTestId('process-drilldown-live-toggle'));

    // The on-demand listing is mounted under /system-tools (not /devices) — asserting
    // the full path guards against the 404 the loose '/devices/...' match previously masked.
    await waitFor(() => expect(fetchWithAuth).toHaveBeenLastCalledWith(expect.stringContaining('/system-tools/devices/dev-1/processes')));
    // and the live row actually renders from `data` (regression guard for the array-under-data shape)
    await waitFor(() => expect(screen.getByTestId('process-drilldown-row-0')).toHaveTextContent('live'));
  });
});
