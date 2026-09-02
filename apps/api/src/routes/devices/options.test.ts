import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { sql } from 'drizzle-orm';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const SITE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SITE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const { authState, permissionsState } = vi.hoisted(() => ({
  authState: {
    orgId: '11111111-1111-4111-8111-111111111111',
    accessibleOrgIds: ['11111111-1111-4111-8111-111111111111'] as string[] | null,
  },
  permissionsState: { allowedSiteIds: undefined as string[] | undefined },
}));

vi.mock('../../db', () => ({ db: { select: vi.fn() } }));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    const accessible = authState.accessibleOrgIds;
    c.set('auth', {
      principal: { kind: 'user_session' },
      user: { id: 'user-1', email: 'user@example.com', name: 'User', isPlatformAdmin: false },
      scope: 'organization',
      orgId: authState.orgId,
      partnerId: null,
      accessibleOrgIds: accessible,
      canAccessOrg: (id: string) => accessible === null || accessible.includes(id),
      orgCondition: () => sql`ORG_SCOPE`,
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (c: any, next: any) => {
    c.set('permissions', {
      permissions: [{ resource: 'devices', action: 'read' }],
      allowedSiteIds: permissionsState.allowedSiteIds,
    });
    return next();
  }),
}));

import { db } from '../../db';
import { optionsRoutes } from './options';
import {
  buildDeviceOptionsFingerprint,
  decodeDeviceOptionsCursor,
  encodeDeviceOptionsCursor,
} from './optionsCursor';

type OptionRow = {
  id: string;
  hostname: string;
  displayName: string | null;
  osType: string;
  status: string;
  siteId: string | null;
  siteName: string | null;
  normalizedLabel: string;
};

