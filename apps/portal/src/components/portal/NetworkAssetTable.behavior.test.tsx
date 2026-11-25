// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

const SITES = [
  { id: 's1', name: 'HQ' },
  { id: 's2', name: 'Warehouse' },
];

const noFilters = { assetType: undefined, status: undefined, siteId: undefined };

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
      expect(listMock).toHaveBeenLastCalledWith({ page: 1, limit: 50, assetType: 'printer', status: undefined, siteId: undefined }),
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

  it('site filter maps to siteId, resets page, persists in the hash and clears (#7025)', async () => {
    window.location.hash = '#page=2';
    listMock.mockResolvedValueOnce({ statusCode: 200, data: ok(['x'], 120, 2) });
    render(<NetworkAssetTable initial={ok(['a'], 120)} sites={SITES} timezone="UTC" />);
    await waitFor(() => expect(screen.getByTestId('portal-network-asset-x')).toBeTruthy());

    listMock.mockResolvedValueOnce({ statusCode: 200, data: ok(['w'], 3) });
    fireEvent.change(screen.getByTestId('portal-network-filter-site'), { target: { value: 's2' } });
    await waitFor(() =>
      expect(listMock).toHaveBeenLastCalledWith({ page: 1, limit: 50, assetType: undefined, status: undefined, siteId: 's2' }),
    );
    await waitFor(() => expect(screen.getByTestId('portal-network-asset-w')).toBeTruthy());
    expect(window.location.hash).toContain('site=s2');
    expect(window.location.hash).not.toContain('page=');

    listMock.mockResolvedValueOnce({ statusCode: 200, data: ok(['a'], 1) });
    fireEvent.click(screen.getByTestId('portal-network-filter-clear'));
    await waitFor(() => expect(listMock).toHaveBeenLastCalledWith({ page: 1, limit: 50, ...noFilters }));
    expect(window.location.hash).not.toContain('site=');
  });

  it('restores the site filter from the hash on load (#7025)', async () => {
    window.location.hash = '#site=s1';
    listMock.mockResolvedValueOnce({ statusCode: 200, data: ok(['h'], 1) });
    render(<NetworkAssetTable initial={ok(['a'], 5)} sites={SITES} timezone="UTC" />);
    await waitFor(() =>
      expect(listMock).toHaveBeenLastCalledWith({ page: 1, limit: 50, assetType: undefined, status: undefined, siteId: 's1' }),
    );
  });

  it('ignores a hash site id that is not one of the org sites (#7025)', async () => {
    window.location.hash = '#site=bogus';
    render(<NetworkAssetTable initial={ok(['a'], 5)} sites={SITES} timezone="UTC" />);
    await new Promise((r) => setTimeout(r, 20));
    expect(listMock).not.toHaveBeenCalled();
  });

  it('hides the site filter when the org has fewer than two sites (#7025)', () => {
    render(<NetworkAssetTable initial={ok(['a'], 1)} sites={[SITES[0]]} timezone="UTC" />);
    expect(screen.queryByTestId('portal-network-filter-site')).toBeNull();
  });

  describe('hashchange after mount (CPEV-W2 site summary links)', () => {
    // jsdom fires `hashchange` asynchronously after a hash assignment, like a browser.
    const navigate = (hash: string) => act(() => { window.location.hash = hash; });

    it('a #site=<id> link filters by that site, reflects it in the select and resets the page', async () => {
      render(<NetworkAssetTable initial={ok(['a'], 120)} sites={SITES} timezone="UTC" />);

      listMock.mockResolvedValueOnce({ statusCode: 200, data: ok(['w'], 3) });
      navigate('#site=s2');
      await waitFor(() =>
        expect(listMock).toHaveBeenLastCalledWith({ page: 1, limit: 50, assetType: undefined, status: undefined, siteId: 's2' }),
      );
      await waitFor(() => expect(screen.getByTestId('portal-network-asset-w')).toBeTruthy());
      expect((screen.getByTestId('portal-network-filter-site') as HTMLSelectElement).value).toBe('s2');
      expect(screen.getByTestId('portal-network-filter-clear')).toBeTruthy();
      expect(window.location.hash).toContain('site=s2');
      expect(listMock).toHaveBeenCalledTimes(1);
    });

    it('ignores a #site= id that is not one of the org sites', async () => {
      render(<NetworkAssetTable initial={ok(['a'], 5)} sites={SITES} timezone="UTC" />);

      navigate('#site=bogus');
      await new Promise((r) => setTimeout(r, 20));
      expect(listMock).not.toHaveBeenCalled();
      expect((screen.getByTestId('portal-network-filter-site') as HTMLSelectElement).value).toBe('');
    });

    it('does not refetch when the hash already matches the applied filters (our own replaceState never loops)', async () => {
      render(<NetworkAssetTable initial={ok(['a'], 5)} sites={SITES} timezone="UTC" />);
      listMock.mockResolvedValueOnce({ statusCode: 200, data: ok(['w'], 3) });
      fireEvent.change(screen.getByTestId('portal-network-filter-site'), { target: { value: 's2' } });
      await waitFor(() => expect(screen.getByTestId('portal-network-asset-w')).toBeTruthy());
      expect(listMock).toHaveBeenCalledTimes(1);

      act(() => { window.dispatchEvent(new HashChangeEvent('hashchange')); });
      await new Promise((r) => setTimeout(r, 20));
      expect(listMock).toHaveBeenCalledTimes(1);
    });

    it('going back to an empty hash clears the site filter', async () => {
      render(<NetworkAssetTable initial={ok(['a'], 5)} sites={SITES} timezone="UTC" />);
      listMock.mockResolvedValueOnce({ statusCode: 200, data: ok(['w'], 3) });
      navigate('#site=s2');
      await waitFor(() => expect(screen.getByTestId('portal-network-asset-w')).toBeTruthy());

      listMock.mockResolvedValueOnce({ statusCode: 200, data: ok(['a'], 5) });
      navigate('');
      await waitFor(() => expect(listMock).toHaveBeenLastCalledWith({ page: 1, limit: 50, ...noFilters }));
      await waitFor(() => expect(screen.getByTestId('portal-network-asset-a')).toBeTruthy());
      expect((screen.getByTestId('portal-network-filter-site') as HTMLSelectElement).value).toBe('');
    });

    it('a newer hashchange supersedes a slower earlier one', async () => {
      let resolveSlow!: (v: unknown) => void;
      render(<NetworkAssetTable initial={ok(['a'], 5)} sites={SITES} timezone="UTC" />);
      listMock.mockImplementationOnce(() => new Promise((r) => { resolveSlow = r; }));
      listMock.mockResolvedValueOnce({ statusCode: 200, data: ok(['fresh'], 1) });

      navigate('#site=s1');
      await waitFor(() => expect(listMock).toHaveBeenCalledTimes(1));
      navigate('#site=s2');
      await waitFor(() => expect(screen.getByTestId('portal-network-asset-fresh')).toBeTruthy());

      resolveSlow({ statusCode: 200, data: ok(['stale'], 1) });
      await Promise.resolve();
      await Promise.resolve();
      expect(screen.queryByTestId('portal-network-asset-stale')).toBeNull();
      expect((screen.getByTestId('portal-network-filter-site') as HTMLSelectElement).value).toBe('s2');
    });

    it('scrolls the register heading into view when it applies a hash filter', async () => {
      const scrollIntoView = vi.fn();
      Object.defineProperty(Element.prototype, 'scrollIntoView', { value: scrollIntoView, configurable: true });
      try {
        render(<NetworkAssetTable initial={ok(['a'], 5)} sites={SITES} timezone="UTC" />);
        listMock.mockResolvedValueOnce({ statusCode: 200, data: ok(['w'], 3) });
        navigate('#site=s2');
        await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
        expect(scrollIntoView.mock.contexts[0]).toBe(screen.getByRole('heading', { name: 'Network assets' }));
      } finally {
        delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
      }
    });

    it('removes its listener on unmount', async () => {
      const removeSpy = vi.spyOn(window, 'removeEventListener');
      const { unmount } = render(<NetworkAssetTable initial={ok(['a'], 5)} sites={SITES} timezone="UTC" />);
      unmount();
      expect(removeSpy.mock.calls.some(([type]) => type === 'hashchange')).toBe(true);
      removeSpy.mockRestore();

      navigate('#site=s2');
      await new Promise((r) => setTimeout(r, 20));
      expect(listMock).not.toHaveBeenCalled();
    });
  });
});
