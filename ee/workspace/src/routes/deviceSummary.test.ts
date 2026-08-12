import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceAuthContext, WorkspaceRouteEnv } from './adminGate';
import { createDeviceSummaryRoutes } from './deviceSummary';
import type { DeviceSummary } from '../services/deviceSummaryService';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DEVICE_ID = '44444444-4444-4444-8444-444444444444';
const USER_ID = '33333333-3333-4333-8333-333333333333';

function auth(overrides: Partial<WorkspaceAuthContext> = {}): WorkspaceAuthContext {
  return {
    user: { id: USER_ID },
    scope: 'system',
    accessibleOrgIds: null,
    ...overrides,
  };
}

function summary(overrides: Partial<DeviceSummary> = {}): DeviceSummary {
  return {
    deviceId: DEVICE_ID,
    indexedFiles: 7,
    visibleSources: 2,
    lastSuccessfulCrawlAt: new Date('2026-07-12T10:00:00.000Z'),
    lastActivityAt: new Date('2026-07-12T11:00:00.000Z'),
    ...overrides,
  };
}

function harness(authContext: WorkspaceAuthContext = auth()) {
  const summarize = vi.fn(async (_orgId: string, _deviceId: string) => summary() as DeviceSummary | null);
  const deviceSummaryService = { summarize };
  const app = new Hono<WorkspaceRouteEnv>();
  app.use('*', async (c, next) => {
    c.set('auth', authContext);
    await next();
  });
  app.route('/', createDeviceSummaryRoutes({ deviceSummaryService }));
  return { app, summarize };
}

function url(orgId: string | null = ORG_ID, deviceId = DEVICE_ID): string {
  const query = orgId === null ? '' : `?orgId=${orgId}`;
  return `/devices/${deviceId}/summary${query}`;
}

