import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => ({
  collectors: vi.fn(),
  create: vi.fn(),
  get: vi.fn(),
  cancel: vi.fn(),
  status: 200,
  capabilities: [] as string[],
}));

vi.mock('../../services/topology/originEligibility', async (original) => ({
  ...(await original<object>()),
  selectTopologyOrigins: mocks.collectors,
}));
vi.mock('../../services/topology/diagnosticRuns', async (original) => ({
  ...(await original<object>()),
  createTopologyDiagnosticRun: mocks.create,
  getTopologyDiagnosticRun: mocks.get,
  cancelTopologyDiagnosticRun: mocks.cancel,
}));
vi.mock('./middleware', () => ({
  requireTopologySiteCapability: (capability: string) => async (c: any, next: any) => {
    mocks.capabilities.push(capability);
    if (mocks.status !== 200) return c.json({ error: 'Denied' }, mocks.status);
    c.set('topologyContext', { scope: { siteId: c.req.param('siteId'), orgId: org } });
    await next();
  },
}));

import { topologyDiagnosticRoutes } from './diagnostics';
import { TopologyOperationError } from '../../services/topology/operationErrors';

const site = '00000000-0000-4000-8000-000000000001';
const org = '00000000-0000-4000-8000-000000000002';
const runId = '00000000-0000-4000-8000-000000000003';
const nodeId = '00000000-0000-4000-8000-000000000004';

const body = {
  recipeId: 'gateway_basic',
  recipeVersion: 1,
  subject: { kind: 'node', id: nodeId },
  graphRevision: '4',
};

function request(method: string, path: string, init: RequestInit = {}) {
  return new Hono()
    .route('/topology', topologyDiagnosticRoutes)
    .request(`/topology/sites/${site}${path}`, { method, ...init });
}

const post = (payload: unknown, headers: Record<string, string> = {}) =>
  request('POST', '/diagnostic-runs', {
    body: JSON.stringify(payload),
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'key-1', ...headers },
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.status = 200;
  mocks.capabilities.length = 0;
  mocks.collectors.mockResolvedValue([]);
  mocks.create.mockResolvedValue({ id: runId, state: 'queued' });
  mocks.get.mockResolvedValue({ id: runId, state: 'queued' });
  mocks.cancel.mockResolvedValue({ id: runId, state: 'cancelled' });
});

describe('topology diagnostics routes', () => {
  it('lists collectors for a read-capable caller and passes the parsed query through', async () => {
    const response = await request(
      'GET',
      `/collectors?recipe=gateway_basic&subjectKind=node&subjectId=${nodeId}&graphRevision=4&family=ipv4`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [], nextCursor: null });
    expect(mocks.capabilities).toEqual(['read']);
    expect(mocks.collectors).toHaveBeenCalledWith(
      { scope: { siteId: site, orgId: org } },
      {
        recipeId: 'gateway_basic',
        recipeVersion: 1,
        subject: { kind: 'node', id: nodeId },
        graphRevision: '4',
        family: 'ipv4',
      },
    );
  });

  it('tolerates the web client\'s ambient orgId on collectors and still refuses a foreign one', async () => {
    expect((await request('GET', `/collectors?recipe=gateway_basic&subjectKind=node&subjectId=${nodeId}&graphRevision=4&family=ipv4&orgId=${org}`)).status).toBe(200);
    expect(mocks.collectors).toHaveBeenCalledTimes(1);
    expect((await request('GET', `/collectors?recipe=gateway_basic&subjectKind=node&subjectId=${nodeId}&graphRevision=4&family=ipv4&orgId=10000000-0000-4000-8000-000000000002`)).status).toBe(400);
    expect(mocks.collectors).toHaveBeenCalledTimes(1);
  });
  it('rejects a collectors query that is missing its subject', async () => {
    const response = await request('GET', '/collectors?recipe=gateway_basic');
    expect(response.status).toBe(400);
    expect(mocks.collectors).not.toHaveBeenCalled();
  });

  it('accepts a run with 202 and requires the execute capability', async () => {
    const response = await post(body);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ id: runId, state: 'queued' });
    expect(mocks.capabilities).toEqual(['execute']);
    expect(mocks.create).toHaveBeenCalledWith(
      { scope: { siteId: site, orgId: org } },
      body,
      'key-1',
    );
  });

  it('refuses a run without an Idempotency-Key instead of inventing one', async () => {
    const response = await request('POST', '/diagnostic-runs', {
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'idempotency_key_required' });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('rejects an oversized Idempotency-Key', async () => {
    const response = await post(body, { 'Idempotency-Key': 'k'.repeat(256) });
    expect(response.status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('surfaces a quota refusal as 429 with Retry-After', async () => {
    mocks.create.mockRejectedValue(
      new TopologyOperationError('diagnostic_quota_exceeded', 429, 'Too many runs', 60),
    );
    const response = await post(body);
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('60');
  });

  it('returns 409 when the same key arrives with a different body', async () => {
    mocks.create.mockRejectedValue(
      new TopologyOperationError('idempotency_key_conflict', 409),
    );
    expect((await post(body)).status).toBe(409);
  });

  it('reads one run and hides an inaccessible id behind 404', async () => {
    expect((await request('GET', `/diagnostic-runs/${runId}`)).status).toBe(200);
    mocks.get.mockResolvedValue(null);
    const missing = await request('GET', `/diagnostic-runs/${runId}`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: 'diagnostic_run_not_found' });
  });

  it('cancels without requiring a request body', async () => {
    const response = await request('POST', `/diagnostic-runs/${runId}/cancel`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: runId, state: 'cancelled' });
    expect(mocks.cancel).toHaveBeenCalledWith({ scope: { siteId: site, orgId: org } }, runId);
  });

  it.each([
    ['GET', '/collectors?recipe=gateway_basic&subjectKind=node&subjectId=' + nodeId + '&graphRevision=4'],
    ['GET', `/diagnostic-runs/${runId}`],
    ['POST', `/diagnostic-runs/${runId}/cancel`],
  ] as const)('%s %s propagates a denied site', async (method, path) => {
    mocks.status = 404;
    expect((await request(method, path)).status).toBe(404);
  });

  it('never caches a diagnostic read', async () => {
    const response = await request('GET', `/diagnostic-runs/${runId}`);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  });
});
