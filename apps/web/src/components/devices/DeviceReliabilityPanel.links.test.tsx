/**
 * Wave F (#9791 F2) — reliability score factors and offenders link to the
 * Event log tab carrying the scoring window (spec §3.7, R2). #10053: the window
 * and the scored events' sources come from the API, per factor.
 */
import '@/lib/i18n';

import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DeviceReliabilityPanel from './DeviceReliabilityPanel';
import { fetchWithAuth } from '../../stores/auth';
import { eventLogFilterFromHash } from '@/lib/deviceEventLogLink';
import { installAstroClientRouterStandIn } from '../../__tests__/astroClientRouterStandIn';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: (selector: (s: { user: { permissions: Array<{ resource: string; action: string }> } }) => unknown) =>
    selector({ user: { permissions: [{ resource: '*', action: '*' }] } }),
}));
vi.mock('../../stores/aiStore', () => ({
  useAiStore: (selector: (s: { startDeviceTask: unknown }) => unknown) =>
    selector({ startDeviceTask: vi.fn() }),
}));
vi.mock('../../hooks/useMlFeatureFlags', () => ({
  useMlFeatureFlags: () => ({ flags: {}, loaded: true, error: null, isDisabled: () => false, reload: vi.fn() }),
}));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

const fetchMock = vi.mocked(fetchWithAuth);

