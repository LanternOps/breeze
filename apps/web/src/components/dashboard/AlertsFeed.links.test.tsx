import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const navigateTo = vi.fn();
vi.mock('@/lib/navigation', () => ({
  navigateTo: (...args: unknown[]) => navigateTo(...args),
}));

import AlertsFeed from './AlertsFeed';
import type { DashboardQueryState } from '../../hooks/useDashboardQuery';
import type { AlertRow, AlertsSummary, DeviceStats } from './types';

function loaded<T>(data: T): DashboardQueryState<T> {
  return { data, error: null, isLoading: false, isFetching: false, unavailable: false, staleScope: false };
}

const alertsSummary: AlertsSummary = {
  bySeverity: { critical: 2, high: 13, medium: 0, low: 0, info: 0 },
  byStatus: { active: 15, acknowledged: 0, resolved: 0, suppressed: 0, dismissed: 0 },
  total: 15,
};

const devices: DeviceStats = {
  total: 40,
  online: 25,
  offline: 15,
  byStatus: { online: 25, offline: 15 },
  migrationRequiredCount: 0,
  logShippingFailingCount: 0,
};

const baseRow: AlertRow = {
  id: 'a1',
  title: '{{device}} offline',
  severity: 'high',
  status: 'active',
  deviceId: 'd1',
  deviceHostname: 'DESKTOP-8UG65K6',
  orgId: 'org-1',
  orgName: 'A1 Quality Transmission',
  createdAt: '2026-09-16T00:00:00.000Z',
  triggeredAt: '2026-09-16T00:00:00.000Z',
};

function renderFeed(row: AlertRow) {
  return render(
    <AlertsFeed
      alerts={loaded<AlertRow[]>([row])}
      summary={loaded(alertsSummary)}
      devices={loaded(devices)}
      showOrg
      onRetry={() => {}}
    />,
  );
}

beforeEach(() => {
  navigateTo.mockReset();
});

describe('AlertsFeed row links (ui-flow W03)', () => {
  it('navigates to the device on row click and renders hostname and org as sibling links', () => {
    renderFeed(baseRow);
    fireEvent.click(screen.getByText('DESKTOP-8UG65K6 offline'));
    expect(navigateTo).toHaveBeenCalledWith('/devices/d1');

    const device = screen.getByTestId('device-record-link');
    const org = screen.getByTestId('org-record-link');
    expect(device).toHaveAttribute('href', '/devices/d1');
    expect(org).toHaveAttribute('href', '/organizations/org-1');
    expect(device.parentElement?.closest('a')).toBeNull();
    expect(org.parentElement?.closest('a')).toBeNull();
  });

  it('an org link click goes to the org, not the device', () => {
    renderFeed(baseRow);
    fireEvent.click(screen.getByTestId('org-record-link'));
    expect(navigateTo).toHaveBeenCalledTimes(1);
    expect(navigateTo).toHaveBeenCalledWith('/organizations/org-1');
  });

  it('a row without deviceId is inert', () => {
    renderFeed({ ...baseRow, deviceId: null });
    fireEvent.click(screen.getByText('DESKTOP-8UG65K6 offline'));
    expect(navigateTo).not.toHaveBeenCalled();
    expect(screen.queryByTestId('device-record-link')).toBeNull();
    expect(screen.getByText('DESKTOP-8UG65K6')).toBeInTheDocument();
  });

  it('prints the org as text when the payload has no orgId', () => {
    const { orgId: _omit, ...noOrgId } = baseRow;
    renderFeed(noOrgId);
    expect(screen.queryByTestId('org-record-link')).toBeNull();
    expect(screen.getByText(/A1 Quality Transmission/)).toBeInTheDocument();
  });
});
