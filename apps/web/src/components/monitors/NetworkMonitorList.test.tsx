import '@/lib/i18n';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchWithAuth } from '../../stores/auth';
import NetworkMonitorList from './NetworkMonitorList';
vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../../stores/orgStore', () => ({ useOrgStore: () => ({ currentOrgId: 'org-1' }) }));
vi.mock('./NetworkCheckConversionBanner', () => ({ default: () => <div data-testid="conversion-banner" /> }));
const json = (data: unknown) => new Response(JSON.stringify(data));
const row = (over = {}) => ({ id: 'nm-1', orgId: 'org-1', assetId: null, name: 'Gateway', monitorType: 'icmp_ping', target: '10.0.0.1', config: {}, pollingInterval: 60, timeout: 5, isActive: true, lastChecked: null, lastStatus: 'unknown', lastResponseMs: null, lastError: null, consecutiveFailures: 0, managedByMonitorId: null, retiredAt: null, createdAt: '', updatedAt: '', ...over });

beforeEach(() => vi.clearAllMocks());
describe('NetworkMonitorList read-only results', () => {
  it('links managed checks to monitors and removes delete and legacy create', async () => {
    vi.mocked(fetchWithAuth).mockImplementation(async () => json({ data: [row({ managedByMonitorId: 'def-1' })] }));
    render(<NetworkMonitorList />);
    expect(await screen.findByTestId('network-check-open-monitor')).toHaveAttribute('href', '/alerts/monitors/def-1');
    expect(screen.queryByTitle(/delete monitor/i)).toBeNull();
    expect(screen.queryByText(/add monitor/i)).toBeNull();
  });
  it('marks unconverted checks and renders the conversion banner', async () => {
    vi.mocked(fetchWithAuth).mockImplementation(async () => json({ data: [row()] }));
    render(<NetworkMonitorList />);
    expect(await screen.findByTestId('network-check-not-converted')).toBeInTheDocument();
    expect(screen.getByTestId('conversion-banner')).toBeInTheDocument();
  });
  it('keeps history mounted while results load and when results are empty', async () => {
    vi.mocked(fetchWithAuth).mockImplementation(async () => json({ data: [] }));
    render(<NetworkMonitorList />);
    expect(screen.getByTestId('conversion-banner')).toBeInTheDocument();
    await screen.findByText(/No network/i);
    expect(screen.getByTestId('conversion-banner')).toBeInTheDocument();
  });
});