const json = (payload: unknown): Response =>
  ({ ok: true, status: 200, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const COMPUTED_AT = '2026-10-24T12:30:45.000Z';
// The API's per-factor scoring window (#10053). Deliberately not what the old
// client-side reconstruction from computedAt would produce, so a link carrying
// these values proves the panel used the server window.
const WINDOW_FROM = '2026-09-25T06:00:00.000Z';
const WINDOW_TO = '2026-10-24T12:00:00.000Z';

const driver = (factor: string, lostPoints: number, weight = 20, over: Record<string, unknown> = {}) => ({
  factor,
  label: factor,
  score: 100 - lostPoints * 4,
  weight,
  lostPoints,
  evidence: {},
  windowStart: WINDOW_FROM,
  windowEnd: WINDOW_TO,
  ...over,
});

function snapshot(over: Record<string, unknown> = {}) {
  return {
    deviceId: 'dev-1',
    osType: 'windows',
    reliabilityScore: 55,
    trendDirection: 'stable',
    trendConfidence: 0.8,
    uptime30d: 99,
    crashCount30d: 3,
    hangCount30d: 2,
    serviceFailureCount30d: 4,
    hardwareErrorCount30d: 5,
    mtbfHours: 72,
    topIssues: [],
    drivers: [
      driver('serviceFailures', 5),
      driver('hardwareErrors', 4),
      driver('hangs', 3),
      driver('crashes', 2),
      driver('uptime', 0),
    ],
    computedAt: COMPUTED_AT,
    enrolledAt: '2025-01-01T00:00:00.000Z',
    baseline: null,
    ...over,
  };
}

const offendersPayload = {
  deviceId: 'dev-1',
  days: 30,
  offenders: {
    services: [{ key: 'Spooler', label: 'Spooler', count: 4, lastOccurrence: '2026-10-20T10:00:00.000Z' }],
    hardware: [{ key: 'WHEA-Logger', label: 'WHEA-Logger', count: 5, lastOccurrence: '2026-10-20T10:00:00.000Z' }],
    hangs: [{ key: 'Application Hang', label: 'Application Hang', count: 2, lastOccurrence: '2026-10-20T10:00:00.000Z' }],
  },
};

function route(snap: unknown) {
  fetchMock.mockImplementation(async (url: string) => {
    if (url.endsWith('/offenders')) return json(offendersPayload);
    if (url.endsWith('/baselines')) return json({ baselines: [] });
    if (url === '/reliability/dev-1') return json({ snapshot: snap, history: [] });
    throw new Error(`unexpected request: ${url}`);
  });
}

const hashOf = (el: HTMLElement) => (el as HTMLAnchorElement).getAttribute('href')!.replace(/^#/, '');
const filterOf = (el: HTMLElement) => eventLogFilterFromHash(hashOf(el));

beforeEach(() => {
  fetchMock.mockReset();
});

describe('DeviceReliabilityPanel event-log links (#9791 F2)', () => {
  it('Windows serviceFailures links to Service Control Manager + the scoring window', async () => {
    route(snapshot());
    render(<DeviceReliabilityPanel deviceId="dev-1" />);
    const link = await screen.findByTestId('reliability-factor-link-serviceFailures');
    expect(filterOf(link)).toEqual({ sources: ['Service Control Manager'], from: WINDOW_FROM, to: WINDOW_TO });
    expect(link).toHaveTextContent('View in event log');
    // R2: never a count.
    expect(link.textContent).not.toMatch(/\d/);
  });

  it.each(['crashes', 'hangs', 'hardwareErrors'])('%s without scored sources links window-only and says "Open event log"', async (factor) => {
    route(snapshot());
    render(<DeviceReliabilityPanel deviceId="dev-1" />);
    const link = await screen.findByTestId(`reliability-factor-link-${factor}`);
    expect(filterOf(link)).toEqual({ from: WINDOW_FROM, to: WINDOW_TO });
    expect(link).toHaveTextContent('Open event log');
  });

  it('uptime is exempt and a clean factor gets no link', async () => {
    route(snapshot({ drivers: [driver('serviceFailures', 0), driver('uptime', 6), driver('crashes', 2)] }));
    render(<DeviceReliabilityPanel deviceId="dev-1" />);
    await screen.findByTestId('reliability-factor-link-crashes');
    expect(within(screen.getByTestId('reliability-factor-uptime')).queryByRole('link')).toBeNull();
    expect(screen.queryByTestId('reliability-factor-link-uptime')).toBeNull();
    expect(screen.queryByTestId('reliability-factor-link-serviceFailures')).toBeNull();
  });

  it('aria-label starts with the visible text and names the row; title names the filter', async () => {
    route(snapshot());
    render(<DeviceReliabilityPanel deviceId="dev-1" />);
    const scm = await screen.findByTestId('reliability-factor-link-serviceFailures');
    expect(scm.getAttribute('aria-label')).toBe('View in event log: serviceFailures');
    expect(scm.getAttribute('title')).toContain('Service Control Manager');
    const crashes = screen.getByTestId('reliability-factor-link-crashes');
    expect(crashes.getAttribute('aria-label')).toBe('Open event log: crashes');
    expect(crashes.getAttribute('title')).not.toContain('Service Control Manager');
  });

  it.each([
    ['crashes', 'crashCount30d'],
    ['hangs', 'hangCount30d'],
    ['serviceFailures', 'serviceFailureCount30d'],
    ['hardwareErrors', 'hardwareErrorCount30d'],
  ])('unweighted %s links only when its 30d count is non-zero', async (factor, countKey) => {
    route(snapshot({ drivers: [driver(factor, 0, 0)], [countKey]: 2 }));
    const { unmount } = render(<DeviceReliabilityPanel deviceId="dev-1" />);
    expect(await screen.findByTestId(`reliability-factor-link-${factor}`)).toBeInTheDocument();
    unmount();
    route(snapshot({ drivers: [driver(factor, 0, 0)], [countKey]: 0 }));
    render(<DeviceReliabilityPanel deviceId="dev-1" />);
    await screen.findByTestId(`reliability-factor-${factor}`);
    expect(screen.queryByTestId(`reliability-factor-link-${factor}`)).toBeNull();
  });

  it('unknown OS: service offenders are window-only and read "Open event log"', async () => {
    route(snapshot({ osType: undefined }));
    render(<DeviceReliabilityPanel deviceId="dev-1" />);
    fireEvent.click(await screen.findByTestId('reliability-offenders-toggle'));
    const spooler = await screen.findByTestId('reliability-offender-link-Spooler');
    expect(filterOf(spooler)).toEqual({ from: WINDOW_FROM, to: WINDOW_TO });
    expect(spooler).toHaveTextContent('Open event log');
  });

  it('macOS serviceFailures is window-only', async () => {
    route(snapshot({ osType: 'macos' }));
    render(<DeviceReliabilityPanel deviceId="dev-1" />);
    const link = await screen.findByTestId('reliability-factor-link-serviceFailures');
    expect(filterOf(link)).toEqual({ from: WINDOW_FROM, to: WINDOW_TO });
    expect(link).toHaveTextContent('Open event log');
  });

  it.each([
    ['crashes', ['EventLog', 'Microsoft-Windows-Kernel-Power']],
    ['hangs', ['Application Hang']],
    ['hardwareErrors', ['Microsoft-Windows-WHEA-Logger', 'disk']],
  ])('%s links to every source its scored events came from and says "View in event log" (#10053)', async (factor, sources) => {
    route(snapshot({ drivers: [driver(factor as string, 3, 20, { eventLogSources: sources })] }));
    render(<DeviceReliabilityPanel deviceId="dev-1" />);
    const link = await screen.findByTestId(`reliability-factor-link-${factor}`);
    expect(filterOf(link)).toEqual({ sources, from: WINDOW_FROM, to: WINDOW_TO });
    expect(link).toHaveTextContent('View in event log');
    for (const source of sources as string[]) expect(link.getAttribute('title')).toContain(source);
  });

  it('an empty scored-source list links window-only (#10053)', async () => {
    route(snapshot({ drivers: [driver('crashes', 0, 0, { eventLogSources: [] })], crashCount30d: 1 }));
    render(<DeviceReliabilityPanel deviceId="dev-1" />);
    const link = await screen.findByTestId('reliability-factor-link-crashes');
    expect(filterOf(link)).toEqual({ from: WINDOW_FROM, to: WINDOW_TO });
    expect(link).toHaveTextContent('Open event log');
  });

  it('uses each factor\'s own server window, not one reconstructed from computedAt (#10053)', async () => {
    route(snapshot({
      drivers: [
        driver('crashes', 3, 20, { windowStart: '2026-10-10T08:00:00.000Z', windowEnd: '2026-10-24T11:00:00.000Z' }),
        driver('hangs', 2),
      ],
    }));
    render(<DeviceReliabilityPanel deviceId="dev-1" />);
    expect(filterOf(await screen.findByTestId('reliability-factor-link-crashes'))).toEqual({
      from: '2026-10-10T08:00:00.000Z', to: '2026-10-24T11:00:00.000Z',
    });
    expect(filterOf(screen.getByTestId('reliability-factor-link-hangs'))).toEqual({ from: WINDOW_FROM, to: WINDOW_TO });
  });

  it('renders text, not a link, when the factor carries no usable window', async () => {
    route(snapshot({
      drivers: [
        driver('crashes', 3, 20, { windowStart: undefined, windowEnd: undefined }),
        driver('hangs', 2, 20, { windowStart: 'not-a-date' }),
      ],
    }));
    render(<DeviceReliabilityPanel deviceId="dev-1" />);
    await screen.findByTestId('reliability-factor-crashes');
    expect(screen.queryByTestId('reliability-factor-link-crashes')).toBeNull();
    expect(screen.queryByTestId('reliability-factor-link-hangs')).toBeNull();
  });

  it('offender rows take their own factor\'s window (#10053)', async () => {
    route(snapshot({
      drivers: [
        driver('serviceFailures', 5),
        driver('hardwareErrors', 4, 20, { windowStart: '2026-10-01T00:00:00.000Z' }),
        driver('hangs', 3),
      ],
    }));
    render(<DeviceReliabilityPanel deviceId="dev-1" />);
    fireEvent.click(await screen.findByTestId('reliability-offenders-toggle'));
    const whea = await screen.findByTestId('reliability-offender-link-WHEA-Logger');
    expect(filterOf(whea)?.from).toBe('2026-10-01T00:00:00.000Z');
    expect(filterOf(screen.getByTestId('reliability-offender-link-Application Hang'))?.from).toBe(WINDOW_FROM);
  });

  it('an unweighted fault row with evidence still links', async () => {
    route(snapshot({ drivers: [driver('crashes', 0, 0)], crashCount30d: 3 }));
    render(<DeviceReliabilityPanel deviceId="dev-1" />);
    expect(await screen.findByTestId('reliability-factor-link-crashes')).toBeInTheDocument();
  });

  it('offender rows link one-per-offender with the exact source where the log can filter it', async () => {
    route(snapshot());
    render(<DeviceReliabilityPanel deviceId="dev-1" />);
    fireEvent.click(await screen.findByTestId('reliability-offenders-toggle'));

    const whea = await screen.findByTestId('reliability-offender-link-WHEA-Logger');
    expect(filterOf(whea)).toEqual({ sources: ['WHEA-Logger'], from: WINDOW_FROM, to: WINDOW_TO });
    expect(whea).toHaveTextContent('View in event log');

    const hang = screen.getByTestId('reliability-offender-link-Application Hang');
    expect(filterOf(hang)).toEqual({ sources: ['Application Hang'], from: WINDOW_FROM, to: WINDOW_TO });

    // Windows service names are not event-log sources: same href as the SCM
    // factor row, honestly labelled.
    const spooler = screen.getByTestId('reliability-offender-link-Spooler');
    expect(hashOf(spooler)).toBe(hashOf(screen.getByTestId('reliability-factor-link-serviceFailures')));
    expect(spooler).toHaveTextContent('Open event log');
  });

  it('macOS service offenders filter to their own source', async () => {
    route(snapshot({ osType: 'macos' }));
    render(<DeviceReliabilityPanel deviceId="dev-1" />);
    fireEvent.click(await screen.findByTestId('reliability-offenders-toggle'));
    const spooler = await screen.findByTestId('reliability-offender-link-Spooler');
    expect(filterOf(spooler)?.sources).toEqual(['Spooler']);
    expect(spooler).toHaveTextContent('View in event log');
  });
});

describe('DeviceReliabilityPanel event-log links fire hashchange under the Astro router (#4229)', () => {
  it('clicking a factor link writes the hash and the page hears it', async () => {
    const router = installAstroClientRouterStandIn();
    window.location.hash = '';
    try {
      route(snapshot());
      render(<DeviceReliabilityPanel deviceId="dev-1" />);
      const link = await screen.findByTestId('reliability-factor-link-serviceFailures');
      const expected = hashOf(link);
      const changed = new Promise<string>((resolve) => {
        window.addEventListener('hashchange', (e) => {
          if ((e as HashChangeEvent).newURL.endsWith(`#${expected}`)) resolve('ok');
        });
      });
      fireEvent.click(link);
      expect(window.location.hash).toBe(`#${expected}`);
      await expect(changed).resolves.toBe('ok');
    } finally {
      router.uninstall();
    }
  });
});
