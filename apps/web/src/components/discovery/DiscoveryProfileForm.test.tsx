import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import DiscoveryProfileForm, { type DiscoveryProfileFormValues } from './DiscoveryProfileForm';

const baseProfile: DiscoveryProfileFormValues = {
  name: 'HQ scan',
  siteId: 'site-1',
  subnets: ['192.0.2.0/24'],
  excludeIps: [],
  portRanges: [],
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

  describe('port ranges', () => {
    it('shows the port ranges input only when the TCP port scan method is selected', () => {
      render(<DiscoveryProfileForm initialValues={baseProfile} sites={[]} onSubmit={vi.fn()} />);

      expect(screen.queryByTestId('discovery-port-ranges')).not.toBeInTheDocument();

      fireEvent.click(screen.getByLabelText('TCP Port Scan'));
      expect(screen.getByTestId('discovery-port-ranges')).toBeInTheDocument();
      expect(screen.getByLabelText('Port ranges to scan')).toBeInTheDocument();

      fireEvent.click(screen.getByLabelText('TCP Port Scan'));
      expect(screen.queryByTestId('discovery-port-ranges')).not.toBeInTheDocument();
    });

    it('accepts the syntax the agent parses, including a full 1-65535 sweep', () => {
      const onSubmit = vi.fn();
      render(<DiscoveryProfileForm initialValues={baseProfile} sites={[]} onSubmit={onSubmit} />);
      fireEvent.click(screen.getByLabelText('TCP Port Scan'));

      fireEvent.change(screen.getByTestId('discovery-port-ranges'), {
        target: { value: '22, 80,443, 1000-2000, 1-65535' }
      });
      fireEvent.click(screen.getByRole('button', { name: 'Save Profile' }));

      expect(onSubmit).toHaveBeenCalledTimes(1);
      expect(onSubmit.mock.calls[0][0].portRanges).toEqual([
        '22',
        '80',
        '443',
        '1000-2000',
        '1-65535'
      ]);
    });

    it.each([
      ['0', 'ports must be between 1 and 65535'],
      ['65536', 'ports must be between 1 and 65535'],
      ['80-99999', 'ports must be between 1 and 65535'],
      ['abc', 'not a valid port or port range'],
      ['80-', 'not a valid port or port range'],
      ['1..80', 'not a valid port or port range']
    ])('rejects %s and blocks submission', (value, message) => {
      const onSubmit = vi.fn();
      render(<DiscoveryProfileForm initialValues={baseProfile} sites={[]} onSubmit={onSubmit} />);
      fireEvent.click(screen.getByLabelText('TCP Port Scan'));

      fireEvent.change(screen.getByTestId('discovery-port-ranges'), {
        target: { value }
      });
      fireEvent.click(screen.getByRole('button', { name: 'Save Profile' }));

      expect(onSubmit).not.toHaveBeenCalled();
      const alerts = screen.getAllByRole('alert');
      expect(alerts.some(node => node.textContent?.includes(message))).toBe(true);
      expect(screen.getByTestId('discovery-port-ranges')).toHaveAttribute('aria-invalid', 'true');
    });

    it('describes the input with its helper text and its error region once invalid', () => {
      render(<DiscoveryProfileForm initialValues={baseProfile} sites={[]} onSubmit={vi.fn()} />);
      fireEvent.click(screen.getByLabelText('TCP Port Scan'));

      const input = screen.getByTestId('discovery-port-ranges');
      expect(input).toHaveAttribute('aria-describedby', 'discovery-port-ranges-help');
      expect(document.getElementById('discovery-port-ranges-help')?.textContent).toContain(
        'narrow 11-port default'
      );

      fireEvent.change(input, { target: { value: '99999' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save Profile' }));
      expect(input).toHaveAttribute(
        'aria-describedby',
        'discovery-port-ranges-help discovery-port-ranges-error'
      );
    });

    it('prefills from an existing profile and submits an empty array when cleared', () => {
      const onSubmit = vi.fn();
      render(
        <DiscoveryProfileForm
          initialValues={{ ...baseProfile, methods: ['port_scan'], portRanges: ['22', '1000-2000'] }}
          sites={[]}
          onSubmit={onSubmit}
        />
      );

      const input = screen.getByTestId('discovery-port-ranges');
      expect(input).toHaveValue('22, 1000-2000');

      fireEvent.change(input, { target: { value: '' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save Profile' }));
      expect(onSubmit.mock.calls[0][0].portRanges).toEqual([]);
    });
  });

  describe('exclude IPs', () => {
    it('submits trimmed addresses split on commas and new lines', () => {
      const onSubmit = vi.fn();
      render(<DiscoveryProfileForm initialValues={baseProfile} sites={[]} onSubmit={onSubmit} />);

      fireEvent.change(screen.getByTestId('discovery-exclude-ips'), {
        target: { value: '10.0.0.5, 10.0.0.6\n 10.0.0.7 ' }
      });
      fireEvent.click(screen.getByRole('button', { name: 'Save Profile' }));

      expect(onSubmit).toHaveBeenCalledTimes(1);
      expect(onSubmit.mock.calls[0][0].excludeIps).toEqual(['10.0.0.5', '10.0.0.6', '10.0.0.7']);
    });

    it.each([
      ['10.0.0.0/24', 'CIDR ranges are not supported'],
      ['not-an-ip', 'not a valid IPv4 address'],
      ['10.0.0.999', 'octet value exceeds 255']
    ])('rejects %s and blocks submission', (value, message) => {
      const onSubmit = vi.fn();
      render(<DiscoveryProfileForm initialValues={baseProfile} sites={[]} onSubmit={onSubmit} />);

      fireEvent.change(screen.getByTestId('discovery-exclude-ips'), { target: { value } });
      fireEvent.click(screen.getByRole('button', { name: 'Save Profile' }));

      expect(onSubmit).not.toHaveBeenCalled();
      const alerts = screen.getAllByRole('alert');
      expect(alerts.some(node => node.textContent?.includes(message))).toBe(true);
      expect(screen.getByTestId('discovery-exclude-ips')).toHaveAttribute('aria-invalid', 'true');
    });

    it('is labelled and described by its helper text', () => {
      render(<DiscoveryProfileForm initialValues={baseProfile} sites={[]} onSubmit={vi.fn()} />);

      const field = screen.getByLabelText('Exclude IP addresses');
      expect(field).toHaveAttribute('aria-describedby', 'discovery-exclude-ips-help');
    });

    it('prefills from an existing profile', () => {
      render(
        <DiscoveryProfileForm
          initialValues={{ ...baseProfile, excludeIps: ['10.0.0.5', '10.0.0.6'] }}
          sites={[]}
          onSubmit={vi.fn()}
        />
      );

      expect(screen.getByTestId('discovery-exclude-ips')).toHaveValue('10.0.0.5\n10.0.0.6');
    });
  });

  it('submits the API defaults unchanged when both new fields are left blank', () => {
    const onSubmit = vi.fn();
    render(<DiscoveryProfileForm initialValues={baseProfile} sites={[]} onSubmit={onSubmit} />);

    fireEvent.click(screen.getByRole('button', { name: 'Save Profile' }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0].excludeIps).toEqual([]);
    expect(onSubmit.mock.calls[0][0].portRanges).toEqual([]);
  });
});
import '@/lib/i18n';
