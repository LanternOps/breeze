// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { NetworkOverviewDto } from '@breeze/shared';
import { NetworkOverview } from './NetworkOverview';

const okOverview: NetworkOverviewDto = {
  dataStatus: 'ok',
  totalAssets: 42,
  onlineAssets: 30,
  offlineAssets: 5,
  snmpDevicesPolling: 8,
  monitorsDown: 2,
};

const noDataOverview: NetworkOverviewDto = {
  dataStatus: 'no_data',
  totalAssets: null,
  onlineAssets: null,
  offlineAssets: null,
  snmpDevicesPolling: null,
  monitorsDown: null,
};

describe('NetworkOverview', () => {
  it('renders the standing figures when data is available', () => {
    render(<NetworkOverview overview={okOverview} />);

    expect(screen.getByTestId('portal-network-overview')).toBeInTheDocument();
    expect(screen.getByTestId('portal-network-overview-total').textContent).toContain('42');
    expect(screen.getByTestId('portal-network-overview-online').textContent).toContain('30');
    expect(screen.getByTestId('portal-network-overview-offline').textContent).toContain('5');
    expect(screen.getByTestId('portal-network-overview-snmp-polling').textContent).toContain('8');
    expect(screen.getByTestId('portal-network-overview-monitors-down').textContent).toContain('2');
  });

  it('does not imply online + offline sums to the total (unverified assets excluded from both)', () => {
    render(<NetworkOverview overview={okOverview} />);
    // 30 + 5 = 35, not 42 — the copy must not read as though those two rows add up.
    const overview = screen.getByTestId('portal-network-overview');
    expect(overview.textContent).toMatch(/unverified/i);
  });

  it('renders zero visible assets as figures, not the empty state, when only monitors have data (#11686)', () => {
    // After dismissed assets stop counting, an org whose assets are all
    // dismissed can still have a live monitor result: ok with totalAssets 0.
    render(
      <NetworkOverview
        overview={{
          dataStatus: 'ok',
          totalAssets: 0,
          onlineAssets: 0,
          offlineAssets: 0,
          snmpDevicesPolling: 0,
          monitorsDown: 1,
        }}
      />,
    );

    expect(screen.queryByTestId('portal-network-overview-empty')).not.toBeInTheDocument();
    expect(screen.getByTestId('portal-network-overview-total').textContent).toContain('0');
    expect(screen.getByTestId('portal-network-overview-monitors-down').textContent).toContain('1');
  });

  it('shows a discovery empty state, not an error, when there is no data yet', () => {
    render(<NetworkOverview overview={noDataOverview} />);

    expect(screen.queryByTestId('portal-network-overview-total')).not.toBeInTheDocument();
    const empty = screen.getByTestId('portal-network-overview-empty');
    expect(empty.textContent).toMatch(/no network assets have been discovered yet/i);
    expect(empty.textContent).not.toMatch(/error|couldn.t load/i);
  });
});
