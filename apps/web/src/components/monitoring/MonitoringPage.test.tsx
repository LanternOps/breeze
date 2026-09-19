import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import MonitoringPage from './MonitoringPage';

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
    window.history.pushState({}, '', '/monitoring');
  });

  it('derives the initial tab from window.location.hash', () => {
    window.history.pushState({}, '', '/monitoring#checks');

    render(<MonitoringPage />);

    expect(screen.getByText('Checks tab')).toBeInTheDocument();
  });

  it('defaults to the Assets tab when there is no hash', () => {
    window.history.pushState({}, '', '/monitoring');

    render(<MonitoringPage />);

    expect(screen.getByText('Assets tab')).toBeInTheDocument();
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

      fireEvent.click(screen.getByRole('button', { name: 'Network Checks' }));
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
