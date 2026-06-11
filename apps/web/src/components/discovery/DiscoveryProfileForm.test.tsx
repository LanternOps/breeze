import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import DiscoveryProfileForm, { type DiscoveryProfileFormValues } from './DiscoveryProfileForm';

const baseProfile: DiscoveryProfileFormValues = {
  name: 'HQ scan',
  siteId: 'site-1',
  subnets: ['192.0.2.0/24'],
  methods: ['ping'],
  schedule: {
    cadence: 'daily',
    intervalHours: 1,
    intervalMinutes: 60,
    time: '02:00',
    dayOfWeek: 'Monday',
    dayOfMonth: '1',
    timezone: 'UTC'
  },
  snmp: {
    version: 'v2c',
    community: 'public',
    port: 161,
    timeout: 2000,
    retries: 1,
    username: '',
    authProtocol: 'sha',
    authPassphrase: '',
    privacyProtocol: 'aes',
    privacyPassphrase: ''
  },
  alertSettings: {
    enabled: false,
    alertOnNew: true,
    alertOnDisappeared: true,
    alertOnChanged: true,
    changeRetentionDays: 90
  }
};

describe('DiscoveryProfileForm', () => {
  it('shows SNMP settings only when SNMP probe is selected', () => {
    render(<DiscoveryProfileForm initialValues={baseProfile} sites={[]} onSubmit={vi.fn()} />);

    expect(screen.queryByTestId('discovery-snmp-settings')).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('SNMP Probe'));
    expect(screen.getByTestId('discovery-snmp-settings')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('SNMP Probe'));
    expect(screen.queryByTestId('discovery-snmp-settings')).not.toBeInTheDocument();
  });
});
