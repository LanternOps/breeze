// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { NetworkAssetRowDto, NetworkAssetsDto } from '@breeze/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NetworkAssetTable } from './NetworkAssetTable';

const { listMock } = vi.hoisted(() => ({ listMock: vi.fn() }));
vi.mock('@/lib/api', () => ({ portalApi: { getNetworkAssets: listMock } }));

const row = (id: string): NetworkAssetRowDto => ({
  id,
  hostname: id,
  label: null,
  ipAddress: null,
  macAddress: null,
  assetType: 'server',
  onlineState: 'online',
  lastSeenAt: null,
  firstSeenAt: '2026-08-01T12:00:00.000Z',
  manufacturer: null,
  model: null,
  siteName: 'HQ',
});

const ok = (ids: string[], total: number, page = 1): NetworkAssetsDto => ({
  dataStatus: 'ok',
  data: ids.map(row),
  pagination: { page, limit: 50, total },
});

const noFilters = { assetType: undefined, status: undefined };

describe('NetworkAssetTable behavior (#6641)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.location.hash = '';
  });

  it('changing a filter while on page 3 requests page 1 and drops page from the hash', async () => {
    window.location.hash = '#page=3';
    listMock.mockResolvedValueOnce({ statusCode: 200, data: ok(['x'], 150, 3) });
    render(<NetworkAssetTable initial={ok(['a'], 150)} timezone="UTC" />);
    await waitFor(() => expect(screen.getByTestId('portal-network-asset-x')).toBeTruthy());

    listMock.mockResolvedValueOnce({ statusCode: 200, data: ok(['p'], 10) });
    fireEvent.change(screen.getByTestId('portal-network-filter-type'), { target: { value: 'printer' } });
    await waitFor(() =>
      expect(listMock).toHaveBeenLastCalledWith({ page: 1, limit: 50, assetType: 'printer', status: undefined }),
    );
    await waitFor(() => expect(screen.getByTestId('portal-network-asset-p')).toBeTruthy());
    expect(window.location.hash).not.toContain('page=');
  });

  it('Previous goes back a page; Next is disabled on the last page', async () => {
    window.location.hash = '#page=3';
    listMock.mockResolvedValueOnce({ statusCode: 200, data: ok(['x'], 120, 3) });
    render(<NetworkAssetTable initial={ok(['a'], 120)} timezone="UTC" />);
    await waitFor(() => expect(screen.getByTestId('portal-network-asset-x')).toBeTruthy());
    expect((screen.getByTestId('portal-network-next') as HTMLButtonElement).disabled).toBe(true);

    listMock.mockResolvedValueOnce({ statusCode: 200, data: ok(['y'], 120, 2) });
    fireEvent.click(screen.getByTestId('portal-network-prev'));
    await waitFor(() => expect(listMock).toHaveBeenLastCalledWith({ page: 2, limit: 50, ...noFilters }));
    await waitFor(() => expect(screen.getByTestId('portal-network-asset-y')).toBeTruthy());
    expect(screen.getByText('Page 2 of 3')).toBeTruthy();
    expect(screen.getByTestId('portal-network-asset-count').textContent).toContain('Showing 1 of 120');
    expect(window.location.hash).toContain('page=2');
  });

  it('a page past the end (stale #page=99) clamps to the last page instead of showing "no match"', async () => {
    window.location.hash = '#page=99';
    listMock
      .mockResolvedValueOnce({ statusCode: 200, data: ok([], 120, 99) })
      .mockResolvedValueOnce({ statusCode: 200, data: ok(['last'], 120, 3) });
    render(<NetworkAssetTable initial={ok(['a'], 120)} timezone="UTC" />);
    await waitFor(() => expect(listMock).toHaveBeenLastCalledWith({ page: 3, limit: 50, ...noFilters }));
    await waitFor(() => expect(screen.getByTestId('portal-network-asset-last')).toBeTruthy());
    expect(screen.queryByTestId('portal-network-asset-no-match')).toBeNull();
  });

  it('Clear filters appears only when filtered, resets, and empties the hash', async () => {
    render(<NetworkAssetTable initial={ok(['a'], 5)} timezone="UTC" />);
    expect(screen.queryByTestId('portal-network-filter-clear')).toBeNull();

    listMock.mockResolvedValueOnce({ statusCode: 200, data: ok(['p'], 1) });
    fireEvent.change(screen.getByTestId('portal-network-filter-type'), { target: { value: 'printer' } });
    await waitFor(() => expect(screen.getByTestId('portal-network-filter-clear')).toBeTruthy());

    listMock.mockResolvedValueOnce({ statusCode: 200, data: ok(['a'], 5) });
    fireEvent.click(screen.getByTestId('portal-network-filter-clear'));
    await waitFor(() => expect(listMock).toHaveBeenLastCalledWith({ page: 1, limit: 50, ...noFilters }));
    await waitFor(() => expect(screen.queryByTestId('portal-network-filter-clear')).toBeNull());
    expect(window.location.hash).toBe('');
    expect((screen.getByTestId('portal-network-filter-type') as HTMLSelectElement).value).toBe('');
  });

  it('ignores junk in the hash and does not refetch on an empty hash', () => {
    window.location.hash = '#type=bogus&status=x&page=-1';
    render(<NetworkAssetTable initial={ok(['a'], 5)} timezone="UTC" />);
    expect(listMock).not.toHaveBeenCalled();
    expect((screen.getByTestId('portal-network-filter-type') as HTMLSelectElement).value).toBe('');
  });

  it('a slow superseded response never overwrites the newer one', async () => {
    let resolveSlow!: (v: unknown) => void;
    listMock.mockImplementationOnce(() => new Promise((r) => { resolveSlow = r; }));
    listMock.mockResolvedValueOnce({ statusCode: 200, data: ok(['fresh'], 1) });
    render(<NetworkAssetTable initial={ok(['a'], 5)} timezone="UTC" />);

    fireEvent.change(screen.getByTestId('portal-network-filter-type'), { target: { value: 'printer' } });
    fireEvent.change(screen.getByTestId('portal-network-filter-type'), { target: { value: 'server' } });
    await waitFor(() => expect(screen.getByTestId('portal-network-asset-fresh')).toBeTruthy());

    resolveSlow({ statusCode: 200, data: ok(['stale'], 1) });
    await Promise.resolve();
    await Promise.resolve();
    expect(screen.queryByTestId('portal-network-asset-stale')).toBeNull();
    expect(screen.getByTestId('portal-network-asset-fresh')).toBeTruthy();
  });

  it('a slow superseded FAILURE does not raise the error notice over fresh rows', async () => {
    let resolveSlow!: (v: unknown) => void;
    listMock.mockImplementationOnce(() => new Promise((r) => { resolveSlow = r; }));
    listMock.mockResolvedValueOnce({ statusCode: 200, data: ok(['fresh'], 1) });
    render(<NetworkAssetTable initial={ok(['a'], 5)} timezone="UTC" />);

    fireEvent.change(screen.getByTestId('portal-network-filter-type'), { target: { value: 'printer' } });
    fireEvent.change(screen.getByTestId('portal-network-filter-type'), { target: { value: 'server' } });
    await waitFor(() => expect(screen.getByTestId('portal-network-asset-fresh')).toBeTruthy());

    resolveSlow({ statusCode: 500, error: 'x' });
    await Promise.resolve();
    await Promise.resolve();
    expect(screen.queryByTestId('portal-network-asset-error')).toBeNull();
  });

  it('marks the table busy and disables paging while a request is pending', async () => {
    let resolve!: (v: unknown) => void;
    listMock.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    render(<NetworkAssetTable initial={ok(['a'], 120)} timezone="UTC" />);
    fireEvent.click(screen.getByTestId('portal-network-next'));
    await waitFor(() =>
      expect((screen.getByTestId('portal-network-next') as HTMLButtonElement).disabled).toBe(true),
    );
    expect(screen.getByTestId('portal-network-asset-table').parentElement?.getAttribute('aria-busy')).toBe('true');
    resolve({ statusCode: 200, data: ok(['b'], 120, 2) });
    await waitFor(() => expect(screen.getByTestId('portal-network-asset-b')).toBeTruthy());
  });
});
