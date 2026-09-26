// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { NetworkAssetRowDto, NetworkAssetsDto } from '@breeze/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NetworkAssetTable } from './NetworkAssetTable';

const { listMock } = vi.hoisted(() => ({ listMock: vi.fn() }));

vi.mock('@/lib/api', () => ({
  portalApi: { getNetworkAssets: listMock },
}));

const row = (over: Partial<NetworkAssetRowDto> = {}): NetworkAssetRowDto => ({
  id: 'a1',
  hostname: 'fileserver',
  label: null,
  ipAddress: '10.0.0.5',
  macAddress: 'AA:BB:CC:DD:EE:FF',
  assetType: 'server',
  onlineState: 'online',
  lastSeenAt: '2026-09-02T18:00:00.000Z',
  firstSeenAt: '2026-08-01T12:00:00.000Z',
  manufacturer: 'Dell',
  model: 'R740',
  siteName: 'HQ',
  ...over,
});

const ok = (data: NetworkAssetRowDto[], total = data.length, page = 1): NetworkAssetsDto => ({
  dataStatus: 'ok',
  data,
  pagination: { page, limit: 50, total },
});

describe('NetworkAssetTable (#6641)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.location.hash = '';
  });

  it('renders a row with every column', () => {
    render(<NetworkAssetTable initial={ok([row()])} timezone="America/Denver" />);
    const r = screen.getByTestId('portal-network-asset-a1');
    expect(r.textContent).toContain('fileserver');
    expect(r.textContent).toContain('10.0.0.5');
    expect(r.textContent).toContain('AA:BB:CC:DD:EE:FF');
    expect(r.textContent).toContain('Server');
    expect(r.textContent).toContain('Online');
    expect(r.textContent).toContain('Dell R740');
    expect(r.textContent).toContain('HQ');
    // Sep 2 18:00Z is 12:00 in Denver — the org zone, not the runtime's.
    expect(r.textContent).toContain('12:00');
    expect(r.textContent).toContain('MDT');
  });

  it('renders an unverified (null) state as Unknown, never Offline', () => {
    render(<NetworkAssetTable initial={ok([row({ onlineState: null })])} timezone="UTC" />);
    const status = screen.getByTestId('portal-network-asset-status-a1');
    expect(status.textContent).toBe('Unknown');
    expect(status.textContent).not.toMatch(/offline/i);
  });

  it('falls back to the label, then a dash, when hostname is null', () => {
    render(
      <NetworkAssetTable
        initial={ok([
          row({ id: 'a1', hostname: null, label: 'Front printer' }),
          row({ id: 'a2', hostname: null, label: null }),
        ])}
        timezone="UTC"
      />,
    );
    expect(screen.getByTestId('portal-network-asset-a1').textContent).toContain('Front printer');
    expect(screen.getByTestId('portal-network-asset-a2').textContent).toContain('—');
  });

  it('shows the empty state for no_data', () => {
    render(
      <NetworkAssetTable
        initial={{ dataStatus: 'no_data', data: [], pagination: { page: 1, limit: 50, total: 0 } }}
        timezone="UTC"
      />,
    );
    expect(screen.getByTestId('portal-network-asset-empty')).toBeTruthy();
    expect(screen.queryByTestId('portal-network-asset-table')).toBeNull();
  });

  it('shows an error notice, not the empty state, when the load failed', () => {
    render(<NetworkAssetTable initial={null} error="boom" timezone="UTC" />);
    expect(screen.getByTestId('portal-network-asset-error')).toBeTruthy();
    expect(screen.queryByTestId('portal-network-asset-empty')).toBeNull();
    expect(screen.queryByText('boom')).toBeNull();
  });

  it('maps the type filter to assetType, resets to page 1 and persists to the hash', async () => {
    listMock.mockResolvedValue({ statusCode: 200, data: ok([row({ id: 'p1' })]) });
    render(<NetworkAssetTable initial={ok([row()], 120)} timezone="UTC" />);
    fireEvent.change(screen.getByTestId('portal-network-filter-type'), { target: { value: 'printer' } });
    await waitFor(() =>
      expect(listMock).toHaveBeenCalledWith({ page: 1, limit: 50, assetType: 'printer', status: undefined }),
    );
    await waitFor(() => expect(screen.getByTestId('portal-network-asset-p1')).toBeTruthy());
    expect(window.location.hash).toContain('type=printer');
  });

  it('maps the status filter (Unknown → unverified)', async () => {
    listMock.mockResolvedValue({ statusCode: 200, data: ok([]) });
    render(<NetworkAssetTable initial={ok([row()])} timezone="UTC" />);
    fireEvent.change(screen.getByTestId('portal-network-filter-status'), { target: { value: 'unverified' } });
    await waitFor(() =>
      expect(listMock).toHaveBeenCalledWith({ page: 1, limit: 50, assetType: undefined, status: 'unverified' }),
    );
  });

  it('shows a no-match message (not the discovery empty state) when a filter matches nothing', async () => {
    listMock.mockResolvedValue({ statusCode: 200, data: ok([]) });
    render(<NetworkAssetTable initial={ok([row()])} timezone="UTC" />);
    fireEvent.change(screen.getByTestId('portal-network-filter-status'), { target: { value: 'offline' } });
    await waitFor(() => expect(screen.getByTestId('portal-network-asset-no-match')).toBeTruthy());
    expect(screen.queryByTestId('portal-network-asset-empty')).toBeNull();
    // Filters stay so the customer can clear them.
    expect(screen.getByTestId('portal-network-filter-status')).toBeTruthy();
  });

  it('pages forward through page/limit and totals at the foot', async () => {
    listMock.mockResolvedValue({ statusCode: 200, data: ok([row({ id: 'n2' })], 120, 2) });
    render(<NetworkAssetTable initial={ok([row()], 120)} timezone="UTC" />);
    expect((screen.getByTestId('portal-network-prev') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('portal-network-next'));
    await waitFor(() =>
      expect(listMock).toHaveBeenCalledWith({ page: 2, limit: 50, assetType: undefined, status: undefined }),
    );
    await waitFor(() => expect(screen.getByTestId('portal-network-asset-n2')).toBeTruthy());
    expect(screen.getByTestId('portal-network-asset-count').textContent).toContain('120');
  });

  it('shows an error notice when a refetch fails', async () => {
    listMock.mockResolvedValue({ statusCode: 500, error: 'x' });
    render(<NetworkAssetTable initial={ok([row()])} timezone="UTC" />);
    fireEvent.change(screen.getByTestId('portal-network-filter-type'), { target: { value: 'printer' } });
    await waitFor(() => expect(screen.getByTestId('portal-network-asset-error')).toBeTruthy());
  });

  it('restores filters and page from the hash on mount and fetches with them', async () => {
    window.location.hash = '#type=router&status=offline&page=2';
    listMock.mockResolvedValue({ statusCode: 200, data: ok([row({ id: 'h1' })], 80, 2) });
    render(<NetworkAssetTable initial={ok([row()])} timezone="UTC" />);
    await waitFor(() =>
      expect(listMock).toHaveBeenCalledWith({ page: 2, limit: 50, assetType: 'router', status: 'offline' }),
    );
  });

  it('has no site filter (needs a site list — tracked as a follow-up)', () => {
    render(<NetworkAssetTable initial={ok([row()])} timezone="UTC" />);
    expect(screen.queryByTestId('portal-network-filter-site')).toBeNull();
  });
});
