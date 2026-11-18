import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DashboardTab from './DashboardTab';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));

const fetchMock = vi.mocked(fetchWithAuth);

const res = (payload: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => payload }) as unknown as Response;

describe('DashboardTab', () => {
  beforeEach(() => fetchMock.mockReset());

  it('shows the no-access state on a 403 (#9697)', async () => {
    fetchMock.mockResolvedValue(res({ error: 'denied' }, 403));
    render(<DashboardTab />);
    expect(await screen.findByText(/You don't have access to this organization/i)).toBeInTheDocument();
    expect(screen.queryByText('Failed to fetch dashboard')).not.toBeInTheDocument();
  });

  it('labels data types PCI / PII / PHI / Credentials, not "Pci" (#9683)', async () => {
    fetchMock.mockResolvedValue(
      res({
        data: {
          totals: { findings: 4, open: 4, criticalOpen: 1, remediated24h: 0, averageOpenAgeHours: 1 },
          byDataType: { pci: 1, pii: 1, phi: 1, credential: 1 },
          byRisk: { high: 4 },
        },
      })
    );
    render(<DashboardTab />);
    for (const label of ['PCI', 'PII', 'PHI', 'Credentials']) {
      expect(await screen.findByText(label)).toBeInTheDocument();
    }
    expect(screen.queryByText('pci')).not.toBeInTheDocument();
  });
});
