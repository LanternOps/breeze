// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DashboardTiles, DashboardUnavailable } from './DashboardTiles';
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

const tiles = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('[data-testid^="portal-dashboard-tile-"]'));

afterEach(() => {
  vi.useRealTimers();
});

describe('DashboardTiles', () => {
  it('renders every tile with stable data-testids', () => {
    render(<DashboardTiles dashboard={dashboard} />);
    expect(screen.getByTestId('portal-dashboard-tile-security').textContent).toContain('82');
    expect(screen.getByTestId('portal-dashboard-tile-devices').textContent).toContain('8 of 10');
    expect(screen.getByTestId('portal-dashboard-tile-patches').textContent).toContain('41');
    expect(screen.getByTestId('portal-dashboard-tile-support').textContent).toContain('3');
    expect(screen.getByTestId('portal-dashboard-tile-action-items').textContent).toContain('2');
    expect(screen.getByTestId('portal-dashboard-tile-awaiting-you')).toBeTruthy();
    expect(screen.getByTestId('portal-dashboard-tile-backup')).toBeTruthy();
  });

  it('rules the ledger with hairlines instead of boxing each tile', () => {
    const { container } = render(<DashboardTiles dashboard={dashboard} />);
    const rendered = tiles(container);
    expect(rendered).toHaveLength(7);
    for (const tile of rendered) {
      // `border` (all four sides) plus a radius is the boxed-card default the
      // Guest Ledger refuses; `border-y` / `divide-y` rules are the world.
      expect(tile.className).not.toMatch(/(^|\s)border(\s|$)/);
      expect(tile.className).not.toContain('rounded-lg');
    }
  });

  it('leads with the awaiting-you statement and links the counts', () => {
    const { container } = render(<DashboardTiles dashboard={dashboard} />);
    expect(tiles(container)[0].getAttribute('data-testid')).toBe(
      'portal-dashboard-tile-awaiting-you',
    );

    const awaiting = screen.getByTestId('portal-dashboard-tile-awaiting-you');
    expect(within(awaiting).getByRole('link', { name: '1 proposal' }).getAttribute('href')).toContain(
      '/quotes',
    );
    expect(within(awaiting).getByRole('link', { name: '2 invoices' }).getAttribute('href')).toContain(
      '/invoices',
    );
    expect(awaiting.textContent).toContain('are waiting for you');
  });

  it('says so warmly when nothing is awaiting the customer', () => {
    render(
      <DashboardTiles
        dashboard={{
          ...dashboard,
          awaitingYou: { ...dashboard.awaitingYou, proposals: 0, invoices: 0 },
        }}
      />,
    );
    const awaiting = screen.getByTestId('portal-dashboard-tile-awaiting-you');
    expect(awaiting.textContent).toContain('Nothing is waiting on you.');
    expect(within(awaiting).queryByRole('link')).toBeNull();
  });

  it('sets ledger labels in small caps and numeric values in Literata figures', () => {
    render(<DashboardTiles dashboard={dashboard} />);
    const patches = screen.getByTestId('portal-dashboard-tile-patches');

    const label = patches.querySelector('dt');
    expect(label?.textContent).toBe('Patches applied this month');
    expect(label?.className).toContain('uppercase');
    expect(label?.className).toContain('tracking-[0.08em]');
    expect(label?.className).toContain('text-xs');

    const figure = patches.querySelector('.text-figures');
    expect(figure?.textContent).toBe('41');
    expect(figure?.className).toContain('font-display');
  });

  it('gives the reader one headline sentence summarizing the account', () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-09-03T12:00:00.000Z'));
    render(
      <DashboardTiles
        dashboard={{
          ...dashboard,
          devicesProtected: {
            ...dashboard.devicesProtected,
            protected: 2,
            unprotected: 0,
            unknown: 0,
            total: 2,
          },
          backup: {
            ...dashboard.backup,
            status: 'ok',
            completedAt: '2026-09-02T11:00:00.000Z',
            verificationType: 'automated',
            configured: 2,
          },
        }}
      />,
    );

    expect(
      screen.getByText('All 2 devices protected, backups verified yesterday.'),
    ).toBeTruthy();
  });

  it('admits it is still gathering data rather than inventing a headline', () => {
    render(
      <DashboardTiles
        dashboard={{
          ...dashboard,
          securityScore: { ...dashboard.securityScore, status: 'no_data', score: null, band: null, delta30d: null },
          devicesProtected: {
            ...dashboard.devicesProtected,
            status: 'no_data',
            protected: null,
            unprotected: null,
            unknown: null,
            total: null,
          },
        }}
      />,
    );
    expect(
      screen.getByText("We're still gathering data for this account."),
    ).toBeTruthy();
  });

  it('does not describe an entirely unknown fleet as unprotected', () => {
    render(
      <DashboardTiles
        dashboard={{
          ...dashboard,
          devicesProtected: {
            ...dashboard.devicesProtected,
            protected: 0,
            unprotected: 0,
            unknown: 10,
            total: 10,
          },
        }}
      />,
    );

    const deviceTile = screen.getByTestId('portal-dashboard-tile-devices');
    expect(deviceTile.textContent).toContain('Not yet known for all 10 devices');
    expect(deviceTile.textContent).not.toContain('0 of 10');
  });

  it('never rules a blank line when an ok tile arrives without its figure', () => {
    render(
      <DashboardTiles
        dashboard={{
          ...dashboard,
          support: { ...dashboard.support, status: 'ok', openTickets: null },
        }}
      />,
    );
    const supportTile = screen.getByTestId('portal-dashboard-tile-support');
    expect(supportTile.textContent).toContain('Not yet available');
  });

  it('shows the freshness timestamp in the organization timezone, not the timezone name alone', () => {
    render(<DashboardTiles dashboard={dashboard} />);
    const stamp = screen.getByText(/Current as of/);
    expect(stamp.textContent).toContain('Sep 2, 2026');
    expect(stamp.textContent).toContain('America/Denver');
    expect(stamp.textContent).not.toBe('Current as of America/Denver.');
  });

  it('marks a not-configured tile with a status mark, not a grey sentence', () => {
    render(<DashboardTiles dashboard={dashboard} />);
    const backupTile = screen.getByTestId('portal-dashboard-tile-backup');
    expect(backupTile.textContent).toContain('Not set up');
    expect(backupTile.textContent).not.toContain('Backups are not configured');
    // StatusMark = ink dot beside the small-caps text.
    expect(backupTile.querySelector('.rounded-full')).not.toBeNull();
  });

  it('formats a completed backup in the organization timezone', () => {
    render(
      <DashboardTiles
        dashboard={{
          ...dashboard,
          backup: {
            ...dashboard.backup,
            status: 'ok',
            completedAt: '2026-09-02T11:00:00.000Z',
            verificationType: 'automated',
            configured: 10,
          },
        }}
      />,
    );

    const backupTile = screen.getByTestId('portal-dashboard-tile-backup');
    expect(backupTile.textContent).toContain('Sep 2, 2026, 05:00 AM (America/Denver)');
    expect(backupTile.textContent).not.toContain('2026-09-02T11:00:00.000Z');
  });

  it('renders plain-language status marks for no-data and stale tiles', () => {
    render(
      <DashboardTiles
        dashboard={{
          ...dashboard,
          devicesProtected: {
            ...dashboard.devicesProtected,
            status: 'no_data',
            protected: null,
            unprotected: null,
            unknown: null,
            total: null,
          },
          patchesApplied: {
            ...dashboard.patchesApplied,
            status: 'stale',
            applied: null,
          },
        }}
      />,
    );

    const devicesTile = screen.getByTestId('portal-dashboard-tile-devices');
    expect(devicesTile.textContent).toContain('Not yet available');
    expect(devicesTile.textContent).not.toContain('No device protection data is available');

    const patchesTile = screen.getByTestId('portal-dashboard-tile-patches');
    expect(patchesTile.textContent).toContain('May be out of date');
    expect(patchesTile.textContent).not.toContain('Data may be stale.');
  });
});

describe('DashboardUnavailable', () => {
  it('speaks concierge instead of leaking the server error', () => {
    render(<DashboardUnavailable supportEmail="help@example.com" />);
    const notice = screen.getByRole('alert');
    expect(notice.textContent).toContain(
      "We couldn't load your dashboard just now. Your IT team can help.",
    );
    expect(screen.getByRole('link', { name: 'help@example.com' }).getAttribute('href')).toBe(
      'mailto:help@example.com',
    );
  });

  it('still reads sensibly when no support address is on file', () => {
    render(<DashboardUnavailable />);
    expect(screen.getByRole('alert').textContent).toContain('Your IT team can help.');
    expect(screen.queryByRole('link')).toBeNull();
  });
});
