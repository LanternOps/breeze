import { beforeEach, describe, expect, it, vi } from 'vitest';

const BLOCKED_ORG_ID = '22222222-2222-2222-2222-222222222222';

const selectMock = vi.fn();
const selectDistinctMock = vi.fn();

vi.mock('drizzle-orm', () => {
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values })) as unknown;

  return {
    and: (...conditions: unknown[]) => ({ op: 'and', conditions }),
    inArray: (left: unknown, right: unknown) => ({ op: 'inArray', left, right }),
    sql,
  };
});

vi.mock('../../db', () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...args),
    selectDistinct: (...args: unknown[]) => selectDistinctMock(...args),
  },
}));

vi.mock('../../db/schema', () => ({
  patches: {
    id: 'patches.id',
    source: 'patches.source',
    packageId: 'patches.packageId',
    vendor: 'patches.vendor',
    title: 'patches.title',
  },
  devices: {
    id: 'devices.id',
    orgId: 'devices.orgId',
  },
  devicePatches: {
    patchId: 'devicePatches.patchId',
  },
  thirdPartyPackageCatalog: {
    source: 'thirdPartyPackageCatalog.source',
    packageId: 'thirdPartyPackageCatalog.packageId',
    vendor: 'thirdPartyPackageCatalog.vendor',
    friendlyName: 'thirdPartyPackageCatalog.friendlyName',
  },
}));

vi.mock('../../middleware/auth', () => ({
  requireScope: vi.fn(() => async (c: any, next: any) => {
    c.set('auth', {
      canAccessOrg: (orgId: string) => orgId !== BLOCKED_ORG_ID,
    });
    await next();
  }),
}));

import { appOptionsRoutes } from './appOptions';

function selectRows(rows: unknown[]) {
  return {
    from: vi.fn().mockResolvedValue(rows),
  };
}

function selectDistinctRows(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(rows),
    }),
  };
}

describe('GET /app-options', () => {
  beforeEach(() => {
    selectMock.mockReset();
    selectDistinctMock.mockReset();
  });

  it('merges catalog and observed entries, with catalog metadata winning on dedup', async () => {
    selectMock.mockReturnValue(selectRows([
      { source: 'third_party', packageId: 'Mozilla.Firefox', vendor: 'Mozilla', displayName: 'Firefox' },
    ]));
    selectDistinctMock.mockReturnValue(selectDistinctRows([
      { source: 'third_party', packageId: 'mozilla.firefox', vendor: 'Mozilla Corp', displayName: 'Firefox 121 update' },
      { source: 'third_party', packageId: 'VideoLAN.VLC', vendor: 'VideoLAN', displayName: 'VLC update' },
    ]));

    const res = await appOptionsRoutes.request('/app-options');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(2);
    const firefox = body.data.find((option: any) => option.packageId.toLowerCase() === 'mozilla.firefox');
    expect(firefox.displayName).toBe('Firefox');
    expect(firefox.inCatalog).toBe(true);
    expect(body.data.find((option: any) => option.packageId === 'VideoLAN.VLC').inCatalog).toBe(false);
  });

  it('filters by search across name, vendor, and packageId', async () => {
    selectMock.mockReturnValue(selectRows([
      { source: 'third_party', packageId: 'Mozilla.Firefox', vendor: 'Mozilla', displayName: 'Firefox' },
      { source: 'third_party', packageId: 'VideoLAN.VLC', vendor: 'VideoLAN', displayName: 'VLC' },
    ]));
    selectDistinctMock.mockReturnValue(selectDistinctRows([]));

    const res = await appOptionsRoutes.request('/app-options?search=videolan');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].packageId).toBe('VideoLAN.VLC');
  });

  it('rejects inaccessible orgId with 403', async () => {
    const res = await appOptionsRoutes.request(`/app-options?orgId=${BLOCKED_ORG_ID}`);

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Access denied to this organization' });
    expect(selectMock).not.toHaveBeenCalled();
    expect(selectDistinctMock).not.toHaveBeenCalled();
  });

  it('applies org scoping and limit', async () => {
    selectMock.mockReturnValue(selectRows([
      { source: 'third_party', packageId: 'Mozilla.Firefox', vendor: 'Mozilla', displayName: 'Firefox' },
      { source: 'third_party', packageId: 'VideoLAN.VLC', vendor: 'VideoLAN', displayName: 'VLC' },
    ]));
    selectDistinctMock.mockReturnValue(selectDistinctRows([
      { source: 'third_party', packageId: 'Google.Chrome', vendor: 'Google', displayName: 'Chrome update' },
    ]));

    const res = await appOptionsRoutes.request('/app-options?orgId=11111111-1111-1111-1111-111111111111&limit=2');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(2);
    const observedWhere = selectDistinctMock.mock.results[0]?.value.from.mock.results[0]?.value.where;
    expect(observedWhere).toHaveBeenCalledWith(expect.objectContaining({
      op: 'and',
      conditions: expect.arrayContaining([
        expect.objectContaining({ strings: expect.arrayContaining([expect.stringContaining('EXISTS')]) }),
      ]),
    }));
  });
});
