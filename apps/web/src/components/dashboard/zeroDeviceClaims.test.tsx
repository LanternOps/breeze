import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { vi } from 'vitest';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/i18n/format', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/i18n/format')>()),
  formatNumber: (n: number) => String(n),
}));

import AlertsFeed from './AlertsFeed';
import FleetStatusCard from './FleetStatusCard';
import VulnerabilitiesCard from './VulnerabilitiesCard';
import { fleetPresence } from './fleetPresence';
import type { DashboardQueryState } from '../../hooks/useDashboardQuery';
import type { AlertRow, AlertsSummary, DeviceStats, OfflineDevice, VulnerabilityStats } from './types';

function loaded<T>(data: T): DashboardQueryState<T> {
  return { data, error: null, isLoading: false, isFetching: false, unavailable: false, staleScope: false };
}
function loading<T>(): DashboardQueryState<T> {
  return { data: null, error: null, isLoading: true, isFetching: true, unavailable: false, staleScope: false };
}
function failed<T>(): DashboardQueryState<T> {
  return { data: null, error: new Error('boom'), isLoading: false, isFetching: false, unavailable: false, staleScope: false };
}
function unavailable<T>(): DashboardQueryState<T> {
  return { data: null, error: null, isLoading: false, isFetching: false, unavailable: true, staleScope: false };
}

function stats(total: number): DeviceStats {
  return { total, online: total, offline: 0, byStatus: { online: total }, migrationRequiredCount: 0 };
}

const alertsSummary: AlertsSummary = {
  bySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
  byStatus: { active: 0, acknowledged: 0, resolved: 0, suppressed: 0, dismissed: 0 },
  total: 0,
};

const noVulns: VulnerabilityStats = {
  criticalOpen: 0,
  kevCveCount: 0,
  kevDeviceCount: 0,
  patchReadyFindingCount: 0,
  acceptedExpiringSoon: 0,
  totalFindings: 0,
  lastDetectedAt: null,
};

describe('fleetPresence', () => {
  it('classifies each device-count state', () => {
    expect(fleetPresence(loaded(stats(3)))).toBe('present');
    expect(fleetPresence(loaded(stats(0)))).toBe('none');
    expect(fleetPresence(loading<DeviceStats>())).toBe('loading');
    expect(fleetPresence(failed<DeviceStats>())).toBe('unknown');
    expect(fleetPresence(unavailable<DeviceStats>())).toBe('unknown');
  });

  it('prefers a cached count over an in-flight background poll', () => {
    expect(
      fleetPresence({ data: stats(5), error: null, isLoading: false, isFetching: true, unavailable: false, staleScope: false })
    ).toBe('present');
    // A failed background poll keeps the last known count rather than
    // degrading to "unknown".
    expect(
      fleetPresence({ data: stats(5), error: new Error('boom'), isLoading: false, isFetching: false, unavailable: false, staleScope: false })
    ).toBe('present');
  });

  it('suspends the count while it belongs to a previously-selected org scope', () => {
    // Org switch: /devices/stats still holds the OLD org's non-zero count
    // while the card's own query has already resolved for the new org.
    // Reading 'present' here would re-assert the exact false all-clear #3613
    // is about, so the stale count must not be trusted.
    expect(
      fleetPresence({
        data: stats(42),
        error: null,
        isLoading: false,
        isFetching: true,
        unavailable: false,
        staleScope: true,
      })
    ).toBe('loading');
    // Even a failed refetch must not promote old-scope data back to trusted.
    expect(
      fleetPresence({
        data: stats(42),
        error: new Error('boom'),
        isLoading: false,
        isFetching: false,
        unavailable: false,
        staleScope: true,
      })
    ).toBe('loading');
  });
});

function renderFeed(devices: DashboardQueryState<DeviceStats>) {
  return render(
    <AlertsFeed
      alerts={loaded<AlertRow[]>([])}
      summary={loaded(alertsSummary)}
      devices={devices}
      showOrg={false}
      onRetry={() => {}}
    />
  );
}

