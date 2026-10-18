// apps/api/src/services/aiToolsTrustPage.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const dbm = vi.hoisted(() => ({ rows: [] as unknown[][], insert: vi.fn(), update: vi.fn(), delete: vi.fn(), systemReads: 0, fail: null as Error | null }));
vi.mock('../db', () => {
  const chain = () => {
    const c: Record<string, unknown> = {};
    for (const m of ['from', 'where', 'innerJoin', 'leftJoin', 'limit', 'orderBy']) c[m] = vi.fn(() => c);
    c.then = (r: (v: unknown) => unknown, j?: (e: unknown) => unknown) =>
      (dbm.fail ? Promise.reject(dbm.fail) : Promise.resolve(dbm.rows.shift() ?? [])).then(r, j);
    return c;
  };
  return {
    db: { select: vi.fn(() => chain()), insert: dbm.insert, update: dbm.update, delete: dbm.delete },
    runOutsideDbContext: <T,>(fn: () => T): T => fn(),
    withSystemDbAccessContext: <T,>(fn: () => T): T => { dbm.systemReads++; return fn(); },
  };
});

const trustMode = vi.hoisted(() => ({ value: 'enforce' as 'off' | 'shadow' | 'enforce' }));
vi.mock('../config/partnerTrustMode', () => ({ partnerTrustMode: () => trustMode.value }));
const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock('./sentry', () => sentry);

import { registerTrustPageTools } from './aiToolsTrustPage';
import type { AiTool } from './aiTools';
import type { AuthContext } from '../middleware/auth';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const tools = new Map<string, AiTool>();
registerTrustPageTools(tools);
const tool = tools.get('get_trust_page_status')!;
const auth = (over: Partial<AuthContext> = {}) => ({ scope: 'partner', canAccessOrg: (id: string) => id === ORG, ...over }) as unknown as AuthContext;
const run = async (input: Record<string, unknown>, a = auth()) => JSON.parse(await tool.handler(input, a) as string);

const NOW = Date.now();
const payload = {
  schemaVersion: 2,
  summary: { catalogTotal: 16, controlsShown: 12, controlsMet: 9, deviceCount: null },
};