describe('device summary route', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns the aggregate summary for an admin of the requested org', async () => {
    const h = harness();
    const res = await h.app.request(url());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      deviceId: DEVICE_ID,
      indexedFiles: 7,
      visibleSources: 2,
      lastSuccessfulCrawlAt: '2026-07-12T10:00:00.000Z',
      lastActivityAt: '2026-07-12T11:00:00.000Z',
    });
    expect(h.summarize).toHaveBeenCalledWith(ORG_ID, DEVICE_ID);
  });

  // Disclosure boundary: the response body carries aggregates only. If the
  // handler ever spreads a service row instead of projecting these five
  // fields, this fails.
  it('returns exactly the five aggregate fields and no indexed detail', async () => {
    const h = harness();
    h.summarize.mockResolvedValue({
      ...summary(),
      // Fields a future service change might start returning; none may escape.
      ...({
        relPath: 'Finance/2026/payroll.xlsx',
        errorReason: 'SMB mount denied for \\\\fileserver\\payroll',
        statusDetail: 'auth failure',
        credentialEnc: 'ciphertext',
      } as unknown as Partial<DeviceSummary>),
    });
    const res = await h.app.request(url());
    const body = await res.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      'deviceId', 'indexedFiles', 'lastActivityAt', 'lastSuccessfulCrawlAt', 'visibleSources',
    ]);
    const serialized = JSON.stringify(body);
    for (const leak of ['payroll', 'fileserver', 'relPath', 'errorReason', 'statusDetail', 'ciphertext']) {
      expect(serialized).not.toContain(leak);
    }
  });

  it('reports zero rows as zeros and null timestamps, not an error', async () => {
    const h = harness();
    h.summarize.mockResolvedValue(summary({
      indexedFiles: 0,
      visibleSources: 0,
      lastSuccessfulCrawlAt: null,
      lastActivityAt: null,
    }));
    const res = await h.app.request(url());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      deviceId: DEVICE_ID,
      indexedFiles: 0,
      visibleSources: 0,
      lastSuccessfulCrawlAt: null,
      lastActivityAt: null,
    });
  });

  it('requires orgId', async () => {
    const h = harness();
    const res = await h.app.request(url(null));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'orgId is required' });
    expect(h.summarize).not.toHaveBeenCalled();
  });

  it('rejects organization-scope callers', async () => {
    const h = harness(auth({ scope: 'organization', accessibleOrgIds: [ORG_ID] }));
    const res = await h.app.request(url());
    expect(res.status).toBe(403);
    expect(h.summarize).not.toHaveBeenCalled();
  });

  it('allows a partner admin for an org inside accessibleOrgIds', async () => {
    const h = harness(auth({ scope: 'partner', accessibleOrgIds: [ORG_ID] }));
    const res = await h.app.request(url());
    expect(res.status).toBe(200);
    expect(h.summarize).toHaveBeenCalledWith(ORG_ID, DEVICE_ID);
  });

  it('rejects a partner admin for an org outside accessibleOrgIds', async () => {
    const h = harness(auth({ scope: 'partner', accessibleOrgIds: [OTHER_ORG_ID] }));
    const res = await h.app.request(url());
    expect(res.status).toBe(403);
    expect(h.summarize).not.toHaveBeenCalled();
  });

  it('fails closed for a partner admin carrying a null accessibleOrgIds', async () => {
    const h = harness(auth({ scope: 'partner', accessibleOrgIds: null }));
    const res = await h.app.request(url());
    expect(res.status).toBe(403);
    expect(h.summarize).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated caller', async () => {
    const app = new Hono<WorkspaceRouteEnv>();
    const summarize = vi.fn(async () => summary() as DeviceSummary | null);
    app.route('/', createDeviceSummaryRoutes({ deviceSummaryService: { summarize } }));
    const res = await app.request(url());
    expect(res.status).toBe(403);
    expect(summarize).not.toHaveBeenCalled();
  });

  // No existence oracle: a device in another org and a device that does not
  // exist must be byte-identical responses.
  it('answers a device/org mismatch and an unknown device identically', async () => {
    const h = harness();
    h.summarize.mockResolvedValue(null);
    const mismatch = await h.app.request(url(ORG_ID, DEVICE_ID));
    const unknown = await h.app.request(url(ORG_ID, '99999999-9999-4999-8999-999999999999'));
    expect(mismatch.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await mismatch.text()).toEqual(await unknown.text());
  });

  it('answers a malformed device id as the same 404 without touching the service', async () => {
    const h = harness();
    h.summarize.mockResolvedValue(null);
    const known = await h.app.request(url(ORG_ID, DEVICE_ID));
    const knownBody = await known.text();
    const malformed = await h.app.request(url(ORG_ID, 'not-a-uuid'));
    expect(malformed.status).toBe(404);
    expect(await malformed.text()).toEqual(knownBody);
    // Only the well-formed id reached the service; a malformed uuid must never
    // reach a uuid-typed column and surface as a 500.
    expect(h.summarize).toHaveBeenCalledTimes(1);
  });

  it('passes the gated orgId, never a caller-supplied body or header org', async () => {
    const h = harness(auth({ scope: 'partner', accessibleOrgIds: [ORG_ID] }));
    const res = await h.app.request(`${url()}&orgId=${OTHER_ORG_ID}`);
    // Hono returns the first value for a repeated query key; the gate and the
    // service must agree on it, and it must be the one that passed the gate.
    expect(res.status).toBe(200);
    expect(h.summarize).toHaveBeenCalledWith(ORG_ID, DEVICE_ID);
  });

  // The handler must query with the value the gate authorized, not with the
  // raw query string. adminGate normalizes (trims) the orgId, so re-reading
  // c.req.query('orgId') here would query with a different value than the one
  // that passed authorization.
  it('queries with the gate-normalized orgId, not the raw query value', async () => {
    const h = harness(auth({ scope: 'partner', accessibleOrgIds: [ORG_ID] }));
    const res = await h.app.request(`/devices/${DEVICE_ID}/summary?orgId=%20${ORG_ID}%20`);
    expect(res.status).toBe(200);
    expect(h.summarize).toHaveBeenCalledWith(ORG_ID, DEVICE_ID);
  });
});
