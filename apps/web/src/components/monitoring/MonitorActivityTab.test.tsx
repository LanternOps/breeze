import '@/lib/i18n';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MonitorActivityTab from './MonitorActivityTab';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

const fetchMock = vi.mocked(fetchWithAuth);
const toastMock = vi.mocked(showToast);
const json = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const ROWS = [
  {
    deviceId: 'd1',
    deviceName: 'HOST-1',
    enabled: true,
    overrides: null,
    sourcePolicyId: 'p1',
    sourceLevel: 'organization',
    lastState: 'breach',
    lastEvaluatedAt: '2026-09-13T10:00:00.000Z',
    currentEpisodeId: 'ep-open-1',
    openSince: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    episodesInWindow: 2,
    windowStartedAt: '2026-09-10T00:00:00.000Z',
    escalatedAt: null,
    escalationAlertId: null,
    responsesPaused: false,
    resetAt: null,
    resetBy: null,
  },
  {
    deviceId: 'd2',
    deviceName: 'HOST-2',
    enabled: true,
    overrides: null,
    sourcePolicyId: 'p1',
    sourceLevel: 'organization',
    lastState: 'breach',
    lastEvaluatedAt: '2026-09-13T10:05:00.000Z',
    currentEpisodeId: 'ep-open-2',
    openSince: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    episodesInWindow: 3,
    windowStartedAt: '2026-09-10T00:00:00.000Z',
    escalatedAt: '2026-09-13T09:00:00.000Z',
    escalationAlertId: 'alert-1',
    responsesPaused: true,
    resetAt: null,
    resetBy: null,
  },
];

const EPISODES = [
  {
    id: 'ep-old',
    deviceId: 'd1',
    deviceName: 'HOST-1',
    orgId: 'org1',
    startedAt: '2026-09-01T00:00:00.000Z',
    endedAt: '2026-09-01T02:00:00.000Z',
    endReason: 'recovered',
    alertId: 'a1',
    responseRunId: null,
    responseOutcome: null,
  },
  {
    id: 'ep-new',
    deviceId: 'd1',
    deviceName: 'HOST-1',
    orgId: 'org1',
    startedAt: '2026-09-12T00:00:00.000Z',
    endedAt: null,
    endReason: null,
    alertId: 'a2',
    responseRunId: 'r1',
    responseOutcome: 'completed',
  },
];

