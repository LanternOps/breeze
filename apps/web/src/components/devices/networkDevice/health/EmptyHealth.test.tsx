import '@/lib/i18n';

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { EmptyHealth } from './EmptyHealth';

const props = {
  assetId: 'a1',
  assetType: 'switch' as const,
  collection: null,
  snmpEnabled: false,
  timezone: 'UTC',
  onSetUpMonitoring: vi.fn(),
  onViewMonitoring: vi.fn(),
};

describe('EmptyHealth (#9646)', () => {
  it('keeps the original copy when nothing at all is monitoring the device', () => {
    render(<EmptyHealth {...props} hasNetworkCheck={false} />);
    expect(screen.getByText('Nothing is being monitored yet')).toBeInTheDocument();
  });

  it('does not claim nothing is monitored when a network check is active', () => {
    render(<EmptyHealth {...props} hasNetworkCheck />);
    expect(screen.queryByText('Nothing is being monitored yet')).not.toBeInTheDocument();
    expect(screen.getByText('No SNMP health data')).toBeInTheDocument();
    expect(screen.getByTestId('network-detail-health-empty')).toHaveTextContent(/network check/i);
  });
});
