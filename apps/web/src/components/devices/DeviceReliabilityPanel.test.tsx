import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DeviceReliabilityPanel from './DeviceReliabilityPanel';
import { fetchWithAuth } from '../../stores/auth';

const showToast = vi.fn();
const useMlFeatureFlagsMock = vi.hoisted(() => vi.fn());
const startDeviceTaskMock = vi.hoisted(() => vi.fn());

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

vi.mock('../../stores/aiStore', () => ({
  useAiStore: (selector: (s: { startDeviceTask: unknown }) => unknown) =>
    selector({ startDeviceTask: startDeviceTaskMock }),
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
  const openOutcomeMenu = async () => {
    fireEvent.click(await screen.findByTestId('reliability-outcome-trigger'));
  };

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

    await openOutcomeMenu();
    expect(screen.getByTestId('reliability-outcome-menu')).toBeTruthy();
    fireEvent.click(screen.getByTestId('reliability-outcome-false_alarm'));

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

    // Menu closes after selecting an outcome (close-on-select).
    await waitFor(() => {
      expect(screen.queryByTestId('reliability-outcome-menu')).toBeNull();
    });
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

    await openOutcomeMenu();
    fireEvent.click(screen.getByTestId('reliability-outcome-false_alarm'));

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

  it('Ask AI button starts a device task seeded with the snapshot', async () => {
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({
        snapshot: {
          deviceId: 'dev-1',
          hostname: 'host-1',
          osType: 'windows',
          status: 'online',
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
            { factor: 'crashes', label: 'Crashes', score: 20, weight: 36, lostPoints: 28.8, evidence: { crashCount30d: 4 } },
          ],
          computedAt: '2026-06-18T12:00:00.000Z',
        },
        history: [],
      }),
    );

    render(<DeviceReliabilityPanel deviceId="dev-1" />);

    fireEvent.click(await screen.findByTestId('reliability-ask-ai'));

    expect(startDeviceTaskMock).toHaveBeenCalledTimes(1);
    const [deviceId, ctx, seed] = startDeviceTaskMock.mock.calls[0];
    expect(deviceId).toBe('dev-1');
    expect(ctx).toMatchObject({ type: 'device', id: 'dev-1', hostname: 'host-1', os: 'windows', status: 'online' });
    expect(seed).toContain('44/100');
    expect(seed).toContain('Crashes');
  });

  it('seeds the AI prompt with healthy-device fallbacks (no MTBF, no drivers)', async () => {
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({
        snapshot: {
          deviceId: 'dev-1',
          hostname: 'host-1',
          osType: 'macos',
          status: 'online',
          reliabilityScore: 98,
          trendDirection: 'stable',
          trendConfidence: 0.2,
          uptime30d: 99.9,
          crashCount30d: 0,
          hangCount30d: 0,
          serviceFailureCount30d: 0,
          hardwareErrorCount30d: 0,
          mtbfHours: null,
          topIssues: [],
          drivers: [],
          computedAt: '2026-06-18T12:00:00.000Z',
        },
        history: [],
      }),
    );

    render(<DeviceReliabilityPanel deviceId="dev-1" />);

    fireEvent.click(await screen.findByTestId('reliability-ask-ai'));

    const [, , seed] = startDeviceTaskMock.mock.calls[0];
    expect(seed).toContain('98/100');
    expect(seed).toContain('MTBF unknown');
    expect(seed).toContain('none flagged');
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
    expect(screen.queryByTestId('reliability-outcome-trigger')).toBeNull();
  });

  it('labels factor scores as Health N/100 (not a bare count)', async () => {
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({
        snapshot: {
          deviceId: 'dev-1',
          reliabilityScore: 55,
          trendDirection: 'stable',
          trendConfidence: 0.7,
          uptime30d: 16.8,
          crashCount30d: 0,
          hangCount30d: 4,
          serviceFailureCount30d: 0,
          hardwareErrorCount30d: 0,
          mtbfHours: 7,
          topIssues: [],
          drivers: [
            { factor: 'crashes', label: 'Crashes', score: 100, weight: 25, lostPoints: 0, evidence: { crashCount7d: 0 } },
          ],
          computedAt: '2026-06-23T19:00:00Z',
        },
        history: [],
      }),
    );

    render(<DeviceReliabilityPanel deviceId="dev-1" />);
    expect(await screen.findByText('Health 100/100')).toBeInTheDocument();
  });

  it('shows an At-risk explainer tooltip naming the top drag factor', async () => {
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({
        snapshot: {
          deviceId: 'dev-1',
          reliabilityScore: 55,
          trendDirection: 'stable',
          trendConfidence: 0.7,
          uptime30d: 16.8,
          crashCount30d: 0,
          hangCount30d: 4,
          serviceFailureCount30d: 0,
          hardwareErrorCount30d: 0,
          mtbfHours: 7,
          topIssues: [],
          drivers: [
            { factor: 'uptime', label: 'Uptime', score: 0, weight: 30, lostPoints: 30, evidence: {} },
          ],
          computedAt: '2026-06-23T19:00:00Z',
        },
        history: [],
      }),
    );

    render(<DeviceReliabilityPanel deviceId="dev-1" />);
    const atRiskHelp = await screen.findByTestId('reliability-atrisk-help');
    fireEvent.click(atRiskHelp.querySelector('button')!);
    expect(await screen.findByText(/Biggest drag: Uptime/)).toBeInTheDocument();
  });
});
