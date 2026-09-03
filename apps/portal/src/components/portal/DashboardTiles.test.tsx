// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DashboardTiles } from './DashboardTiles';
import type { DashboardDto } from '@breeze/shared';

const dashboard: DashboardDto = {
  asOf: '2026-09-02T12:00:00.000Z',
  timezone: 'America/Denver',
  securityScore: {
    status: 'ok',
    score: 82,
    band: 'strong',
    delta30d: 4,
    capturedAt: '2026-09-02T11:00:00.000Z',
  },
  devicesProtected: {
    status: 'ok',
    protected: 8,
    unprotected: 1,
    unknown: 1,
    total: 10,
    asOf: '2026-09-02T12:00:00.000Z',
  },
  patchesApplied: {
    status: 'ok',
    applied: 41,
    devicesWithOutstandingCritical: 2,
    month: '2026-09',
    timezone: 'America/Denver',
    asOf: '2026-09-02T12:00:00.000Z',
  },
  backup: {
    status: 'not_configured',
    completedAt: null,
    verificationType: null,
    configured: 0,
    total: 10,
    asOf: '2026-09-02T12:00:00.000Z',
  },
  support: {
    status: 'ok',
    openTickets: 3,
    averageFirstResponseMinutes: 25,
    sampleSize: 2,
    month: '2026-09',
    timezone: 'America/Denver',
    asOf: '2026-09-02T12:00:00.000Z',
  },
  actionItems: {
    status: 'ok',
    count: 2,
    topIssues: ['Disk encryption'],
    asOf: '2026-09-02T12:00:00.000Z',
  },
  awaitingYou: {
    status: 'ok',
    proposals: 1,
    invoices: 2,
    asOf: '2026-09-02T12:00:00.000Z',
  },
};

describe('DashboardTiles', () => {
  it('renders every tile with stable data-testids', () => {
    render(<DashboardTiles dashboard={dashboard} />);
    expect(screen.getByTestId('portal-dashboard-tile-security').textContent).toContain('82');
    expect(screen.getByTestId('portal-dashboard-tile-devices').textContent).toContain('8');
    expect(screen.getByTestId('portal-dashboard-tile-patches').textContent).toContain('41');
    expect(screen.getByTestId('portal-dashboard-tile-support').textContent).toContain('3');
    expect(screen.getByTestId('portal-dashboard-tile-action-items').textContent).toContain('2');
  });

  it('renders honest not-configured copy', () => {
    render(<DashboardTiles dashboard={dashboard} />);
    expect(screen.getByTestId('portal-dashboard-tile-backup').textContent).toContain(
      'Backups are not configured',
    );
  });
});
