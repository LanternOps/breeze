import { render, screen } from '@testing-library/react';
import '../../lib/i18n';
import { describe, it, expect, vi } from 'vitest';

// The drawer renders a remediation panel that fetches on mount; stub it so this
// suite stays focused on the Monitor row rendering.
vi.mock('../remediation/RemediationSuggestionsPanel', () => ({
  default: () => null,
}));

import AlertDetails from './AlertDetails';
import type { Alert } from './AlertList';

const baseAlert: Alert = {
  id: 'a-1',
  title: 'CPU high',
  message: 'CPU over 90%',
  severity: 'critical',
  status: 'active',
  deviceId: 'd-1',
  deviceName: 'web-01',
  triggeredAt: '2026-08-24T16:00:00Z',
};

function renderDrawer(alert: Alert) {
  return render(<AlertDetails alert={alert} isOpen onClose={() => {}} />);
}

// #5287 — an alert raised by a rule compiled from a monitor definition links
// back to that monitor.
describe('AlertDetails — monitor-raised alerts (#5287)', () => {
  it('shows a Monitor row linking to the monitor when monitorId is set', () => {
    renderDrawer({ ...baseAlert, monitorId: 'monitor-1' });

    const row = screen.getByTestId('alert-details-monitor');
    const link = row.querySelector('a');
    expect(link).toHaveAttribute('href', '/alerts/monitors/monitor-1');
  });

  it('omits the Monitor row when monitorId is not set', () => {
    renderDrawer({ ...baseAlert, monitorId: null });

    expect(screen.queryByTestId('alert-details-monitor')).toBeNull();
  });

  it('omits the Monitor row when monitorId is absent entirely', () => {
    renderDrawer(baseAlert);

    expect(screen.queryByTestId('alert-details-monitor')).toBeNull();
  });
});
