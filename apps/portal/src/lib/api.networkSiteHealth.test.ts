import { afterEach, describe, expect, it, vi } from 'vitest';
import { portalApi } from './api';

describe('portalApi.getNetworkSiteHealth (CPEV-W2)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('GETs /portal/network/sites/health and returns the DTO untouched', async () => {
    const dto = {
      dataStatus: 'ok',
      data: [
        {
          siteId: 'site-a',
          siteName: 'Main Office',
          totalAssets: 3,
          onlineAssets: 2,
          offlineAssets: 1,
          unverifiedAssets: 0,
          snmpDevicesPolling: 1,
          monitorsDown: 0,
        },
      ],
    };
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => new Response(JSON.stringify(dto), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await portalApi.getNetworkSiteHealth();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('/portal/network/sites/health');
    expect(url).not.toContain('?');
    expect(response.data).toEqual(dto);
  });
});
