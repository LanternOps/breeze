import '@/lib/i18n';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const fetchWithAuth = vi.hoisted(() => vi.fn());
vi.mock('@/stores/auth', () => ({
  fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a),
  registerOrgIdProvider: vi.fn(),
}));

import CisComplianceTab from './CisComplianceTab';

// #9606: the table showed the raw (sometimes FQDN) hostname instead of the
// display name; search matched the hostname only.
const entry = (id: string, device: Record<string, unknown>, score = 70) => ({
  result: {
    id, orgId: 'o', deviceId: `dev-${id}`, baselineId: 'b', checkedAt: '2026-10-01T00:00:00.000Z',
    totalChecks: 10, passedChecks: 7, failedChecks: 3, score, findings: [],
  },
  baseline: { id: 'b', orgId: 'o', name: 'Windows L1', osType: 'windows', level: 'l1' },
  device: { id: `dev-${id}`, osType: 'windows', status: 'online', ...device },
});

function mockRows() {
  fetchWithAuth.mockResolvedValue({
    ok: true, status: 200, statusText: 'OK',
    json: async () => ({
      data: [
        entry('r1', { hostname: 'frontdesk01.corp.example.internal', displayName: 'Front Desk' }),
        entry('r2', { hostname: 'plain-host', displayName: null }, 90),
      ],
    }),
  });
}

describe('CisComplianceTab device naming (#9606)', () => {
  it('shows the display name, falling back to the hostname', async () => {
    mockRows();
    render(<CisComplianceTab refreshKey={0} />);
    expect(await screen.findByText('Front Desk')).toBeInTheDocument();
    expect(screen.getByText('plain-host')).toBeInTheDocument();
    // The FQDN is not the primary label.
    expect(screen.queryByText('frontdesk01.corp.example.internal')).not.toBeInTheDocument();
  });

  it('search matches the display name and the hostname', async () => {
    mockRows();
    render(<CisComplianceTab refreshKey={0} />);
    await screen.findByText('Front Desk');
    const box = screen.getByRole('searchbox');

    fireEvent.change(box, { target: { value: 'front desk' } });
    expect(screen.getByTestId('cis-compliance-row-r1')).toBeInTheDocument();
    expect(screen.queryByTestId('cis-compliance-row-r2')).not.toBeInTheDocument();

    fireEvent.change(box, { target: { value: 'frontdesk01.corp' } });
    expect(screen.getByTestId('cis-compliance-row-r1')).toBeInTheDocument();
    expect(screen.queryByTestId('cis-compliance-row-r2')).not.toBeInTheDocument();
  });
});
