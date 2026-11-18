import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tool Catalog W05 (#5220) Task A6 — the public flow webhook router. It has
 * no auth middleware (the signature / token is the authentication, verified
 * in services/flows/webhook/ingest.ts), never caches, and turns a thrown
 * ingest failure into a retryable 503 without logging the request headers.
 */

vi.mock('../services/flows/webhook/ingest', () => ({ ingestFlowWebhook: vi.fn() }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));

import { ingestFlowWebhook } from '../services/flows/webhook/ingest';
import { captureException } from '../services/sentry';
import { flowWebhookRoutes } from './flowWebhooks';

const FLOW = '33333333-3333-4333-8333-333333333333';
const post = (headers: Record<string, string> = {}, body = '{"a":1}') =>
  flowWebhookRoutes.request(`/${FLOW}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });

beforeEach(() => {
  vi.mocked(ingestFlowWebhook).mockReset().mockResolvedValue({ http: 202, body: { status: 'accepted', runId: 'r1', deliveryId: 'd1' } });
  vi.mocked(captureException).mockReset();
});

describe('flowWebhookRoutes', () => {
  it('no auth middleware runs (no Authorization needed)', async () => {
    const res = await post();
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: 'accepted', runId: 'r1', deliveryId: 'd1' });
  });

  it('passes the raw body bytes, the headers and the flow id to the ingress', async () => {
    const raw = '{ "b" : 2 }';
    await post({ 'x-breeze-signature': 'sha256=abc' }, raw);
    const call = vi.mocked(ingestFlowWebhook).mock.calls[0]![0];
    expect(call.flowId).toBe(FLOW);
    expect(call.rawBody).toBe(raw);
    expect(call.headers.get('x-breeze-signature')).toBe('sha256=abc');
    expect(call.receivedAt).toBeInstanceOf(Date);
  });

  it('response is no-store on every outcome', async () => {
    expect((await post()).headers.get('Cache-Control')).toBe('no-store');
    vi.mocked(ingestFlowWebhook).mockResolvedValueOnce({ http: 401, body: { error: 'Unauthorized' } });
    const denied = await post();
    expect(denied.status).toBe(401);
    expect(denied.headers.get('Cache-Control')).toBe('no-store');
  });

  it('a refusal carries Retry-After', async () => {
    vi.mocked(ingestFlowWebhook).mockResolvedValueOnce({ http: 429, body: { status: 'refused', code: 'rate_limited' }, retryAfterSec: 42 });
    const res = await post();
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('42');
  });

  it('a thrown ingest failure is a retryable 503 and never logs the headers', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(ingestFlowWebhook).mockRejectedValueOnce(new Error('db down'));
    const res = await post({ 'x-breeze-webhook-token': 'bwh_SUPERSECRET' });
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('30');
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(err.mock.calls)).not.toContain('bwh_SUPERSECRET');
    expect(JSON.stringify(vi.mocked(captureException).mock.calls)).not.toContain('bwh_SUPERSECRET');
    err.mockRestore();
  });

  it('only POST is routed', async () => {
    expect((await flowWebhookRoutes.request(`/${FLOW}`)).status).toBe(404);
    expect(ingestFlowWebhook).not.toHaveBeenCalled();
  });
});
