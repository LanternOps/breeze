import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/i18n/format', () => ({ formatNumber: (n: number) => String(n) }));

import KpiStrip from './KpiStrip';
import type { DashboardQueryState } from '../../hooks/useDashboardQuery';
import type { AlertsSummary, DeviceStats, PatchCompliance, TicketStats } from './types';

function loaded<T>(data: T): DashboardQueryState<T> {
  return { data, error: null, isLoading: false, isFetching: false, unavailable: false };
}

function unavailable<T>(): DashboardQueryState<T> {
  return { data: null, error: null, isLoading: false, isFetching: false, unavailable: true };
}

function failed<T>(): DashboardQueryState<T> {
  return { data: null, error: new Error('boom'), isLoading: false, isFetching: false, unavailable: false };
}

const deviceStats: DeviceStats = { total: 42, online: 40, offline: 2, byStatus: { online: 40, offline: 2 } };
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
  criticalSummary: { total: 5, patched: 4, pending: 1 },
};

describe('KpiStrip', () => {
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
    expect(screen.getByTestId('dashboard-patch-card')).toHaveTextContent('92%');
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
        devices={loaded({ total: 0, online: 0, offline: 0, byStatus: {} })}
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
