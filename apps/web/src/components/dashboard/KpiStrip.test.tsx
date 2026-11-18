import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/i18n/format', () => ({ formatNumber: (n: number) => String(n) }));

const viewerRef = vi.hoisted(() => ({
  current: {
    isPlatformAdmin: false,
    permissions: [{ resource: '*', action: '*' }],
    getScope: () => 'partner',
    toolSourcesEnabled: false,
    aiForOfficeEnabled: false,
    serviceManagementMode: 'native',
  } as unknown as import('../../lib/navVisibility').NavViewer,
}));
vi.mock('../../lib/navVisibility', async (orig) => ({
  ...(await orig<typeof import('../../lib/navVisibility')>()),
  useNavViewer: () => viewerRef.current,
}));

import KpiStrip from './KpiStrip';
import { decodeFilterFromHash } from '../devices/filterUrl';
import { readDeviceClassFromHash } from '../devices/deviceClassFilter';
import type { DashboardQueryState } from '../../hooks/useDashboardQuery';
import type { AlertsSummary, DeviceStats, PatchCompliance, TicketStats } from './types';

function loaded<T>(data: T): DashboardQueryState<T> {
  return { data, error: null, isLoading: false, isFetching: false, unavailable: false, staleScope: false };
}

function unavailable<T>(): DashboardQueryState<T> {
  return { data: null, error: null, isLoading: false, isFetching: false, unavailable: true, staleScope: false };
}

function failed<T>(): DashboardQueryState<T> {
  return { data: null, error: new Error('boom'), isLoading: false, isFetching: false, unavailable: false, staleScope: false };
}

const deviceStats: DeviceStats = {
  total: 42,
  online: 40,
  offline: 2,
  byStatus: { online: 40, offline: 2 },
  migrationRequiredCount: 0,
  logShippingFailingCount: 0,
};
const alertsSummary: AlertsSummary = {
  bySeverity: { critical: 1, high: 2, medium: 4, low: 0, info: 0 },
  byStatus: { active: 7, acknowledged: 0, resolved: 0, suppressed: 0, dismissed: 0 },
  total: 7,
};
const ticketStats: TicketStats = { open: 12, unassigned: 3, mine: 2, breached: 0, atRisk: 1 };
const patchData: PatchCompliance = {
  summary: { total: 100, pending: 8, installed: 90, failed: 2, missing: 0, skipped: 0 },
  compliancePercent: 91.8,
  totalDevices: 42,
  compliantDevices: 38,
  devicePercent: 90,
  failedDevices: 1,
  criticalSummary: { total: 5, patched: 4, pending: 1 },
  importantSummary: { total: 0, patched: 0, pending: 0 },
  unratedSummary: { total: 0, patched: 0, pending: 0 },
};

describe('KpiStrip', () => {
  it('omits alert links and load-failure copy when alert summary is denied', () => {
    render(<KpiStrip devices={loaded(deviceStats)} alerts={unavailable<AlertsSummary>()} tickets={unavailable<TicketStats>()} patch={unavailable<PatchCompliance>()} onRetry={() => {}} />);
    for (const id of ['dashboard-critical-card', 'dashboard-warnings-card']) {
      const tile = screen.getByTestId(id);
      expect(tile).toHaveTextContent('—');
      expect(tile).not.toHaveAttribute('href');
      expect(tile).not.toHaveTextContent('dashboard.stats.loadFailed');
    }
  });
  it('renders all six tiles with accurate values when every source is available', () => {
    render(
      <KpiStrip
        devices={loaded(deviceStats)}
        alerts={loaded(alertsSummary)}
        tickets={loaded(ticketStats)}
        patch={loaded(patchData)}
        onRetry={() => {}}
      />
    );

    expect(screen.getByTestId('dashboard-total-devices-card')).toHaveTextContent('42');
    // online tile: count and percentage
    expect(screen.getByTestId('dashboard-online-card')).toHaveTextContent('40');
    expect(screen.getByTestId('dashboard-online-card')).toHaveTextContent('95%');
    // critical = critical + high, warnings = medium
    expect(screen.getByTestId('dashboard-critical-card')).toHaveTextContent('3');
    expect(screen.getByTestId('dashboard-warnings-card')).toHaveTextContent('4');
    expect(screen.getByTestId('dashboard-tickets-card')).toHaveTextContent('12');
    // The device % (38 of 42), not the 91.8 item %.
    expect(screen.getByTestId('dashboard-patch-card')).toHaveTextContent('90%');
  });

  it('drops the tickets and patch tiles when those endpoints are unavailable', () => {
    render(
      <KpiStrip
        devices={loaded(deviceStats)}
        alerts={loaded(alertsSummary)}
        tickets={unavailable<TicketStats>()}
        patch={unavailable<PatchCompliance>()}
        onRetry={() => {}}
      />
    );

    expect(screen.getByTestId('dashboard-total-devices-card')).toBeInTheDocument();
    expect(screen.queryByTestId('dashboard-tickets-card')).not.toBeInTheDocument();
    expect(screen.queryByTestId('dashboard-patch-card')).not.toBeInTheDocument();
  });

  it('shows "—" instead of fabricating zeros when the alerts summary failed', () => {
    render(
      <KpiStrip
        devices={loaded(deviceStats)}
        alerts={failed<AlertsSummary>()}
        tickets={unavailable<TicketStats>()}
        patch={unavailable<PatchCompliance>()}
        onRetry={() => {}}
      />
    );

    expect(screen.getByTestId('dashboard-critical-card')).toHaveTextContent('—');
    expect(screen.getByTestId('dashboard-critical-card')).not.toHaveTextContent('0');
    expect(screen.getByTestId('dashboard-warnings-card')).toHaveTextContent('—');
  });

  it('degrades the tickets tile on a load failure instead of dropping it', () => {
    render(
      <KpiStrip
        devices={loaded(deviceStats)}
        alerts={loaded(alertsSummary)}
        tickets={failed<TicketStats>()}
        patch={unavailable<PatchCompliance>()}
        onRetry={() => {}}
      />
    );

    expect(screen.getByTestId('dashboard-tickets-card')).toHaveTextContent('—');
    expect(screen.queryByTestId('dashboard-patch-card')).not.toBeInTheDocument();
  });

  it('shows the enrollment empty state for a zero-device fleet', () => {
    render(
      <KpiStrip
        devices={loaded({ total: 0, online: 0, offline: 0, byStatus: {}, migrationRequiredCount: 0, logShippingFailingCount: 0 })}
        alerts={loaded(alertsSummary)}
        tickets={unavailable<TicketStats>()}
        patch={unavailable<PatchCompliance>()}
        onRetry={() => {}}
      />
    );

    expect(screen.getByText('dashboard.emptyDevices.title')).toBeInTheDocument();
    expect(screen.queryByTestId('dashboard-total-devices-card')).not.toBeInTheDocument();
  });
});

