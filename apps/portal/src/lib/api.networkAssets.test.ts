import { afterEach, describe, expect, it, vi } from 'vitest';
import { portalApi } from './api';

describe('portalApi.getNetworkAssets (#6641)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('GETs /portal/network/assets with page/limit defaults and only the filters that are set', async () => {
    const dto = { dataStatus: 'no_data', data: [], pagination: { page: 1, limit: 50, total: 0 } };
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => new Response(JSON.stringify(dto), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await portalApi.getNetworkAssets({});
    await portalApi.getNetworkAssets({ page: 3, limit: 25, assetType: 'server', status: 'unverified' });

    const first = String(fetchMock.mock.calls[0][0]);
    expect(first).toContain('/portal/network/assets?page=1&limit=50');
    expect(first).not.toContain('assetType');
    expect(first).not.toContain('status');
    const second = String(fetchMock.mock.calls[1][0]);
    expect(second).toContain('page=3');
    expect(second).toContain('limit=25');
    expect(second).toContain('assetType=server');
    expect(second).toContain('status=unverified');
  });
});
