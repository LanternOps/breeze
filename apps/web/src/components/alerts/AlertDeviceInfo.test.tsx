import { render, screen } from '@testing-library/react';
import '../../lib/i18n';
import { describe, it, expect } from 'vitest';

import AlertDeviceInfo from './AlertDeviceInfo';

// #5678 — the device/rule/monitor field block shared by AlertDetails (the
// slide-over) and AlertDetailPage (the full page). Both hosts previously
// re-implemented this block by hand; AlertDetailPage drifted and never
// rendered the monitor_id link added for #5287.
describe('AlertDeviceInfo', () => {
  it('renders the device link', () => {
    render(<AlertDeviceInfo deviceId="d-1" deviceName="web-01" />);

    const link = screen.getByRole('link', { name: /web-01/ });
    expect(link).toHaveAttribute('href', '/devices/d-1');
  });

  it('renders the alert rule name and configuration-policies link when a rule is set', () => {
    render(<AlertDeviceInfo deviceId="d-1" deviceName="web-01" ruleName="High CPU" />);

    expect(screen.getByText('High CPU')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /Managed in Configuration Policies/i });
    expect(link).toHaveAttribute('href', '/configuration-policies');
  });

  it('omits the alert rule row when no rule name is set', () => {
    render(<AlertDeviceInfo deviceId="d-1" deviceName="web-01" />);

    expect(screen.queryByText(/Managed in Configuration Policies/i)).toBeNull();
  });

  it('renders a Monitor row linking to the monitor when monitorId is set', () => {
    render(<AlertDeviceInfo deviceId="d-1" deviceName="web-01" monitorId="monitor-1" />);

    const row = screen.getByTestId('alert-details-monitor');
    const link = row.querySelector('a');
    expect(link).toHaveAttribute('href', '/alerts/monitors/monitor-1');
  });

  it('omits the Monitor row when monitorId is null', () => {
    render(<AlertDeviceInfo deviceId="d-1" deviceName="web-01" monitorId={null} />);

    expect(screen.queryByTestId('alert-details-monitor')).toBeNull();
  });

  it('omits the Monitor row when monitorId is absent entirely', () => {
    render(<AlertDeviceInfo deviceId="d-1" deviceName="web-01" />);

    expect(screen.queryByTestId('alert-details-monitor')).toBeNull();
  });
});
