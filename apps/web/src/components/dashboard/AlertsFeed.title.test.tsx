import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

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
};

describe('AlertsFeed title placeholders', () => {
  it('shows the device hostname instead of a leftover {{device}} token', () => {
    render(
      <AlertsFeed
        alerts={loaded<AlertRow[]>([
          {
            id: 'a1',
            title: '{{device}} offline',
            severity: 'high',
            status: 'active',
            deviceId: 'd1',
            deviceHostname: 'DESKTOP-8UG65K6',
            orgName: 'A1 Quality Transmission',
            createdAt: '2026-09-16T00:00:00.000Z',
            triggeredAt: '2026-09-16T00:00:00.000Z',
          },
        ])}
        summary={loaded(alertsSummary)}
        devices={loaded(devices)}
        showOrg
        onRetry={() => {}}
      />,
    );

    expect(screen.getByText('DESKTOP-8UG65K6 offline')).toBeInTheDocument();
    expect(screen.queryByText('{{device}} offline')).toBeNull();
  });
});
