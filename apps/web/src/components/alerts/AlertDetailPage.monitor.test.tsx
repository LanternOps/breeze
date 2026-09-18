import { render, screen } from '@testing-library/react';
import '../../lib/i18n';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// The page renders a remediation panel that fetches on mount; stub it so this
// suite stays focused on the Monitor row rendering.
vi.mock('../remediation/RemediationSuggestionsPanel', () => ({
  default: () => null,
}));

const fetchWithAuth = vi.fn();

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args),
  registerOrgIdProvider: vi.fn(),
}));

import AlertDetailPage from './AlertDetailPage';
import { useOrgStore } from '@/stores/orgStore';

type RawAlert = {
  id: string;
  title: string;
  message: string;
  severity: string;
  status: string;
  deviceId: string;
  deviceName: string;
  triggeredAt: string;
  monitorId?: string | null;
};

const baseAlert: RawAlert = {
  id: 'a-1',
  title: 'CPU high',
  message: 'CPU over 90%',
  severity: 'critical',
  status: 'active',
  deviceId: 'd-1',
  deviceName: 'web-01',
  triggeredAt: '2026-08-24T16:00:00Z',
};

function mockFetch(alert: RawAlert) {
  fetchWithAuth.mockImplementation((url: string) => {
    if (url.endsWith('/tickets')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: [] }),
      });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(alert),
    });
  });
}

function renderPage(alert: RawAlert) {
  mockFetch(alert);
  return render(<AlertDetailPage alertId={alert.id} />);
}

beforeEach(() => {
  fetchWithAuth.mockReset();
  useOrgStore.setState({ serviceManagementMode: 'native' });
});

// #5678 — AlertDetailPage re-implemented the device-info block from
// AlertDetails and never rendered the monitor_id link added for #5287.
describe('AlertDetailPage — monitor-raised alerts (#5678, #5287)', () => {
  it('shows a Monitor row linking to the monitor when monitorId is set', async () => {
    renderPage({ ...baseAlert, monitorId: 'monitor-1' });

    const row = await screen.findByTestId('alert-details-monitor');
    const link = row.querySelector('a');
    expect(link).toHaveAttribute('href', '/alerts/monitors/monitor-1');
  });

  it('omits the Monitor row when monitorId is not set', async () => {
    renderPage({ ...baseAlert, monitorId: null });

    await screen.findByRole('heading', { name: baseAlert.title });
    expect(screen.queryByTestId('alert-details-monitor')).toBeNull();
  });

  it('omits the Monitor row when monitorId is absent entirely', async () => {
    renderPage(baseAlert);

    await screen.findByRole('heading', { name: baseAlert.title });
    expect(screen.queryByTestId('alert-details-monitor')).toBeNull();
  });
});
