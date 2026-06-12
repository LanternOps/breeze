import { beforeEach, describe, expect, it, vi } from 'vitest';

const BLOCKED_ORG_ID = '22222222-2222-2222-2222-222222222222';
const CALLER_ORG_ID = '33333333-3333-3333-3333-333333333333';
const CALLER_PARTNER_ID = '44444444-4444-4444-4444-444444444444';

const selectMock = vi.fn();
const selectDistinctMock = vi.fn();

// Per-test auth context injected by the requireScope stub. Defaults to a
// system-scope caller in beforeEach; tests override to exercise org/partner
// scoping of the observed query.
let currentAuth: Record<string, unknown>;

function systemAuth() {
  return {
    scope: 'system',
    orgId: null,
    partnerId: null,
    canAccessOrg: (orgId: string) => orgId !== BLOCKED_ORG_ID,
  };
}

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
  organizations: {
    id: 'organizations.id',
    partnerId: 'organizations.partnerId',
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
    c.set('auth', currentAuth);
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

/** Conditions object the observed (selectDistinct) query was filtered with. */
function observedWhereMock() {
  return selectDistinctMock.mock.results[0]?.value.from.mock.results[0]?.value.where;
}

describe('GET /app-options', () => {
  beforeEach(() => {
    selectMock.mockReset();
    selectDistinctMock.mockReset();
    currentAuth = systemAuth();
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

  it('dedupes custom and third_party entries as one app-rule bucket', async () => {
    selectMock.mockReturnValue(selectRows([
      { source: 'third_party', packageId: 'Mozilla.Firefox', vendor: 'Mozilla', displayName: 'Firefox' },
    ]));
    selectDistinctMock.mockReturnValue(selectDistinctRows([
      { source: 'custom', packageId: 'mozilla.firefox', vendor: 'Mozilla Corp', displayName: 'Firefox custom update' },
    ]));

    const res = await appOptionsRoutes.request('/app-options');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toEqual(expect.objectContaining({
      source: 'third_party',
      packageId: 'Mozilla.Firefox',
      displayName: 'Firefox',
      inCatalog: true,
    }));
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
    expect(observedWhereMock()).toHaveBeenCalledWith(expect.objectContaining({
      op: 'and',
      conditions: expect.arrayContaining([
        expect.objectContaining({
          strings: expect.arrayContaining([expect.stringContaining('EXISTS')]),
          values: expect.arrayContaining(['11111111-1111-1111-1111-111111111111']),
        }),
      ]),
    }));
  });

  it('constrains observed query to the caller org for organization scope without orgId', async () => {
    currentAuth = {
      scope: 'organization',
      orgId: CALLER_ORG_ID,
      partnerId: null,
      canAccessOrg: (orgId: string) => orgId === CALLER_ORG_ID,
    };
    selectMock.mockReturnValue(selectRows([]));
    selectDistinctMock.mockReturnValue(selectDistinctRows([
      { source: 'third_party', packageId: 'Google.Chrome', vendor: 'Google', displayName: 'Chrome update' },
    ]));

    const res = await appOptionsRoutes.request('/app-options');

    expect(res.status).toBe(200);
    expect(observedWhereMock()).toHaveBeenCalledWith(expect.objectContaining({
      op: 'and',
      conditions: expect.arrayContaining([
        expect.objectContaining({
          strings: expect.arrayContaining([expect.stringContaining('EXISTS')]),
          values: expect.arrayContaining([CALLER_ORG_ID]),
        }),
      ]),
    }));
  });

  it('returns 403 for organization scope with no org context instead of running unscoped', async () => {
    currentAuth = {
      scope: 'organization',
      orgId: null,
      partnerId: null,
      canAccessOrg: () => false,
    };

    const res = await appOptionsRoutes.request('/app-options');

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Organization context required' });
    expect(selectMock).not.toHaveBeenCalled();
    expect(selectDistinctMock).not.toHaveBeenCalled();
  });

  it('constrains observed query to partner orgs for partner scope without orgId', async () => {
    currentAuth = {
      scope: 'partner',
      orgId: null,
      partnerId: CALLER_PARTNER_ID,
      canAccessOrg: (orgId: string) => orgId !== BLOCKED_ORG_ID,
    };
    selectMock.mockReturnValue(selectRows([]));
    selectDistinctMock.mockReturnValue(selectDistinctRows([]));

    const res = await appOptionsRoutes.request('/app-options');

    expect(res.status).toBe(200);
    expect(observedWhereMock()).toHaveBeenCalledWith(expect.objectContaining({
      op: 'and',
      conditions: expect.arrayContaining([
        expect.objectContaining({
          strings: expect.arrayContaining([
            expect.stringContaining('EXISTS'),
            expect.stringContaining('partner_id'),
          ]),
          values: expect.arrayContaining([CALLER_PARTNER_ID]),
        }),
      ]),
    }));
  });

  it('returns 403 for partner scope with no partner context instead of running unscoped', async () => {
    currentAuth = {
      scope: 'partner',
      orgId: null,
      partnerId: null,
      canAccessOrg: () => false,
    };

    const res = await appOptionsRoutes.request('/app-options');

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Partner context required' });
    expect(selectMock).not.toHaveBeenCalled();
    expect(selectDistinctMock).not.toHaveBeenCalled();
  });

  it('runs the observed query unconstrained for system scope without orgId', async () => {
    currentAuth = systemAuth();
    selectMock.mockReturnValue(selectRows([]));
    selectDistinctMock.mockReturnValue(selectDistinctRows([]));

    const res = await appOptionsRoutes.request('/app-options');

    expect(res.status).toBe(200);
    const whereMock = observedWhereMock();
    expect(whereMock).toHaveBeenCalledTimes(1);
    const whereArg = whereMock.mock.calls[0][0];
    expect(whereArg.op).toBe('and');
    // Only the source + packageId conditions — no tenant EXISTS clause.
    expect(whereArg.conditions).toHaveLength(2);
    for (const condition of whereArg.conditions) {
      const strings: string[] = condition.strings ?? [];
      expect(strings.some((s) => s.includes('EXISTS'))).toBe(false);
    }
  });

  it('returns 403 for an unknown scope instead of running unscoped', async () => {
    currentAuth = {
      scope: 'something-else',
      orgId: null,
      partnerId: null,
      canAccessOrg: () => true,
    };

    const res = await appOptionsRoutes.request('/app-options');

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Insufficient permissions' });
    expect(selectMock).not.toHaveBeenCalled();
    expect(selectDistinctMock).not.toHaveBeenCalled();
  });
});