function id(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function row(n: number, overrides: Partial<OptionRow> = {}): OptionRow {
  return {
    id: id(n),
    hostname: `host-${String(n).padStart(3, '0')}`,
    displayName: null,
    osType: 'windows',
    status: 'online',
    siteId: SITE_A,
    siteName: 'Main',
    normalizedLabel: `host-${String(n).padStart(3, '0')}`,
    ...overrides,
  };
}

function queryChain(result: unknown, capture?: { where?: unknown; limit?: number }) {
  const chain: any = {};
  chain.leftJoin = vi.fn(() => chain);
  chain.where = vi.fn((where: unknown) => {
    if (capture) capture.where = where;
    return chain;
  });
  chain.orderBy = vi.fn(() => chain);
  chain.limit = vi.fn((limit: number) => {
    if (capture) capture.limit = limit;
    return Promise.resolve(result);
  });
  chain.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return { from: vi.fn(() => chain), chain };
}

function rigQueries(input: {
  total?: number;
  page?: OptionRow[];
  included?: OptionRow[];
  site?: { id: string; orgId: string } | null;
}) {
  const captures: Array<{ where?: unknown; limit?: number }> = [];
  const selects: any[] = [];
  if (input.site !== undefined) {
    const capture = {};
    captures.push(capture);
    selects.push(queryChain(input.site ? [input.site] : [], capture));
  }
  const countCapture = {};
  captures.push(countCapture);
  selects.push(queryChain([{ count: input.total ?? (input.page?.length ?? 0) }], countCapture));
  const pageCapture = {};
  captures.push(pageCapture);
  selects.push(queryChain(input.page ?? [], pageCapture));
  if (input.included !== undefined) {
    const includeCapture = {};
    captures.push(includeCapture);
    selects.push(queryChain(input.included, includeCapture));
  }
  for (const selection of selects) vi.mocked(db.select).mockReturnValueOnce(selection as never);
  return captures;
}

function sqlTree(value: unknown): string {
  const seen = new Set<object>();
  return JSON.stringify(value, (_key, candidate) => {
    if (typeof candidate === 'object' && candidate !== null) {
      if (seen.has(candidate)) return '[circular]';
      seen.add(candidate);
    }
    return candidate;
  });
}

describe('device option cursor', () => {
  it('round-trips a versioned label/UUID cursor bound to a query fingerprint', () => {
    const fingerprint = buildDeviceOptionsFingerprint({
      search: 'alpha', status: 'online', siteId: SITE_A, osType: 'windows', orgId: ORG_A,
      scope: 'organization', accessibleOrgIds: [ORG_A], allowedSiteIds: [SITE_A],
    });
    const token = encodeDeviceOptionsCursor({
      v: 1, label: 'alpha', id: id(1), fingerprint,
    });
    expect(decodeDeviceOptionsCursor(token, fingerprint)).toEqual({
      v: 1, label: 'alpha', id: id(1), fingerprint,
    });
  });

  it('rejects malformed, unknown-version, invalid-UUID, and mismatched-fingerprint cursors', () => {
    const fp = 'a'.repeat(64);
    expect(decodeDeviceOptionsCursor('not-json', fp)).toBeNull();
    expect(decodeDeviceOptionsCursor(Buffer.from(JSON.stringify({ v: 2, label: 'a', id: id(1), fingerprint: fp })).toString('base64url'), fp)).toBeNull();
    expect(decodeDeviceOptionsCursor(Buffer.from(JSON.stringify({ v: 1, label: 'a', id: 'bad', fingerprint: fp })).toString('base64url'), fp)).toBeNull();
    expect(decodeDeviceOptionsCursor(encodeDeviceOptionsCursor({ v: 1, label: 'a', id: id(1), fingerprint: fp }), 'b'.repeat(64))).toBeNull();
  });
});

describe('GET /devices/options', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    authState.orgId = ORG_A;
    authState.accessibleOrgIds = [ORG_A];
    permissionsState.allowedSiteIds = undefined;
    app = new Hono();
    app.route('/devices', optionsRoutes);
  });

  it('returns the explicit empty page contract for zero rows', async () => {
    rigQueries({ total: 0, page: [] });
    const response = await app.request('/devices/options');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toEqual([]);
    expect(body.page).toMatchObject({ nextCursor: null, returned: 0, total: 0, hasMore: false });
    expect(Number.isNaN(Date.parse(body.page.observedAt))).toBe(false);
  });

  it('returns exactly 50 rows without a cursor and 51 rows as 50 plus a cursor', async () => {
    rigQueries({ total: 50, page: Array.from({ length: 50 }, (_, i) => row(i + 1)) });
    let response = await app.request('/devices/options');
    let body = await response.json();
    expect(body.data).toHaveLength(50);
    expect(body.page).toMatchObject({ returned: 50, total: 50, hasMore: false, nextCursor: null });

    vi.mocked(db.select).mockReset();
    rigQueries({ total: 51, page: Array.from({ length: 51 }, (_, i) => row(i + 1)) });
    response = await app.request('/devices/options');
    body = await response.json();
    expect(body.data).toHaveLength(50);
    expect(body.page.hasMore).toBe(true);
    expect(typeof body.page.nextCursor).toBe('string');
    expect(body.data.at(-1).id).toBe(id(50));
  });

  it('applies case-insensitive hostname/display-name search plus status, site, OS, and org filters before paging', async () => {
    const captures = rigQueries({
      site: { id: SITE_A, orgId: ORG_A },
      total: 1,
      page: [row(1, { displayName: 'Alpha Laptop', normalizedLabel: 'alpha laptop' })],
    });
    const response = await app.request(`/devices/options?search=ALPHA&status=online&siteId=${SITE_A}&osType=windows&orgId=${ORG_A}`);
    expect(response.status).toBe(200);
    const rendered = sqlTree(captures[2]?.where);
    expect(rendered).toContain('hostname');
    expect(rendered).toContain('display_name');
    expect(rendered.toLowerCase()).toContain('alpha');
    expect(rendered).toContain('online');
    expect(rendered).toContain(SITE_A);
    expect(rendered).toContain('windows');
    expect(rendered).toContain(ORG_A);
  });

  it('rejects malformed and query-mismatched cursors instead of restarting', async () => {
    let response = await app.request('/devices/options?cursor=malformed');
    expect(response.status).toBe(400);
    expect(db.select).not.toHaveBeenCalled();

    const fp = buildDeviceOptionsFingerprint({
      search: 'alpha', status: undefined, siteId: undefined, osType: undefined, orgId: undefined,
      scope: 'organization', accessibleOrgIds: [ORG_A], allowedSiteIds: undefined,
    });
    const cursor = encodeDeviceOptionsCursor({ v: 1, label: 'alpha', id: id(1), fingerprint: fp });
    response = await app.request(`/devices/options?search=beta&cursor=${cursor}`);
    expect(response.status).toBe(400);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('hydrates authorized off-page includeIds outside page accounting, de-duplicates, and keeps label/UUID order', async () => {
    const selected = row(90, { hostname: 'zeta', normalizedLabel: 'zeta' });
    const tiedA = row(2, { hostname: 'same', normalizedLabel: 'same' });
    const tiedB = row(1, { hostname: 'same', normalizedLabel: 'same' });
    rigQueries({ total: 2, page: [tiedA, tiedB], included: [selected, tiedA] });
    const response = await app.request(`/devices/options?includeIds=${selected.id},${tiedA.id}`);
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.data.map((item: { id: string }) => item.id)).toEqual([tiedB.id, tiedA.id, selected.id]);
    expect(body.page).toMatchObject({ returned: 3, total: 2, hasMore: false });
  });

  it('silently omits inaccessible includeIds without exposing labels or foreign counts', async () => {
    rigQueries({ total: 0, page: [], included: [] });
    const response = await app.request(`/devices/options?search=foreign-secret&includeIds=${id(999)}`);
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ data: [], page: { returned: 0, total: 0 } });
  });

  it('caps pages at 100 and rejects more than 500 includeIds', async () => {
    const captures = rigQueries({ total: 101, page: Array.from({ length: 101 }, (_, i) => row(i + 1)) });
    let response = await app.request('/devices/options?limit=100');
    expect(response.status).toBe(200);
    expect(captures[1]?.limit).toBe(101);

    vi.mocked(db.select).mockClear();
    const tooMany = Array.from({ length: 501 }, (_, i) => id(i + 1)).join(',');
    response = await app.request(`/devices/options?includeIds=${tooMany}`);
    expect(response.status).toBe(400);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('rejects an unauthorized explicit orgId before querying', async () => {
    const response = await app.request(`/devices/options?orgId=${ORG_B}`);
    expect(response.status).toBe(403);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('rejects a forbidden siteId and does not disclose whether it exists', async () => {
    permissionsState.allowedSiteIds = [SITE_A];
    const response = await app.request(`/devices/options?siteId=${SITE_B}`);
    expect(response.status).toBe(403);
    expect(db.select).not.toHaveBeenCalled();
  });
});
