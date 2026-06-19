import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DashboardWidgets from './DashboardWidgets';
import { fetchWithAuth } from '../../stores/auth';

// #1629 follow-up: the per-widget fetches swallow their own errors and degrade
// to empty data. A 403, however, is a permission denial — it must surface as the
// access-denied state instead of silently rendering zeroes, and must NOT show a
// "session expired" message or a misleading Retry.
vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));

const fetchMock = vi.mocked(fetchWithAuth);

const resp = (payload: unknown, status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

describe('DashboardWidgets — 403 renders access-denied (not empty data / retry)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders AccessDenied when a widget endpoint returns 403', async () => {
    fetchMock.mockImplementation(async () => resp({ error: 'forbidden' }, 403));

    render(<DashboardWidgets showDeviceStatus showAlertCounts={false} showCompliance={false} showResources={false} />);

    await waitFor(() => expect(screen.getByTestId('access-denied')).toBeInTheDocument());
    expect(screen.getByText('Access denied')).toBeInTheDocument();
    expect(screen.getByText("You don't have permission to view this dashboard data.")).toBeInTheDocument();
    // No misleading retry, no "session expired" copy, and no silently-zeroed widget.
    expect(screen.queryByText('Retry')).not.toBeInTheDocument();
    expect(screen.queryByText(/session expired/i)).not.toBeInTheDocument();
    expect(screen.queryByText('Total Devices')).not.toBeInTheDocument();
  });

  it('renders the widget data on a successful load (no access-denied)', async () => {
    fetchMock.mockImplementation(async (url) => {
      if (String(url).startsWith('/reports/data/device-inventory')) return resp({ total: 7 });
      if (String(url).startsWith('/devices')) {
        return resp({ summary: { online: 5, offline: 1, maintenance: 1 } });
      }
      return resp({});
    });

    render(<DashboardWidgets showDeviceStatus showAlertCounts={false} showCompliance={false} showResources={false} />);

    await waitFor(() => expect(screen.getByText('Total Devices')).toBeInTheDocument());
    expect(screen.queryByTestId('access-denied')).not.toBeInTheDocument();
  });
});
