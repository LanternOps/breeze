import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG_ID = '22222222-2222-4222-8222-222222222222';
const FOREIGN_ORG_ID = '99999999-9999-4999-8999-999999999999';
const PARTNER_ID = '33333333-3333-4333-8333-333333333333';
const DEVICE_ID = '55555555-5555-4555-8555-555555555555';
const ALERT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ALERT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  execute: vi.fn(),
  accessibleOrgIds: [] as string[],
}));
vi.mock('../../db', () => ({
  db: { select: mocks.select, execute: mocks.execute },
  hasDbAccessContext: () => true,
}));
vi.mock('../../config/env', () => ({
  PARTNER_API_CURSOR_SIGNING_KEY: Buffer.from('0123456789abcdef0123456789abcdef', 'utf8'),
}));
vi.mock('../../middleware/partnerApiAuth', () => ({
  partnerApiAuthMiddleware: async (c: any, next: any) => {
    if (c.req.header('X-API-Key') !== 'test-key') return c.json({ error: 'authentication required' }, 401);
    c.set('partnerApiPrincipal', {
      partnerId: PARTNER_ID,
      accessibleOrgIds: mocks.accessibleOrgIds,
      scopes: (c.req.header('X-Test-Scopes') ?? '').split(',').filter(Boolean),
    });
    return next();
  },
  requirePartnerApiScope: (...required: string[]) => async (c: any, next: any) => {
    const principal = c.get('partnerApiPrincipal');
    return required.every((scope) => principal.scopes.includes(scope))
      ? next()
      : c.json({ error: 'scope required' }, 403);
  },
}));

import { partnerApiRoutes } from './index';
import { partnerAlertFeedEnvelopeSchema } from './schemas';

type QueryResult = unknown[] | Error;
let selectResults: QueryResult[] = [];
let whereArgs: unknown[] = [];
function query(result: QueryResult) {
  const promise = result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
  const builder: any = {
    from: vi.fn(() => builder),
    leftJoin: vi.fn(() => builder),
    where: vi.fn((arg: unknown) => { whereArgs.push(arg); return builder; }),
    orderBy: vi.fn(() => builder),
    limit: vi.fn(() => promise),
  };
  return builder;
}

function alertRow(id: string, changeXid: string, overrides: Record<string, unknown> = {}) {
  return {
    id, orgId: ORG_ID, deviceId: DEVICE_ID, deviceHostname: 'app-01',
    severity: 'high', status: 'active', title: 'CPU high', message: 'CPU over 90%',
    triggeredAt: new Date('2026-09-23T12:00:00.000Z'), acknowledgedAt: null, resolvedAt: null,
    dismissedAt: null, suppressedUntil: null, requiresHuman: false,
    episodeId: null, ruleId: null, monitorId: null, changeXid,
    ...overrides,
  };
}

function request(path: string, scope = 'alerts:read') {
  return app.request(path, { headers: { 'X-API-Key': 'test-key', 'X-Test-Scopes': scope } });
}

