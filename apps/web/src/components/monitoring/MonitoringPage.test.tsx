import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import MonitoringPage from './MonitoringPage';

const navigateToMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/navigation', () => ({ navigateTo: navigateToMock }));

vi.mock('./MonitoringAssetsDashboard', () => ({
  default: () => <div>Assets tab</div>
}));

vi.mock('../monitors/NetworkMonitorList', () => ({
  default: () => <div>Checks tab</div>
}));

vi.mock('../snmp/SNMPTemplateList', () => ({
  default: () => <div>Templates list</div>
}));

vi.mock('../snmp/SNMPTemplateEditor', () => ({
  default: () => <div>Templates editor</div>
}));

describe('MonitoringPage', () => {
  beforeEach(() => {
    navigateToMock.mockClear();
    window.history.pushState({}, '', '/monitoring');
  });

  it('renders Assets · Templates · Results and maps the legacy #checks hash to Results', () => {
    window.history.pushState({}, '', '/monitoring#checks');

    render(<MonitoringPage />);

    expect(screen.getByText('Checks tab')).toBeInTheDocument();
    expect(screen.getAllByRole('button').map((button) => button.textContent).filter(
      (label) => ['Assets', 'SNMP Templates', 'Results'].includes(label ?? '')
    )).toEqual(['Assets', 'SNMP Templates', 'Results']);
  });

  it('New check opens the monitor editor with kind network_check', () => {
    window.history.pushState({}, '', '/monitoring#results');
    render(<MonitoringPage />);
    fireEvent.click(screen.getByTestId('monitoring-page-new-check'));
    expect(navigateToMock).toHaveBeenCalledWith('/alerts/monitors/new#kind=network_check');
  });

  it('preserves the initial asset when opening the monitor editor', () => {
    const assetId = '11111111-1111-4111-8111-111111111111';
    window.history.pushState({}, '', '/monitoring?assetId=' + assetId + '#results');
    render(<MonitoringPage />);
    fireEvent.click(screen.getByTestId('monitoring-page-new-check'));
    expect(navigateToMock).toHaveBeenCalledWith('/alerts/monitors/new#kind=network_check&assetId=' + assetId);
  });

  it('defaults to the Assets tab when there is no hash', () => {
    window.history.pushState({}, '', '/monitoring');

    render(<MonitoringPage />);

    expect(screen.getByText('Assets tab')).toBeInTheDocument();
    expect(screen.queryByTestId('monitoring-page-new-check')).toBeNull();
  });

  it('updates the hash and switches tabs when a tab is clicked', () => {
    window.history.pushState({}, '', '/monitoring');

    render(<MonitoringPage />);
    expect(screen.getByText('Assets tab')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'SNMP Templates' }));

    expect(window.location.hash).toBe('#templates');
    expect(screen.getByText('Templates list')).toBeInTheDocument();
  });

  // #5213 W02 — the second "Add network asset" entry point.
  describe('add network asset entry point (#5213)', () => {
    it('shows the button only on the Assets tab', () => {
      window.history.pushState({}, '', '/monitoring');
      render(<MonitoringPage />);

      expect(screen.getByTestId('monitoring-page-add-network-asset')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Results' }));
      expect(screen.queryByTestId('monitoring-page-add-network-asset')).toBeNull();
    });

    it('sets the hash and opens the modal on click', () => {
      window.history.pushState({}, '', '/monitoring');
      render(<MonitoringPage />);

      fireEvent.click(screen.getByTestId('monitoring-page-add-network-asset'));

      expect(window.location.hash).toBe('#add-network-asset');
      // The real AddNetworkAssetModal (not stubbed in this file) is now open.
      expect(screen.getByTestId('asset-label')).toBeInTheDocument();
    });
  });
});