describe('MonitorActivityTab (#5290)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders one row per device with its state and open-episode age', async () => {
    fetchMock.mockImplementation(async (input: string) => {
      if (input.includes('/devices')) return json({ data: ROWS });
      return json({ data: [] });
    });
    render(<MonitorActivityTab monitorId="m1" />);
    await waitFor(() => expect(screen.getByTestId('monitor-activity-row-d1')).toBeInTheDocument());
    expect(screen.getByTestId('monitor-activity-row-d2')).toBeInTheDocument();
    expect(screen.getByTestId('monitor-activity-state-d1')).not.toHaveTextContent('unknown');
    expect(screen.getByTestId('monitor-activity-open-since-d1').textContent).not.toBe('—');
  });

  it('shows an Escalated badge and the pause notice when responses are paused', async () => {
    fetchMock.mockResolvedValue(json({ data: ROWS }));
    render(<MonitorActivityTab monitorId="m1" />);
    await waitFor(() => expect(screen.getByTestId('monitor-activity-row-d2')).toBeInTheDocument());
    expect(screen.getByTestId('monitor-activity-escalated-d2')).toBeInTheDocument();
    expect(screen.getByTestId('monitor-activity-paused-d2')).toBeInTheDocument();
    expect(screen.queryByTestId('monitor-activity-escalated-d1')).toBeNull();
  });

  it("lists the device's episodes newest first when a row is expanded", async () => {
    fetchMock.mockImplementation(async (input: string) => {
      if (input.includes('/episodes')) return json({ data: [...EPISODES].reverse(), nextCursor: null });
      if (input.includes('/devices')) return json({ data: ROWS });
      return json({ data: [] });
    });
    render(<MonitorActivityTab monitorId="m1" />);
    await waitFor(() => expect(screen.getByTestId('monitor-activity-row-d1')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('monitor-activity-expand-d1'));
    await waitFor(() => expect(screen.getByTestId('monitor-activity-episode-ep-new')).toBeInTheDocument());
    const episodeEls = screen.getAllByTestId(/^monitor-activity-episode-/);
    expect(episodeEls.map((el) => el.getAttribute('data-testid'))).toEqual([
      'monitor-activity-episode-ep-new',
      'monitor-activity-episode-ep-old',
    ]);
  });

  it('shows the empty state when the monitor has never evaluated', async () => {
    fetchMock.mockResolvedValue(json({ data: [] }));
    render(<MonitorActivityTab monitorId="m1" />);
    await waitFor(() => expect(screen.getByTestId('monitor-activity-empty')).toBeInTheDocument());
  });

  it('calls POST /monitor-definitions/:id/devices/:deviceId/reset through runAction', async () => {
    fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
      if (init?.method === 'POST' && input.includes('/reset')) return json({ reset: true });
      if (input.includes('/devices')) return json({ data: ROWS });
      return json({ data: [] });
    });
    render(<MonitorActivityTab monitorId="m1" />);
    await waitFor(() => expect(screen.getByTestId('monitor-activity-reset-d2')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('monitor-activity-reset-d2'));
    fireEvent.click(await screen.findByTestId('monitor-activity-reset-confirm'));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/monitor-definitions/m1/devices/d2/reset',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
  });

  it('surfaces a toast and leaves the badge in place when the reset fails', async () => {
    fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
      if (init?.method === 'POST' && input.includes('/reset')) return json({ error: 'boom' }, false, 500);
      if (input.includes('/devices')) return json({ data: ROWS });
      return json({ data: [] });
    });
    render(<MonitorActivityTab monitorId="m1" />);
    await waitFor(() => expect(screen.getByTestId('monitor-activity-reset-d2')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('monitor-activity-reset-d2'));
    fireEvent.click(await screen.findByTestId('monitor-activity-reset-confirm'));

    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    expect(screen.getByTestId('monitor-activity-escalated-d2')).toBeInTheDocument();
  });

  it('refetches and clears the Escalated/paused badges after a successful reset', async () => {
    let devicesCallCount = 0;
    const ROWS_AFTER_RESET = ROWS.map((row) =>
      row.deviceId === 'd2'
        ? { ...row, escalatedAt: null, escalationAlertId: null, responsesPaused: false }
        : row,
    );
    fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
      if (init?.method === 'POST' && input.includes('/reset')) return json({ reset: true });
      if (input.includes('/devices')) {
        devicesCallCount += 1;
        return json({ data: devicesCallCount === 1 ? ROWS : ROWS_AFTER_RESET });
      }
      return json({ data: [] });
    });
    render(<MonitorActivityTab monitorId="m1" />);
    await waitFor(() => expect(screen.getByTestId('monitor-activity-escalated-d2')).toBeInTheDocument());
    expect(screen.getByTestId('monitor-activity-paused-d2')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('monitor-activity-reset-d2'));
    fireEvent.click(await screen.findByTestId('monitor-activity-reset-confirm'));

    await waitFor(() => expect(devicesCallCount).toBe(2));
    await waitFor(() => expect(screen.queryByTestId('monitor-activity-escalated-d2')).toBeNull());
    expect(screen.queryByTestId('monitor-activity-paused-d2')).toBeNull();
  });

  it('hides the reset button when the pair is not escalated', async () => {
    fetchMock.mockResolvedValue(json({ data: ROWS }));
    render(<MonitorActivityTab monitorId="m1" />);
    await waitFor(() => expect(screen.getByTestId('monitor-activity-row-d1')).toBeInTheDocument());
    expect(screen.queryByTestId('monitor-activity-reset-d1')).toBeNull();
  });
});