describe('get_trust_page_status', () => {
  beforeEach(() => { dbm.rows = []; dbm.systemReads = 0; dbm.fail = null; trustMode.value = 'enforce'; vi.clearAllMocks(); });

  it('is a tier-1 read-only tool with a bounded description and an orgId-only input', () => {
    expect(tool.tier).toBe(1);
    expect(tool.definition.description?.length ?? 0).toBeGreaterThan(0);
    expect(tool.definition.description!.length).toBeLessThanOrEqual(300);
    const schema = tool.definition.input_schema as { properties: Record<string, { description: string }>; required: string[] };
    expect(Object.keys(schema.properties)).toEqual(['orgId']);
    expect(schema.required).toEqual(['orgId']);
    expect(schema.properties.orgId!.description.length).toBeLessThanOrEqual(160);
  });

  it('refuses an org outside the caller\'s access without reading', async () => {
    const out = await run({ orgId: OTHER });
    expect(out.error).toBeTruthy();
    expect(dbm.rows).toEqual([]);
  });

  it('refuses a malformed orgId', async () => {
    expect((await run({ orgId: 'nope' })).error).toBeTruthy();
  });

  it('a never-created page reports exists: false and inserts nothing', async () => {
    dbm.rows = [[]];
    const out = await run({ orgId: ORG });
    expect(out).toEqual({
      exists: false, published: false, publishedAt: null, publicPath: null, lastEvaluatedAt: null, stale: false,
      controls: null, declarations: { current: 0, expiringWithin30Days: 0 }, accessRequests: { pendingApproval: 0 },
    });
    expect(dbm.insert).not.toHaveBeenCalled();
    expect(dbm.update).not.toHaveBeenCalled();
  });

  it('a published page returns its public path, freshness and the current snapshot counts', async () => {
    const publishedAt = new Date(NOW - 3 * 86_400_000);
    const lastEvaluatedAt = new Date(NOW - 3600_000);
    dbm.rows = [
      [{ id: 'pg1', publishedAt, lastEvaluatedAt, isPartnerHome: false, orgSlug: 'acme', partnerId: 'p1' }],
      [{ payload }],
      [{ current: 3, expiringWithin30Days: 1 }],
      [{ pendingApproval: 2 }],
      [{ slug: 'nw', trustState: 'trusted' }],
    ];
    const out = await run({ orgId: ORG });
    expect(out).toEqual({
      exists: true, published: true, publishedAt: publishedAt.toISOString(), publicPath: '/portal/trust/nw/acme',
      lastEvaluatedAt: lastEvaluatedAt.toISOString(), stale: false,
      controls: { shown: 12, met: 9, catalogTotal: 16 },
      declarations: { current: 3, expiringWithin30Days: 1 }, accessRequests: { pendingApproval: 2 },
    });
    expect(dbm.insert).not.toHaveBeenCalled();
    // Only the partner slug (already public, in the URL) is read under system scope.
    expect(dbm.systemReads).toBe(1);
  });

  it('a partner-home page reports the partner path; an evaluation older than 24 h is stale', async () => {
    dbm.rows = [
      [{ id: 'pg1', publishedAt: new Date(NOW - 86_400_000 * 5), lastEvaluatedAt: new Date(NOW - 25 * 3600_000), isPartnerHome: true, orgSlug: 'acme', partnerId: 'p1' }],
      [{ payload }], [{ current: 0, expiringWithin30Days: 0 }], [{ pendingApproval: 0 }], [{ slug: 'nw', trustState: 'trusted' }],
    ];
    const out = await run({ orgId: ORG });
    expect(out.publicPath).toBe('/portal/trust/nw');
    expect(out.stale).toBe(true);
  });

  it('a draft (unpublished) page has no public path and no stale flag', async () => {
    dbm.rows = [
      [{ id: 'pg1', publishedAt: null, lastEvaluatedAt: null, isPartnerHome: false, orgSlug: 'acme', partnerId: 'p1' }],
      [], [{ current: 0, expiringWithin30Days: 0 }], [{ pendingApproval: 0 }],
    ];
    const out = await run({ orgId: ORG });
    expect(out).toMatchObject({ exists: true, published: false, publicPath: null, stale: false, controls: null });
    expect(dbm.systemReads).toBe(0);
  });

  it.each([
    ['a restricted partner', { slug: 'nw', trustState: 'restricted' }],
    ['a probation partner under enforcement', { slug: 'nw', trustState: 'probation' }],
    ['a reserved partner slug', { slug: 'preview', trustState: 'trusted' }],
  ])('published but not served (%s) → published:true, publicPath:null', async (_label, partner) => {
    dbm.rows = [
      [{ id: 'pg1', publishedAt: new Date(NOW - 86_400_000), lastEvaluatedAt: new Date(NOW), isPartnerHome: false, orgSlug: 'acme', partnerId: 'p1' }],
      [{ payload }], [{ current: 0, expiringWithin30Days: 0 }], [{ pendingApproval: 0 }], [partner],
    ];
    const out = await run({ orgId: ORG });
    expect(out).toMatchObject({ published: true, publicPath: null });
  });

  it('a DB failure is a generic tool error, logged and sent to Sentry', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    dbm.fail = new Error('relation missing');
    const out = await run({ orgId: ORG });
    expect(out.error).toMatch(/Operation failed/);
    expect(sentry.captureException).toHaveBeenCalledWith(expect.objectContaining({ message: 'relation missing' }), undefined, { tool: 'get_trust_page_status' });
    err.mockRestore();
  });

  it('system scope may read any org', async () => {
    dbm.rows = [[]];
    const out = await run({ orgId: OTHER }, auth({ scope: 'system', canAccessOrg: () => false } as Partial<AuthContext>));
    expect(out.exists).toBe(false);
  });
});
