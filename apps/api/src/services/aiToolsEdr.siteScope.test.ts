import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));
vi.mock('./edrProviders/read', async () => {
  const actual = await vi.importActual<typeof import('./edrProviders/read')>('./edrProviders/read');
  return { ...actual, listEdrDetections: vi.fn(), getEdrStatus: vi.fn() };
});

import { db } from '../db';
import { registerEdrTools } from './aiToolsEdr';
import { listEdrDetections, getEdrStatus } from './edrProviders/read';
import { edrSitePredicate } from './edrProviders/readScope';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';

const mockDb = db as unknown as { select: ReturnType<typeof vi.fn> };
const mockList = listEdrDetections as unknown as ReturnType<typeof vi.fn>;
const mockStatus = getEdrStatus as unknown as ReturnType<typeof vi.fn>;

const COVERAGE = { orgsWithEdr: 1, partial: false, notes: [] };

function handlerFor(name: string): AiTool['handler'] {
  const reg = new Map<string, AiTool>();
  registerEdrTools(reg);
  return reg.get(name)!.handler;
}
function makeAuth(extra: Partial<AuthContext> = {}): AuthContext {
  const allowedSiteIds = extra.allowedSiteIds;
  return {
    user: { id: 'u1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
    token: {} as any, partnerId: null, orgId: 'org-1', scope: 'organization',
    accessibleOrgIds: ['org-1'], orgCondition: () => undefined, canAccessOrg: () => true,
    canAccessSite: (s: string | null | undefined) => (!allowedSiteIds ? true : !!s && allowedSiteIds.includes(s)),
    ...extra,
  } as unknown as AuthContext;
}
function collectSqlValues(node: unknown, seen = new Set<unknown>(), values: unknown[] = []): unknown[] {
  if (node === null || node === undefined || typeof node !== 'object') {
    values.push(node);
    return values;
  }
  if (seen.has(node)) return values;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const item of node) collectSqlValues(item, seen, values);
    return values;
  }
  const chunks = (node as { queryChunks?: unknown[] }).queryChunks;
  if (Array.isArray(chunks)) for (const item of chunks) collectSqlValues(item, seen, values);
  const value = (node as { value?: unknown }).value;
  if (value !== undefined) collectSqlValues(value, seen, values);
  return values;
}

const row = (id: string, breezeDeviceId: string | null) => ({ id, breezeDeviceId, threatName: `T-${id}` });

describe('list_edr_detections — site narrowing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // resolveEdrReadScope: devices in the caller's allowed sites.
    mockDb.select.mockImplementation(() => ({
      from: () => ({ where: () => Promise.resolve([{ id: 'd-siteA' }]) }),
    }));
  });

  it('passes the site-restricted caller scope (allowedSiteIds + resolved allowedDeviceIds) to the read model', async () => {
    mockList.mockResolvedValue({ rows: [], total: 0, coverage: COVERAGE });
    await handlerFor('list_edr_detections')({}, makeAuth({ allowedSiteIds: ['site-A'] }));
    const scope = mockList.mock.calls[0]![0];
    expect(scope.allowedSiteIds).toEqual(['site-A']);
    expect(scope.allowedDeviceIds).toEqual(['d-siteA']);
  });

  it('the scope handed to the read model excludes a foreign-site device from the predicate', async () => {
    mockList.mockResolvedValue({ rows: [], total: 0, coverage: COVERAGE });
    await handlerFor('list_edr_detections')({}, makeAuth({ allowedSiteIds: ['site-A'] }));
    const predicate = edrSitePredicate(mockList.mock.calls[0]![0]);
    const values = collectSqlValues(predicate);
    expect(values).toContain('d-siteA');
    expect(values).not.toContain('d-siteB');
  });

  it('get_edr_status receives the same restriction', async () => {
    mockStatus.mockResolvedValue({ providers: [], coverage: COVERAGE });
    await handlerFor('get_edr_status')({}, makeAuth({ allowedSiteIds: ['site-A'] }));
    const scope = mockStatus.mock.calls[0]![0];
    expect(scope.allowedSiteIds).toEqual(['site-A']);
    expect(scope.allowedDeviceIds).toEqual(['d-siteA']);
  });

  it('unrestricted caller gets an unrestricted scope (no device lookup)', async () => {
    mockList.mockResolvedValue({ rows: [], total: 0, coverage: COVERAGE });
    await handlerFor('list_edr_detections')({}, makeAuth());
    const scope = mockList.mock.calls[0]![0];
    expect(scope.allowedSiteIds).toBeNull();
    expect(scope.allowedDeviceIds).toBeNull();
    expect(mockDb.select).not.toHaveBeenCalled();
  });
});

describe('list_edr_detections — device-bound run (allowedDeviceIds, no site axis)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('pins the scope AND an exact deviceIds filter to the frozen set (never-linked / foreign rows excluded in SQL)', async () => {
    mockList.mockResolvedValue({ rows: [row('r1', 'd1')], total: 1, coverage: COVERAGE });
    const out = JSON.parse(await handlerFor('list_edr_detections')({}, makeAuth({ allowedDeviceIds: ['d1'] })));
    expect(mockList.mock.calls[0]![0].allowedDeviceIds).toEqual(['d1']);
    expect(mockList.mock.calls[0]![1].deviceIds).toEqual(['d1']);
    expect(out.detections.map((d: { id: string }) => d.id)).toEqual(['r1']);
    expect(out.total).toBe(1);
    expect(out.scopeNote).toBeTruthy();
    expect(out.coverage).toEqual(COVERAGE);
  });

  it('an unrestricted run passes no deviceIds filter', async () => {
    mockList.mockResolvedValue({ rows: [], total: 0, coverage: COVERAGE });
    await handlerFor('list_edr_detections')({}, makeAuth({}));
    expect(mockList.mock.calls[0]![1]).not.toHaveProperty('deviceIds');
  });

  it('a deviceId outside the frozen set returns nothing without reading', async () => {
    const out = JSON.parse(await handlerFor('list_edr_detections')(
      { deviceId: '00000000-0000-0000-0000-0000000000aa' }, makeAuth({ allowedDeviceIds: ['d1'] }),
    ));
    expect(mockList).not.toHaveBeenCalled();
    expect(out.detections).toEqual([]);
    expect(out.total).toBe(0);
    expect(out.scopeNote).toBeTruthy();
  });
});