describe('AlertsFeed empty state (#3613)', () => {
  it('does not claim "all clear" when zero devices are reporting', () => {
    renderFeed(loaded(stats(0)));
    expect(screen.queryByTestId('dashboard-alerts-all-clear')).toBeNull();
    expect(screen.queryByText('dashboard.alerts.allClear')).toBeNull();
    expect(screen.getByTestId('dashboard-alerts-empty-no-devices')).toBeInTheDocument();
    expect(screen.getByText('dashboard.alerts.noDevicesTitle')).toBeInTheDocument();
  });

  it('does not claim "all clear" while the device count is still loading', () => {
    renderFeed(loading<DeviceStats>());
    expect(screen.queryByText('dashboard.alerts.allClear')).toBeNull();
    expect(screen.getByTestId('dashboard-alerts-empty-pending')).toBeInTheDocument();
  });

  it.each([
    ['a failed device request', failed<DeviceStats>()],
    ['a permission-hidden device request', unavailable<DeviceStats>()],
  ])('states only the known fact on %s', (_label, devices) => {
    renderFeed(devices);
    expect(screen.queryByText('dashboard.alerts.allClear')).toBeNull();
    expect(screen.getByTestId('dashboard-alerts-empty-coverage-unknown')).toBeInTheDocument();
    expect(screen.getByText('dashboard.alerts.deviceStatusUnavailable')).toBeInTheDocument();
  });

  it('still claims "all clear" when devices are reporting and no alerts are open', () => {
    renderFeed(loaded(stats(12)));
    expect(screen.getByTestId('dashboard-alerts-all-clear')).toBeInTheDocument();
    expect(screen.getByText('dashboard.alerts.allClear')).toBeInTheDocument();
  });

  it('renders alert rows regardless of the device count', () => {
    render(
      <AlertsFeed
        alerts={loaded<AlertRow[]>([
          {
            id: 'a1',
            title: 'Disk almost full',
            severity: 'critical',
            status: 'active',
            deviceId: 'd1',
            deviceHostname: 'host-1',
            createdAt: '2026-08-17T00:00:00.000Z',
          },
        ])}
        summary={loaded(alertsSummary)}
        devices={failed<DeviceStats>()}
        showOrg={false}
        onRetry={() => {}}
      />
    );
    expect(screen.getByText('Disk almost full')).toBeInTheDocument();
    expect(screen.queryByTestId('dashboard-alerts-empty-coverage-unknown')).toBeNull();
  });
});

function renderVulns(devices: DashboardQueryState<DeviceStats>, vulns = loaded(noVulns)) {
  return render(<VulnerabilitiesCard vulns={vulns} devices={devices} />);
}

describe('VulnerabilitiesCard zero-findings state (#3613)', () => {
  it('does not claim "no open vulnerabilities" when zero devices are reporting', () => {
    renderVulns(loaded(stats(0)));
    expect(screen.queryByText('dashboard.vuln.allClear')).toBeNull();
    expect(screen.getByTestId('dashboard-vuln-no-devices')).toBeInTheDocument();
    expect(screen.getByText('dashboard.vuln.noDevicesHint')).toBeInTheDocument();
  });

  it('does not claim "no open vulnerabilities" while the device count is loading', () => {
    renderVulns(loading<DeviceStats>());
    expect(screen.queryByText('dashboard.vuln.allClear')).toBeNull();
    expect(screen.getByTestId('dashboard-vuln-pending')).toBeInTheDocument();
  });

  it.each([
    ['a failed device request', failed<DeviceStats>()],
    ['a permission-hidden device request', unavailable<DeviceStats>()],
  ])('reports coverage as unconfirmed on %s', (_label, devices) => {
    renderVulns(devices);
    expect(screen.queryByText('dashboard.vuln.allClear')).toBeNull();
    expect(screen.getByTestId('dashboard-vuln-coverage-unknown')).toBeInTheDocument();
    expect(screen.getByText('dashboard.vuln.coverageUnknown')).toBeInTheDocument();
  });

  it('still claims "no open vulnerabilities" when devices are reporting', () => {
    renderVulns(loaded(stats(9)));
    expect(screen.getByTestId('dashboard-vuln-all-clear')).toBeInTheDocument();
    expect(screen.getByText('dashboard.vuln.allClear')).toBeInTheDocument();
  });

  it('renders the findings breakdown regardless of the device count', () => {
    renderVulns(
      failed<DeviceStats>(),
      loaded({ ...noVulns, totalFindings: 4, criticalOpen: 2, kevCveCount: 1, kevDeviceCount: 1 })
    );
    expect(screen.getByText('dashboard.vuln.criticalOpen')).toBeInTheDocument();
    expect(screen.queryByTestId('dashboard-vuln-coverage-unknown')).toBeNull();
  });
});

describe('FleetStatusCard failure visibility', () => {
  function renderFleet(devices: DashboardQueryState<DeviceStats>) {
    return render(<FleetStatusCard devices={devices} offline={loaded<OfflineDevice[]>([])} />);
  }

  it('stays visible with an explicit failure note when the device query fails', () => {
    const { container } = renderFleet(failed<DeviceStats>());
    // Vanishing would read as "nothing to report" — the same false negative.
    expect(container).not.toBeEmptyDOMElement();
    expect(screen.getByTestId('dashboard-fleet-status')).toBeInTheDocument();
    expect(screen.getByText('dashboard.stats.loadFailed')).toBeInTheDocument();
  });

  it('still hides entirely on a deliberate permission-hide or an empty fleet', () => {
    const { container: hidden } = renderFleet(unavailable<DeviceStats>());
    expect(hidden).toBeEmptyDOMElement();
    const { container: empty } = renderFleet(loaded(stats(0)));
    expect(empty).toBeEmptyDOMElement();
  });
});