let app: Hono;
describe('partner alerts feed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectResults = [];
    whereArgs = [];
    mocks.accessibleOrgIds = [ORG_ID, OTHER_ORG_ID];
    mocks.select.mockImplementation(() => query(selectResults.shift() ?? []));
    mocks.execute.mockResolvedValue([{ horizon: '1000', xmax: '1005', epoch: '7688900532099108902:1:16384:24601' }]);
    app = new Hono();
    app.route('/', partnerApiRoutes);
  });

  it('requires alerts:read — devices:read is not enough', async () => {
    const res = await request('/alerts', 'devices:read');
    expect(res.status).toBe(403);
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it('full sync: returns the typed record, no raw context, and a checkpoint on the last page', async () => {
    selectResults = [[alertRow(ALERT_A, '900')]];
    const res = await request('/alerts');
    expect(res.status).toBe(200);
    const body = partnerAlertFeedEnvelopeSchema.parse(await res.json());
    expect(body.mode).toBe('full');
    expect(body.hasMore).toBe(false);
    expect(body.nextCursor).toBeNull();
    expect(body.checkpoint).toEqual(expect.any(String));
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({
      id: ALERT_A, orgId: ORG_ID, deviceId: DEVICE_ID, deviceHostname: 'app-01',
      severity: 'high', status: 'active', title: 'CPU high', changeVersion: '900',
      triggeredAt: '2026-09-23T12:00:00.000Z',
    });
    expect(body.data[0]).not.toHaveProperty('context');
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });

  it('pages with a signed cursor that pins the traversal window', async () => {
    selectResults = [[alertRow(ALERT_A, '900'), alertRow(ALERT_B, '950')]];
    const first = partnerAlertFeedEnvelopeSchema.parse(await (await request('/alerts?limit=1')).json());
    expect(first.hasMore).toBe(true);
    expect(first.checkpoint).toBeNull();
    expect(first.data.map((r) => r.id)).toEqual([ALERT_A]);

    selectResults = [[alertRow(ALERT_B, '950')]];
    const second = partnerAlertFeedEnvelopeSchema.parse(
      await (await request(`/alerts?limit=1&cursor=${encodeURIComponent(first.nextCursor!)}`)).json(),
    );
    expect(second.data.map((r) => r.id)).toEqual([ALERT_B]);
    expect(second.hasMore).toBe(false);
    expect(second.checkpoint).toEqual(expect.any(String));
  });

  it('incremental sync from a checkpoint', async () => {
    selectResults = [[]];
    const first = partnerAlertFeedEnvelopeSchema.parse(await (await request('/alerts')).json());
    mocks.execute.mockResolvedValue([{ horizon: '1200', xmax: '1210', epoch: '7688900532099108902:1:16384:24601' }]);
    selectResults = [[alertRow(ALERT_A, '1100', { status: 'resolved' })]];
    const res = await request(`/alerts?since=${encodeURIComponent(first.checkpoint!)}`);
    expect(res.status).toBe(200);
    const body = partnerAlertFeedEnvelopeSchema.parse(await res.json());
    expect(body.mode).toBe('incremental');
    expect(body.data[0]!.status).toBe('resolved');
  });

  it('409 resync when the accessible org set changed since the checkpoint', async () => {
    selectResults = [[]];
    const first = partnerAlertFeedEnvelopeSchema.parse(await (await request('/alerts')).json());
    mocks.accessibleOrgIds = [ORG_ID, OTHER_ORG_ID, '44444444-4444-4444-8444-444444444444'];
    const res = await request(`/alerts?since=${encodeURIComponent(first.checkpoint!)}`);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('partner_alerts_resync_required');
  });

  it('409 resync when the checkpoint is beyond the database xid range (restored database)', async () => {
    selectResults = [[]];
    const first = partnerAlertFeedEnvelopeSchema.parse(await (await request('/alerts')).json());
    mocks.execute.mockResolvedValue([{ horizon: '10', xmax: '20', epoch: '7688900532099108902:1:16384:24601' }]);
    const res = await request(`/alerts?since=${encodeURIComponent(first.checkpoint!)}`);
    expect(res.status).toBe(409);
  });

  it('409 resync when the database incarnation changed (restore / point-in-time recovery)', async () => {
    selectResults = [[]];
    const first = partnerAlertFeedEnvelopeSchema.parse(await (await request('/alerts')).json());
    // Same xid range, new timeline: without the epoch binding this would silently skip rows.
    mocks.execute.mockResolvedValue([{ horizon: '1500', xmax: '1510', epoch: '7688900532099108902:2:16384:24601' }]);
    const res = await request(`/alerts?since=${encodeURIComponent(first.checkpoint!)}`);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('partner_alerts_resync_required');
  });

  it.each([
    ['database recreated in the same cluster (new database OID)', '7688900532099108902:1:16999:24601'],
    ['alerts table recreated by an in-place logical restore (new table OID)', '7688900532099108902:1:16384:25999'],
  ])('409 resync when the %s', async (_label, epoch) => {
    selectResults = [[]];
    const first = partnerAlertFeedEnvelopeSchema.parse(await (await request('/alerts')).json());
    // Same cluster identifier, timeline and xid range: only the OIDs reveal the restore.
    mocks.execute.mockResolvedValue([{ horizon: '1500', xmax: '1510', epoch }]);
    const res = await request(`/alerts?since=${encodeURIComponent(first.checkpoint!)}`);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('partner_alerts_resync_required');
  });

  it('409 when a page cursor crosses a database incarnation change', async () => {
    selectResults = [[alertRow(ALERT_A, '900'), alertRow(ALERT_B, '950')]];
    const first = partnerAlertFeedEnvelopeSchema.parse(await (await request('/alerts?limit=1')).json());
    mocks.execute.mockResolvedValue([{ horizon: '1000', xmax: '1005', epoch: '1111:1:16384:24601' }]);
    const res = await request(`/alerts?limit=1&cursor=${encodeURIComponent(first.nextCursor!)}`);
    expect(res.status).toBe(409);
  });

  it('emits a null deviceId (not a foreign device id) when the device is not in the alert org', async () => {
    // The route joins devices on id AND org_id, so a mismatched row yields null device columns.
    selectResults = [[alertRow(ALERT_A, '900', { deviceId: null, deviceHostname: null })]];
    const body = partnerAlertFeedEnvelopeSchema.parse(await (await request('/alerts')).json());
    expect(body.data[0]!.deviceId).toBeNull();
    expect(body.data[0]!.deviceHostname).toBeNull();
  });

  it('accepts DB-valid non-BMP titles/hostnames (UTF-16 length up to 2x the varchar limit)', async () => {
    selectResults = [[alertRow(ALERT_A, '900', { title: '🔥'.repeat(500), deviceHostname: '🖥'.repeat(255) })]];
    const res = await request('/alerts');
    expect(res.status).toBe(200);
    const body = partnerAlertFeedEnvelopeSchema.parse(await res.json());
    expect(body.data.length + (body.blocked?.length ?? 0)).toBe(1);
    expect(body.checkpoint).toEqual(expect.any(String));
  });

  it('never splits a surrogate pair when truncating a message', async () => {
    // 'a' shifts the pairs so the 11,999-unit cut would land mid-emoji.
    selectResults = [[alertRow(ALERT_A, '900', { message: `a${'🔥 '.repeat(6_000)}` })]];
    const body = partnerAlertFeedEnvelopeSchema.parse(await (await request('/alerts')).json());
    const message = body.data[0]?.message ?? '';
    expect(message.length).toBeLessThanOrEqual(12_000);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(message)).toBe(false);
  });

  it('revision ignores the hostname enrichment', async () => {
    selectResults = [[alertRow(ALERT_A, '900', { deviceHostname: 'old-name' })]];
    const a = partnerAlertFeedEnvelopeSchema.parse(await (await request('/alerts')).json());
    selectResults = [[alertRow(ALERT_A, '900', { deviceHostname: 'new-name' })]];
    const b = partnerAlertFeedEnvelopeSchema.parse(await (await request('/alerts')).json());
    expect(a.data[0]!.revision).toBe(b.data[0]!.revision);
  });

  it('truncates an oversized message instead of failing the page', async () => {
    selectResults = [[alertRow(ALERT_A, '900', { message: 'Disk C: free space below threshold on the file server. '.repeat(1_000) })]];
    const res = await request('/alerts');
    expect(res.status).toBe(200);
    const body = partnerAlertFeedEnvelopeSchema.parse(await res.json());
    expect(body.data[0]!.message!.length).toBe(12_000);
    expect(body.blocked).toBeUndefined();
    expect(body.checkpoint).toEqual(expect.any(String));
  });

  it('400 when a checkpoint is replayed with different filters', async () => {
    selectResults = [[]];
    const first = partnerAlertFeedEnvelopeSchema.parse(await (await request('/alerts?status=active')).json());
    const res = await request(`/alerts?status=resolved&since=${encodeURIComponent(first.checkpoint!)}`);
    expect(res.status).toBe(400);
  });

  it('400 when a checkpoint is passed as a page cursor (kinds are not interchangeable)', async () => {
    selectResults = [[]];
    const first = partnerAlertFeedEnvelopeSchema.parse(await (await request('/alerts')).json());
    const res = await request(`/alerts?cursor=${encodeURIComponent(first.checkpoint!)}`);
    expect(res.status).toBe(400);
  });

  it('rejects a tampered token', async () => {
    selectResults = [[]];
    const first = partnerAlertFeedEnvelopeSchema.parse(await (await request('/alerts')).json());
    const [payload, sig] = first.checkpoint!.split('.');
    // Flip the first signature character to a guaranteed-different value (the
    // signature varies per run, so a fixed overwrite could be a no-op).
    const tampered = `${payload}.${sig![0] === 'A' ? 'B' : 'A'}${sig!.slice(1)}`;
    expect(tampered).not.toBe(first.checkpoint);
    const res = await request(`/alerts?since=${encodeURIComponent(tampered)}`);
    expect(res.status).toBe(400);
  });

  it('400 for since+cursor together, unsupported status, or unknown params', async () => {
    for (const path of ['/alerts?since=a.b&cursor=a.b', '/alerts?status=open', '/alerts?status=', '/alerts?foo=1']) {
      expect((await request(path)).status, path).toBe(400);
    }
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it('404 for an org outside the principal', async () => {
    const res = await request(`/alerts?orgId=${FOREIGN_ORG_ID}`);
    expect(res.status).toBe(404);
    expect(mocks.select).not.toHaveBeenCalled();
  });

  it('withholds a record whose message carries a secret and reports it as blocked', async () => {
    selectResults = [[
      alertRow(ALERT_A, '900', { message: 'token ghp_1234567890abcdefghijklmnopqrstuvwxyzAB leaked' }),
      alertRow(ALERT_B, '901'),
    ]];
    const body = partnerAlertFeedEnvelopeSchema.parse(await (await request('/alerts')).json());
    expect(body.data.map((r) => r.id)).toEqual([ALERT_B]);
    expect(body.blocked).toEqual([expect.objectContaining({ resource: 'alerts', id: ALERT_A, reason: 'secret_detected' })]);
  });

  it('delivers an alert whose only secret-shaped field is the hostname, with the hostname dropped', async () => {
    // A rename never restamps the alert, so blocking on the hostname would lose the alert for good.
    selectResults = [[
      alertRow(ALERT_A, '900', { deviceHostname: 'ghp_1234567890abcdefghijklmnopqrstuvwxyzAB' }),
    ]];
    const body = partnerAlertFeedEnvelopeSchema.parse(await (await request('/alerts')).json());
    expect(body.blocked).toBeUndefined();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({ id: ALERT_A, deviceHostname: null });
    expect(JSON.stringify(body)).not.toContain('ghp_1234567890');
  });

  it('still blocks when the alert itself carries a secret alongside a secret-shaped hostname', async () => {
    selectResults = [[
      alertRow(ALERT_A, '900', {
        deviceHostname: 'ghp_1234567890abcdefghijklmnopqrstuvwxyzAB',
        message: 'token ghp_abcdefghijklmnopqrstuvwxyz1234567890AB leaked',
      }),
    ]];
    const body = partnerAlertFeedEnvelopeSchema.parse(await (await request('/alerts')).json());
    expect(body.data).toEqual([]);
    expect(body.blocked).toEqual([expect.objectContaining({ id: ALERT_A, reason: 'secret_detected' })]);
  });

  it('an empty org set still returns a checkpoint without querying alerts', async () => {
    mocks.accessibleOrgIds = [];
    const body = partnerAlertFeedEnvelopeSchema.parse(await (await request('/alerts')).json());
    expect(body.data).toEqual([]);
    expect(body.checkpoint).toEqual(expect.any(String));
    expect(mocks.select).not.toHaveBeenCalled();
  });
});
