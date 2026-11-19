// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { NetworkSiteHealthDto, NetworkSiteHealthRowDto } from '@breeze/shared';
import { NetworkSiteHealth } from './NetworkSiteHealth';

const baseRow = (overrides: Partial<NetworkSiteHealthRowDto> = {}): NetworkSiteHealthRowDto => ({
  siteId: 'site-a',
  siteName: 'Main Office',
  totalAssets: 12,
  onlineAssets: 8,
  offlineAssets: 2,
  unverifiedAssets: 2,
  snmpDevicesPolling: 3,
  monitorsDown: 1,
  ...overrides,
});

const okWithoutAlerts: NetworkSiteHealthDto = {
  dataStatus: 'ok',
  data: [baseRow(), baseRow({ siteId: 'site-b', siteName: 'Warehouse', totalAssets: 4, onlineAssets: 4, offlineAssets: 0, unverifiedAssets: 0, snmpDevicesPolling: 0, monitorsDown: 0 })],
};

const okWithAlerts: NetworkSiteHealthDto = {
  dataStatus: 'ok',
  data: [
    baseRow({ activeAlertCount: 3, highestAlertSeverity: 'critical' }),
    baseRow({ siteId: 'site-b', siteName: 'Warehouse', activeAlertCount: 0, highestAlertSeverity: null }),
    baseRow({ siteId: 'site-c', siteName: 'Annex', activeAlertCount: 1, highestAlertSeverity: 'info' }),
  ],
};

describe('NetworkSiteHealth', () => {
  it('renders one ledger row per site with its counts', () => {
    render(<NetworkSiteHealth health={okWithoutAlerts} />);

    expect(screen.getByTestId('portal-network-site-health')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Sites' })).toBeInTheDocument();

    const rows = screen.getAllByTestId('portal-network-site-health-row');
    expect(rows).toHaveLength(2);
    const first = within(rows[0]);
    expect(first.getByText('Main Office')).toBeInTheDocument();
    // Cell text carries the mobile label first, then the figure.
    const cells = Array.from(rows[0].querySelectorAll('td')).map((td) => td.textContent);
    expect(cells).toEqual(['Main Office', 'Assets12', 'Online8', 'Offline2', 'Unverified2', 'SNMP polling3', 'Monitors down1']);
  });

  it('omits the alert columns when no row carries alert fields (flag off)', () => {
    render(<NetworkSiteHealth health={okWithoutAlerts} />);

    expect(screen.queryByText('Active alerts')).not.toBeInTheDocument();
    expect(screen.queryByText('Highest severity')).not.toBeInTheDocument();
    for (const row of screen.getAllByTestId('portal-network-site-health-row')) {
      expect(row.querySelectorAll('td')).toHaveLength(7);
    }
  });

  it('shows the alert columns, severity labels and a dash for no alerts when the fields are present', () => {
    render(<NetworkSiteHealth health={okWithAlerts} />);

    // Header cells are in the DOM (hidden below sm by CSS only).
    expect(screen.getByRole('columnheader', { name: 'Active alerts' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Highest severity' })).toBeInTheDocument();

    const rows = screen.getAllByTestId('portal-network-site-health-row');
    const tail = (row: HTMLElement) => Array.from(row.querySelectorAll('td')).slice(-2).map((td) => td.textContent);
    expect(tail(rows[0])).toEqual(['Active alerts3', 'Highest severityCritical']);
    // activeAlertCount 0 is a real zero; severity is null so a dash, not a label.
    expect(tail(rows[1])).toEqual(['Active alerts0', 'Highest severity—']);
    expect(tail(rows[2])).toEqual(['Active alerts1', 'Highest severityInfo']);
  });

  it.each([
    ['critical', 'Critical'],
    ['high', 'High'],
    ['medium', 'Medium'],
    ['low', 'Low'],
    ['info', 'Info'],
  ] as const)('labels %s severity as %s', (severity, label) => {
    render(
      <NetworkSiteHealth
        health={{ dataStatus: 'ok', data: [baseRow({ activeAlertCount: 1, highestAlertSeverity: severity })] }}
      />,
    );
    const cells = screen.getByTestId('portal-network-site-health-row').querySelectorAll('td');
    expect(cells[cells.length - 1].textContent).toBe(`Highest severity${label}`);
  });

  it('never fills a missing alert count with zero when only some rows carry it', () => {
    render(
      <NetworkSiteHealth
        health={{ dataStatus: 'ok', data: [baseRow({ activeAlertCount: 2, highestAlertSeverity: 'high' }), baseRow({ siteId: 'site-b', siteName: 'Warehouse' })] }}
      />,
    );
    const rows = screen.getAllByTestId('portal-network-site-health-row');
    const tail = Array.from(rows[1].querySelectorAll('td')).slice(-2).map((td) => td.textContent);
    expect(tail).toEqual(['Active alerts—', 'Highest severity—']);
  });

  it('renders nothing for no_data and not_enabled', () => {
    const { container, rerender } = render(<NetworkSiteHealth health={{ dataStatus: 'no_data', data: [] }} />);
    expect(container).toBeEmptyDOMElement();

    rerender(<NetworkSiteHealth health={{ dataStatus: 'not_enabled', data: [] }} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for an ok response with no rows', () => {
    const { container } = render(<NetworkSiteHealth health={{ dataStatus: 'ok', data: [] }} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('links each site name to the #site= hash the asset table reads, with the id escaped', () => {
    render(
      <NetworkSiteHealth
        health={{
          dataStatus: 'ok',
          data: [baseRow({ siteId: '11111111-2222-3333-4444-555555555555' }), baseRow({ siteId: 'a b&c=d', siteName: 'Odd Id' })],
        }}
      />,
    );
    const links = screen.getAllByTestId('portal-network-site-health-link');
    expect(links).toHaveLength(2);
    expect(links[0]).toHaveAttribute('href', '#site=11111111-2222-3333-4444-555555555555');
    expect(links[0].textContent).toBe('Main Office');
    expect(links[1]).toHaveAttribute('href', '#site=a%20b%26c%3Dd');
  });

  it('still shows the alert columns, with real zeros and dashes, when every row has no alerts', () => {
    render(
      <NetworkSiteHealth
        health={{
          dataStatus: 'ok',
          data: [
            baseRow({ activeAlertCount: 0, highestAlertSeverity: null }),
            baseRow({ siteId: 'site-b', siteName: 'Warehouse', activeAlertCount: 0, highestAlertSeverity: null }),
          ],
        }}
      />,
    );

    expect(screen.getByRole('columnheader', { name: 'Active alerts' })).toBeInTheDocument();
    for (const row of screen.getAllByTestId('portal-network-site-health-row')) {
      const tail = Array.from(row.querySelectorAll('td')).slice(-2).map((td) => td.textContent);
      expect(tail).toEqual(['Active alerts0', 'Highest severity—']);
    }
  });

  it('sets no CSS order on any cell, so the DOM order (name first) is the phone order', () => {
    render(<NetworkSiteHealth health={okWithAlerts} />);
    for (const td of Array.from(document.querySelectorAll('[data-testid="portal-network-site-health-row"] td'))) {
      expect(td.className).not.toMatch(/(^|\s)order-/);
    }
  });

  it('carries a footnote that does not claim the figures add up', () => {
    render(<NetworkSiteHealth health={okWithoutAlerts} />);
    const note = screen.getByTestId('portal-network-site-health-footnote').textContent ?? '';
    expect(note).toMatch(/exclude unverified assets/i);
    expect(note).toMatch(/at most/i);
    expect(note).toMatch(/not necessarily/i);
  });
});
