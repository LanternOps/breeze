import '@/lib/i18n';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MonitoringTab } from './MonitoringTab';
import { useAssetMonitoring } from './useAssetMonitoring';

vi.mock('./useAssetMonitoring', () => ({ useAssetMonitoring: vi.fn() }));
vi.mock('./MetricHistoryCharts', () => ({ MetricHistoryCharts: () => <div data-testid="network-detail-charts" /> }));
const reload = vi.fn();
const state = { collection: null, snmpDevice: null, templateName: null, checks: [], thresholds: [], loading: false, error: null, reload, checksError: false, thresholdsError: false, templateError: false };

describe('MonitoringTab', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  it('shows loading then error and retries the load', async () => {
    vi.mocked(useAssetMonitoring).mockReturnValue({ ...state, loading: true });
    const { rerender } = render(<MonitoringTab assetId="asset-1" timezone="UTC" onOpenMonitoringSettings={vi.fn()} />);
    expect(screen.getByTestId('network-detail-monitoring-loading')).toHaveAttribute('aria-busy', 'true');
    vi.mocked(useAssetMonitoring).mockReturnValue({ ...state, error: 'Failed to load monitoring' });
    rerender(<MonitoringTab assetId="asset-1" timezone="UTC" onOpenMonitoringSettings={vi.fn()} />);
    expect(screen.queryByTestId('network-detail-monitoring-loading')).toBeNull();
    expect(screen.getByTestId('network-detail-monitoring-error')).toHaveTextContent('Failed to load monitoring');
    await userEvent.click(screen.getByTestId('network-detail-monitoring-retry'));
    expect(reload).toHaveBeenCalledOnce();
  });
  it('wires each failed panel to reload', async () => {
    vi.mocked(useAssetMonitoring).mockReturnValue({ ...state, templateError: true, checksError: true, thresholdsError: true });
    render(<MonitoringTab assetId="asset-1" timezone="UTC" onOpenMonitoringSettings={vi.fn()} />);
    for (const panel of ['template', 'checks', 'thresholds']) {
      expect(screen.getByTestId(`network-detail-${panel}-error`)).toBeInTheDocument();
      await userEvent.click(screen.getByTestId(`network-detail-${panel}-retry`));
    }
    expect(reload).toHaveBeenCalledTimes(3);
  });
});
