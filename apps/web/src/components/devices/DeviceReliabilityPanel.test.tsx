import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DeviceReliabilityPanel from './DeviceReliabilityPanel';
import { fetchWithAuth } from '../../stores/auth';

const showToast = vi.fn();
const useMlFeatureFlagsMock = vi.hoisted(() => vi.fn());

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

vi.mock('../../hooks/useMlFeatureFlags', () => ({
  useMlFeatureFlags: useMlFeatureFlagsMock,
}));

vi.mock('../shared/Toast', () => ({
  showToast: (input: unknown) => showToast(input),
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

describe('DeviceReliabilityPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    showToast.mockReset();
    useMlFeatureFlagsMock.mockReturnValue({
      flags: {},
      loaded: true,
      error: null,
      isDisabled: () => false,
      reload: vi.fn(),
    });
  });

  it('renders reliability score drivers for a device', async () => {
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({
        snapshot: {
          deviceId: 'dev-1',
          reliabilityScore: 44,
          trendDirection: 'degrading',
          trendConfidence: 0.8,
          uptime30d: 94.2,
          crashCount30d: 4,
          hangCount30d: 1,
          serviceFailureCount30d: 0,
          hardwareErrorCount30d: 1,
          mtbfHours: 72,
          topIssues: [{ type: 'crashes', count: 4, severity: 'critical' }],
          drivers: [
            {
              factor: 'crashes',
              label: 'Crashes',
              score: 20,
              weight: 25,
              lostPoints: 20,
              evidence: { crashCount30d: 4 },
            },
          ],
          computedAt: '2026-06-18T12:00:00.000Z',
        },
        history: [],
      }),
    );

    render(<DeviceReliabilityPanel deviceId="dev-1" />);

    await screen.findByText('Reliability');
    expect(screen.getByText('44')).toBeTruthy();
    expect(screen.getByText('At risk')).toBeTruthy();
    expect(screen.getByText('Crashes')).toBeTruthy();
    expect(screen.getByText('crash count30d')).toBeTruthy();
    expect(fetchWithAuthMock).toHaveBeenCalledWith('/reliability/dev-1');
  });

  it('posts false alarm feedback through runAction', async () => {
    fetchWithAuthMock
      .mockResolvedValueOnce(
        makeJsonResponse({
          snapshot: {
            deviceId: 'dev-1',
            reliabilityScore: 65,
            trendDirection: 'stable',
            trendConfidence: 0.4,
            uptime30d: 99.1,
            crashCount30d: 0,
            hangCount30d: 1,
            serviceFailureCount30d: 0,
            hardwareErrorCount30d: 0,
            mtbfHours: null,
            topIssues: [],
            drivers: [],
            computedAt: '2026-06-18T12:00:00.000Z',
          },
          history: [],
        }),
      )
      .mockResolvedValueOnce(makeJsonResponse({ success: true }));

    render(<DeviceReliabilityPanel deviceId="dev-1" />);

    const falseAlarm = await screen.findByRole('button', { name: /false alarm/i });
    fireEvent.click(falseAlarm);

    await waitFor(() => {
      expect(fetchWithAuthMock).toHaveBeenCalledWith(
        '/reliability/dev-1/feedback',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            outcome: 'false_alarm',
            snapshotComputedAt: '2026-06-18T12:00:00.000Z',
          }),
        }),
      );
    });
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'success',
      message: 'False alarm label saved',
    }));
  });

  it('toasts an error when feedback submission fails (non-2xx)', async () => {
    fetchWithAuthMock
      .mockResolvedValueOnce(
        makeJsonResponse({
          snapshot: {
            deviceId: 'dev-1',
            reliabilityScore: 65,
            trendDirection: 'stable',
            trendConfidence: 0.4,
            uptime30d: 99.1,
            crashCount30d: 0,
            hangCount30d: 1,
            serviceFailureCount30d: 0,
            hardwareErrorCount30d: 0,
            mtbfHours: null,
            topIssues: [],
            drivers: [],
            computedAt: '2026-06-18T12:00:00.000Z',
          },
          history: [],
        }),
      )
      .mockResolvedValueOnce(makeJsonResponse({ error: 'boom' }, false, 500));

    render(<DeviceReliabilityPanel deviceId="dev-1" />);

    fireEvent.click(await screen.findByRole('button', { name: /false alarm/i }));

    await waitFor(() => {
      expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
    });
    expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it('renders an error state with a working Retry when the load fails', async () => {
    fetchWithAuthMock
      .mockResolvedValueOnce(makeJsonResponse({ error: 'down' }, false, 500))
      .mockResolvedValueOnce(makeJsonResponse({ error: 'No snapshot' }, false, 404));

    render(<DeviceReliabilityPanel deviceId="dev-1" />);

    expect(await screen.findByText('Failed to load reliability score')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));

    await screen.findByText('No reliability snapshot available yet.');
  });

  it('renders an empty state when no snapshot exists yet', async () => {
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ error: 'No snapshot' }, false, 404));

    render(<DeviceReliabilityPanel deviceId="dev-1" />);

    await screen.findByText('No reliability snapshot available yet.');
  });

  it('shows a disabled state without fetching reliability when the feature flag is off', async () => {
    useMlFeatureFlagsMock.mockReturnValue({
      flags: {
        'ml.device_reliability.enabled': {
          flag: 'ml.device_reliability.enabled',
          enabled: false,
          defaultEnabled: true,
          source: 'org_settings',
        },
      },
      loaded: true,
      error: null,
      isDisabled: (flag: string) => flag === 'ml.device_reliability.enabled',
      reload: vi.fn(),
    });

    render(<DeviceReliabilityPanel deviceId="dev-1" />);

    expect(await screen.findByText('Reliability scoring is disabled for this organization.')).toBeTruthy();
    expect(fetchWithAuthMock).not.toHaveBeenCalledWith('/reliability/dev-1');
    expect(screen.queryByRole('button', { name: /false alarm/i })).toBeNull();
  });
});
