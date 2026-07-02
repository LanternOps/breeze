import { fireEvent, render, screen } from '@testing-library/react';
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
    // Evidence is a human sentence ("4 in 30d"), not a machine key dump.
    expect(screen.getByText(/4 in 30d/)).toBeTruthy();
    // Points earned/available make the score arithmetic checkable: 20 × 25% = 5.
    expect(screen.getByText('5 / 25 pts')).toBeTruthy();
    expect(fetchWithAuthMock).toHaveBeenCalledWith('/reliability/dev-1');
  });

  // Outcome-feedback UI removed: the labels only fed an evaluation endpoint no
  // UI consumes and there is no learning loop yet. The card must not render any
  // outcome affordance.
  it('renders no outcome-feedback affordance', async () => {
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({ snapshot: baseSnapshot(), history: [] }),
    );

    render(<DeviceReliabilityPanel deviceId="dev-1" />);

    await screen.findByText('Reliability');
    expect(screen.queryByTestId('reliability-outcome-trigger')).toBeNull();
    expect(screen.queryByText(/Mark outcome|Was this right/)).toBeNull();
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

  it('shows factor contribution as earned/available points with health in the row title', async () => {
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
    expect(await screen.findByText('25 / 25 pts')).toBeInTheDocument();
    const row = screen.getByTestId('reliability-factor-crashes');
    expect(row.getAttribute('title')).toContain('health 100/100');
    // A perfectly healthy fault factor reads as quiet reassurance, not a count dump.
    expect(screen.getByText('None in 30d')).toBeInTheDocument();
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

  it('At-risk tooltip falls back to the top issue when there are no drivers', async () => {
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({
        snapshot: {
          deviceId: 'dev-1',
          reliabilityScore: 48,
          trendDirection: 'degrading',
          trendConfidence: 0.6,
          uptime30d: 92.0,
          crashCount30d: 5,
          hangCount30d: 0,
          serviceFailureCount30d: 0,
          hardwareErrorCount30d: 0,
          mtbfHours: null,
          topIssues: [{ type: 'crashes', count: 5, severity: 'critical' }],
          drivers: [],
          computedAt: '2026-06-23T19:00:00Z',
        },
        history: [],
      }),
    );

    render(<DeviceReliabilityPanel deviceId="dev-1" />);
    const atRiskHelp = await screen.findByTestId('reliability-atrisk-help');
    fireEvent.click(atRiskHelp.querySelector('button')!);
    expect(await screen.findByText(/Biggest drag: Crashes/)).toBeInTheDocument();
  });

  const baseSnapshot = (overrides: Record<string, unknown> = {}) => ({
    deviceId: 'dev-1',
    reliabilityScore: 30,
    trendDirection: 'degrading',
    trendConfidence: 0.8,
    uptime30d: 94.2,
    crashCount30d: 0,
    hangCount30d: 0,
    serviceFailureCount30d: 0,
    hardwareErrorCount30d: 0,
    mtbfHours: 72,
    topIssues: [],
    drivers: [],
    computedAt: '2026-06-18T12:00:00.000Z',
    ...overrides,
  });

  it('caps alarming counts in the summary tiles (issue #1907)', async () => {
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({
        snapshot: baseSnapshot({
          serviceFailureCount30d: 1228,
          drivers: [
            {
              factor: 'serviceFailures',
              label: 'Service failures',
              score: 0,
              weight: 25,
              lostPoints: 25,
              evidence: { serviceFailure30d: 1228 },
            },
          ],
        }),
        history: [],
      }),
    );

    render(<DeviceReliabilityPanel deviceId="dev-1" />);

    await screen.findByText('Service failures');
    // The raw 1,228 is capped to 999+ in the evidence line.
    expect(screen.getByText(/999\+/)).toBeInTheDocument();
    expect(screen.queryByText(/1,228/)).toBeNull();
  });

  it('keeps the fixed window label on a young device (age context lives in the tooltip)', async () => {
    const enrolledAt = new Date(Date.now() - 13 * 24 * 60 * 60 * 1000).toISOString();
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({ snapshot: baseSnapshot({ enrolledAt }), history: [] }),
    );

    render(<DeviceReliabilityPanel deviceId="dev-1" />);

    const windowLabel = await screen.findByTestId('reliability-uptime-window');
    expect(windowLabel.textContent).toBe('30d uptime');
    expect(screen.queryByText(/since enroll/)).toBeNull();
  });

  it('keeps the full window label when the device is older than the window', async () => {
    const enrolledAt = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({ snapshot: baseSnapshot({ enrolledAt }), history: [] }),
    );

    render(<DeviceReliabilityPanel deviceId="dev-1" />);

    const windowLabel = await screen.findByTestId('reliability-uptime-window');
    expect(windowLabel.textContent).toBe('30d uptime');
  });

  // Workstation profile: uptime is weighted 0, so a perfect uptime% next to a
  // low score reads as a contradiction — the headline slot shows the factor
  // actually costing points instead.
  it('replaces the uptime headline with the biggest drag when uptime weight is 0', async () => {
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({
        snapshot: baseSnapshot({
          serviceFailureCount30d: 24,
          drivers: [
            { factor: 'serviceFailures', label: 'Service failures', score: 0, weight: 21, lostPoints: 21, evidence: {} },
            { factor: 'uptime', label: 'Uptime', score: 100, weight: 0, lostPoints: 0, evidence: { uptime30d: 100 } },
          ],
        }),
        history: [],
      }),
    );

    render(<DeviceReliabilityPanel deviceId="dev-1" />);

    const drag = await screen.findByTestId('reliability-top-drag');
    expect(drag.textContent).toBe('Biggest drag');
    expect(screen.queryByTestId('reliability-uptime-window')).toBeNull();
    // Appears in the headline stat and again in the factor row's evidence.
    expect(screen.getAllByText(/24 in 30d/).length).toBeGreaterThan(0);
  });

  it('keeps the uptime headline on a 0-weight-uptime device when nothing is losing points', async () => {
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({
        snapshot: baseSnapshot({
          reliabilityScore: 100,
          drivers: [
            { factor: 'crashes', label: 'Crashes', score: 100, weight: 36, lostPoints: 0, evidence: {} },
            { factor: 'uptime', label: 'Uptime', score: 100, weight: 0, lostPoints: 0, evidence: { uptime30d: 100 } },
          ],
        }),
        history: [],
      }),
    );

    render(<DeviceReliabilityPanel deviceId="dev-1" />);

    await screen.findByTestId('reliability-uptime-window');
    expect(screen.queryByTestId('reliability-top-drag')).toBeNull();
  });

  it('keeps the uptime headline when uptime carries weight (infra profile)', async () => {
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({
        snapshot: baseSnapshot({
          drivers: [
            { factor: 'uptime', label: 'Uptime', score: 0, weight: 30, lostPoints: 30, evidence: { uptime30d: 42 } },
            { factor: 'crashes', label: 'Crashes', score: 50, weight: 25, lostPoints: 12.5, evidence: {} },
          ],
        }),
        history: [],
      }),
    );

    render(<DeviceReliabilityPanel deviceId="dev-1" />);

    await screen.findByTestId('reliability-uptime-window');
    expect(screen.queryByTestId('reliability-top-drag')).toBeNull();
  });

  // The uptime factor is scored from the 90d window; the evidence line must
  // lead with the scored figure so "0/30 pts" can't sit next to a bare
  // "100.0% in 30d" (the win-build confusion).
  it('shows the scored 90d uptime figure ahead of the 30d context figure', async () => {
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({
        snapshot: baseSnapshot({
          uptime30d: 100,
          drivers: [
            {
              factor: 'uptime',
              label: 'Uptime',
              score: 0,
              weight: 30,
              lostPoints: 30,
              evidence: { uptime90d: 88.6, uptime30d: 100 },
            },
          ],
        }),
        history: [],
      }),
    );

    render(<DeviceReliabilityPanel deviceId="dev-1" />);

    await screen.findByTestId('reliability-uptime-window');
    expect(screen.getByText(/88\.6% in 90d \(scored window\) · 100\.0% in 30d/)).toBeInTheDocument();
  });

  it('keeps the fixed 30d window phrasing on a young device (no since-enroll labels)', async () => {
    const enrolledAt = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({
        snapshot: baseSnapshot({
          enrolledAt,
          serviceFailureCount30d: 24,
          drivers: [
            { factor: 'serviceFailures', label: 'Service failures', score: 0, weight: 21, lostPoints: 21, evidence: {} },
            { factor: 'uptime', label: 'Uptime', score: 100, weight: 0, lostPoints: 0, evidence: { uptime30d: 100 } },
          ],
        }),
        history: [],
      }),
    );

    render(<DeviceReliabilityPanel deviceId="dev-1" />);

    await screen.findByTestId('reliability-top-drag');
    // Appears in the headline stat and again in the factor row's evidence.
    expect(screen.getAllByText(/24 in 30d/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/since enroll/)).toBeNull();
  });

  // The 63-score case from prod: services 0/21 + hardware 26/22 + crashes
  // 100/36 + hangs 100/21 + uptime unweighted. The card must make that
  // arithmetic visible instead of hiding the two healthy factors.
  const workstationDrivers = () => [
    { factor: 'serviceFailures', label: 'Service failures', score: 0, weight: 21, lostPoints: 21, evidence: { serviceFailureCount7d: 11, serviceFailureCount30d: 24, recoveredServiceCount30d: 0 } },
    { factor: 'hardwareErrors', label: 'Hardware errors', score: 26, weight: 22, lostPoints: 16.28, evidence: { hardwareErrorCount7d: 2, hardwareErrorCount30d: 2 } },
    { factor: 'crashes', label: 'Crashes', score: 100, weight: 36, lostPoints: 0, evidence: { crashCount30d: 0 } },
    { factor: 'hangs', label: 'Application hangs', score: 100, weight: 21, lostPoints: 0, evidence: { hangCount30d: 0 } },
    { factor: 'uptime', label: 'Uptime', score: 100, weight: 0, lostPoints: 0, evidence: { uptime30d: 100 } },
  ];

  it('shows all five factors so the score arithmetic is checkable', async () => {
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({
        snapshot: baseSnapshot({
          reliabilityScore: 63,
          serviceFailureCount30d: 24,
          hardwareErrorCount30d: 2,
          drivers: workstationDrivers(),
        }),
        history: [],
      }),
    );

    render(<DeviceReliabilityPanel deviceId="dev-1" />);

    await screen.findByTestId('reliability-factors');
    // Problem rows carry humanized evidence with points lost visible.
    expect(screen.getByText('0 / 21 pts')).toBeInTheDocument();
    expect(screen.getByText(/24 in 30d · 11 in last 7d · 0 recovered/)).toBeInTheDocument();
    // The previously-hidden healthy factors are now visible and quiet.
    expect(screen.getByText('36 / 36 pts')).toBeInTheDocument();
    expect(screen.getByText('21 / 21 pts')).toBeInTheDocument();
    // Unweighted uptime is explained, not shown as a contradictory "100/100".
    const uptimeRow = screen.getByTestId('reliability-factor-uptime');
    expect(uptimeRow.textContent).toContain('Not scored for this device type');
    expect(uptimeRow.textContent).toContain('—');
  });

  it('renders the weight-segmented score bar with one segment per scored factor', async () => {
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({
        snapshot: baseSnapshot({ reliabilityScore: 63, drivers: workstationDrivers() }),
        history: [],
      }),
    );

    render(<DeviceReliabilityPanel deviceId="dev-1" />);

    const bar = await screen.findByTestId('reliability-score-bar-segmented');
    // Four scored factors (uptime's 0-weight segment is omitted).
    expect(bar.children).toHaveLength(4);
    expect(bar.getAttribute('aria-label')).toContain('Service failures 0 of 21 points');
    expect(bar.getAttribute('aria-label')).toContain('Crashes 36 of 36 points');
  });

  it('falls back to the plain score bar when driver weights do not cover the score', async () => {
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({
        snapshot: baseSnapshot({
          drivers: [
            { factor: 'crashes', label: 'Crashes', score: 20, weight: 25, lostPoints: 20, evidence: {} },
          ],
        }),
        history: [],
      }),
    );

    render(<DeviceReliabilityPanel deviceId="dev-1" />);

    await screen.findByText('Reliability');
    expect(screen.queryByTestId('reliability-score-bar-segmented')).toBeNull();
  });

  it('expands the offenders drill-down from a problem row details link', async () => {
    fetchWithAuthMock
      .mockResolvedValueOnce(
        makeJsonResponse({
          snapshot: baseSnapshot({
            reliabilityScore: 63,
            serviceFailureCount30d: 24,
            drivers: workstationDrivers(),
          }),
          history: [],
        }),
      )
      .mockResolvedValueOnce(
        makeJsonResponse({
          deviceId: 'dev-1',
          days: 30,
          offenders: {
            services: [{ key: 'cplspcon', label: 'cplspcon', count: 12, lastOccurrence: '2026-07-01T11:54:59.000Z' }],
            hardware: [],
            hangs: [],
          },
        }),
      );

    render(<DeviceReliabilityPanel deviceId="dev-1" />);

    fireEvent.click(await screen.findByTestId('reliability-factor-details-serviceFailures'));

    expect(await screen.findByText('cplspcon')).toBeInTheDocument();
    expect(fetchWithAuthMock).toHaveBeenCalledWith('/reliability/dev-1/offenders');
    // The link disappears once the drill-down is open (it can only open, not toggle).
    expect(screen.queryByTestId('reliability-factor-details-serviceFailures')).toBeNull();
  });

  it('does not show the offenders drill-down when there are no offending events', async () => {
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({ snapshot: baseSnapshot(), history: [] }),
    );

    render(<DeviceReliabilityPanel deviceId="dev-1" />);

    await screen.findByText('Reliability');
    expect(screen.queryByTestId('reliability-offenders-toggle')).toBeNull();
  });

  it('lazily loads and renders top offenders when the drill-down is expanded (issue #1907)', async () => {
    fetchWithAuthMock
      .mockResolvedValueOnce(
        makeJsonResponse({ snapshot: baseSnapshot({ serviceFailureCount30d: 3 }), history: [] }),
      )
      .mockResolvedValueOnce(
        makeJsonResponse({
          deviceId: 'dev-1',
          days: 30,
          offenders: {
            services: [
              { key: 'Spooler', label: 'Spooler', count: 3, lastOccurrence: '2026-06-17T10:00:00.000Z', detail: '1/3 recovered' },
            ],
            hardware: [],
            hangs: [],
          },
        }),
      );

    render(<DeviceReliabilityPanel deviceId="dev-1" />);

    // Offenders are NOT fetched on mount — only the snapshot request fires.
    await screen.findByText('Reliability');
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(1);

    fireEvent.click(await screen.findByTestId('reliability-offenders-toggle'));

    expect(await screen.findByText('Spooler')).toBeInTheDocument();
    expect(screen.getByText('1/3 recovered')).toBeInTheDocument();
    expect(fetchWithAuthMock).toHaveBeenCalledWith('/reliability/dev-1/offenders');

    // Caching contract: collapsing and re-expanding must NOT refetch.
    fireEvent.click(screen.getByTestId('reliability-offenders-toggle'));
    fireEvent.click(screen.getByTestId('reliability-offenders-toggle'));
    expect(await screen.findByText('Spooler')).toBeInTheDocument();
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(2); // snapshot + one offenders fetch
  });

  it('surfaces an offenders load failure with a working Retry (issue #1907)', async () => {
    fetchWithAuthMock
      .mockResolvedValueOnce(
        makeJsonResponse({ snapshot: baseSnapshot({ serviceFailureCount30d: 3 }), history: [] }),
      )
      .mockResolvedValueOnce(makeJsonResponse({ error: 'boom' }, false, 500))
      .mockResolvedValueOnce(
        makeJsonResponse({
          deviceId: 'dev-1',
          days: 30,
          offenders: {
            services: [{ key: 'Spooler', label: 'Spooler', count: 3, lastOccurrence: '2026-06-17T10:00:00.000Z' }],
            hardware: [],
            hangs: [],
          },
        }),
      );

    render(<DeviceReliabilityPanel deviceId="dev-1" />);

    fireEvent.click(await screen.findByTestId('reliability-offenders-toggle'));

    // Failure is surfaced, not swallowed into a blank panel.
    expect(await screen.findByText('Failed to load reliability detail')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));

    // Retry refetches (the fetched-once guard was reset) and renders the data.
    expect(await screen.findByText('Spooler')).toBeInTheDocument();
  });

  it('treats a 200 with a malformed offenders body as a failure, not a blank panel (issue #1907)', async () => {
    fetchWithAuthMock
      .mockResolvedValueOnce(
        makeJsonResponse({ snapshot: baseSnapshot({ serviceFailureCount30d: 3 }), history: [] }),
      )
      .mockResolvedValueOnce(makeJsonResponse({ deviceId: 'dev-1', days: 30 })); // no `offenders` field

    render(<DeviceReliabilityPanel deviceId="dev-1" />);

    fireEvent.click(await screen.findByTestId('reliability-offenders-toggle'));

    expect(await screen.findByText('Reliability detail response was malformed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('shows the empty state when the drill-down returns no offenders (issue #1907)', async () => {
    fetchWithAuthMock
      .mockResolvedValueOnce(
        makeJsonResponse({ snapshot: baseSnapshot({ serviceFailureCount30d: 3 }), history: [] }),
      )
      .mockResolvedValueOnce(
        makeJsonResponse({ deviceId: 'dev-1', days: 30, offenders: { services: [], hardware: [], hangs: [] } }),
      );

    render(<DeviceReliabilityPanel deviceId="dev-1" />);

    fireEvent.click(await screen.findByTestId('reliability-offenders-toggle'));

    expect(await screen.findByText(/No offending services or components recorded/)).toBeInTheDocument();
  });
});