describe('KpiStrip devices links (#6721)', () => {
  const hashOf = (href: string | null) => href!.slice(href!.indexOf('#'));
  const renderStrip = () =>
    render(
      <KpiStrip
        devices={loaded(deviceStats)}
        alerts={loaded(alertsSummary)}
        tickets={loaded(ticketStats)}
        patch={loaded(patchData)}
        onRetry={() => {}}
      />
    );

  beforeEach(() => {
    viewerRef.current = {
      isPlatformAdmin: false,
      permissions: [{ resource: '*', action: '*' }],
      getScope: () => 'partner',
      toolSourcesEnabled: false,
      aiForOfficeEnabled: false,
      serviceManagementMode: 'native',
    };
  });

  it('Total devices → /devices#deviceClass=agent', () => {
    renderStrip();
    expect(screen.getByTestId('dashboard-total-devices-card').getAttribute('href')).toBe('/devices#deviceClass=agent');
  });

  it('Online tile decodes to status equals online + agent, with no ?status=', () => {
    renderStrip();
    const href = screen.getByTestId('dashboard-online-card').getAttribute('href');
    expect(href).not.toContain('?status=');
    expect(readDeviceClassFromHash(hashOf(href))).toBe('agent');
    expect(decodeFilterFromHash(hashOf(href))).toEqual({
      operator: 'AND',
      conditions: [{ field: 'status', operator: 'equals', value: 'online' }],
    });
  });

  it('every tile link has a focus-visible ring', () => {
    renderStrip();
    for (const id of ['total-devices', 'online', 'critical', 'warnings', 'tickets', 'patch']) {
      expect(screen.getByTestId(`dashboard-${id}-card`).className).toMatch(/focus-visible:ring/);
    }
  });

  it('a viewer without devices:read gets plain tiles (R4)', () => {
    viewerRef.current = { ...viewerRef.current, permissions: [{ resource: 'alerts', action: 'read' }] };
    renderStrip();
    expect(screen.getByTestId('dashboard-online-card').tagName).not.toBe('A');
    expect(screen.getByTestId('dashboard-online-card')).toHaveTextContent('40');
  });

  // #9791 C (Decision 4): the tile is the device percentage, the same figure
  // the /patches headline shows, and links to that list.
  it('Patch compliance → /patches#compliance, showing the device % (not the item %)', () => {
    render(
      <KpiStrip
        devices={loaded(deviceStats)}
        alerts={loaded(alertsSummary)}
        tickets={loaded(ticketStats)}
        patch={loaded({ ...patchData, compliancePercent: 70, devicePercent: 95 })}
        onRetry={() => {}}
      />
    );
    const tile = screen.getByTestId('dashboard-patch-card');
    expect(tile).toHaveTextContent('95%');
    expect(tile).not.toHaveTextContent('70%');
    expect(tile.getAttribute('href')).toBe('/patches#compliance');
  });

  it('an empty fleet shows no percentage on the patch tile', () => {
    render(
      <KpiStrip
        devices={loaded(deviceStats)}
        alerts={loaded(alertsSummary)}
        tickets={loaded(ticketStats)}
        patch={loaded({ ...patchData, compliancePercent: 100, totalDevices: 0, compliantDevices: 0, devicePercent: 0 })}
        onRetry={() => {}}
      />
    );
    const tile = screen.getByTestId('dashboard-patch-card');
    expect(tile).not.toHaveTextContent('%');
    expect(tile).toHaveTextContent('—');
  });
});
