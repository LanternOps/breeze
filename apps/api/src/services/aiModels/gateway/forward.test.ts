import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rec = vi.hoisted(() => ({ events: [] as unknown[] }));
vi.mock('../../llm/llmEgressRecorder', () => ({ recordLlmEgressEvent: (e: unknown) => rec.events.push(e) }));
const env = vi.hoisted(() => ({ hosted: true }));
vi.mock('./byoEndpointPolicy', async (orig) => ({
  ...(await orig<typeof import('./byoEndpointPolicy')>()),
  byoEgressAllowances: () => ({ allowPrivateNetwork: !env.hosted, requirePrivateForCleartext: true }),
}));

import { __setLookupForTests, assertSafeUrl, SsrfBlockedError } from '../../urlSafety';
import { __setUpstreamFetchForTests, forwardUpstream, readUpstreamErrorText } from './forward';
import type { GatewayGrantRecord } from './types';

const grant = (over: Partial<GatewayGrantRecord> = {}): GatewayGrantRecord => ({
  id: 'g1',
  config: { source: 'gateway', kind: 'openai_compatible', partnerId: 'p1', connectionId: 'c1', configVersion: 1, baseUrl: 'https://llm.example.com/v1' },
  credential: { secret: 'sk-secret-123456' },
  wireModels: new Set(['m1']), orgId: 'o1', aiSessionId: 's1', purpose: 'dispatch',
  expiresAt: Number.MAX_SAFE_INTEGER, inFlight: new Set(),
  ...over,
});

describe('forwardUpstream', () => {
  beforeEach(() => { rec.events.length = 0; env.hosted = true; });
  afterEach(() => { __setUpstreamFetchForTests(null); __setLookupForTests(null); vi.restoreAllMocks(); });

  it('dials through safeFetch with the deployment allowances, size cap, no redirects and the connection audit', async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    __setUpstreamFetchForTests((async (url: string, init: Record<string, unknown>) => {
      calls.push([url, init]);
      (init.onConnect as (ip: string) => void)('93.184.216.34');
      return new Response('{}', { status: 200 });
    }) as never);
    await forwardUpstream(grant(), { url: 'https://llm.example.com/v1/chat/completions', method: 'POST', headers: {}, body: '{}', stream: true }, new AbortController().signal);
    expect(calls[0]![1]).toMatchObject({
      allowPrivateNetwork: false, requirePrivateForCleartext: true, streamResponse: true,
      maxBytes: 32 * 1024 * 1024, redirect: 'error',
    });
    expect(rec.events).toEqual([expect.objectContaining({
      orgId: 'o1', partnerId: 'p1', surface: 'gateway_forward', host: 'llm.example.com',
      resolvedIp: '93.184.216.34', blocked: false, connectionId: 'c1', aiSessionId: 's1',
    })]);
  });

  it('a caller may lower the response cap (discovery: 1 MiB) but never raise it past the gateway ceiling', async () => {
    const caps: unknown[] = [];
    __setUpstreamFetchForTests((async (_u: string, init: Record<string, unknown>) => { caps.push(init.maxBytes); return new Response('{}'); }) as never);
    const get = (maxBytes?: number) => forwardUpstream(grant(), { url: 'https://llm.example.com/v1/models', method: 'GET', headers: {}, stream: false, maxBytes }, new AbortController().signal);
    await get(1024 * 1024);
    await get(1024 * 1024 * 1024);
    await get();
    expect(caps).toEqual([1024 * 1024, 32 * 1024 * 1024, 32 * 1024 * 1024]);
  });

  it('refuses an off-origin URL before dialling (adapters cannot be tricked into another host)', async () => {
    const spy = vi.fn();
    __setUpstreamFetchForTests(spy as never);
    await expect(forwardUpstream(grant(), { url: 'https://evil.example.net/v1/chat/completions', method: 'POST', headers: {}, stream: false }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'gateway_origin_mismatch', status: 502 });
    expect(spy).not.toHaveBeenCalled();
    expect(rec.events).toEqual([expect.objectContaining({ blocked: true, host: 'evil.example.net' })]);
  });

  it('refuses userinfo or a path outside the connection base path, before dialling', async () => {
    const spy = vi.fn();
    __setUpstreamFetchForTests(spy as never);
    for (const url of [
      'https://u:p@llm.example.com/v1/models',
      'https://llm.example.com/admin/models',
      'https://llm.example.com/v10/models',
      'not a url',
    ]) {
      await expect(forwardUpstream(grant(), { url, method: 'GET', headers: {}, stream: false }, new AbortController().signal))
        .rejects.toMatchObject({ code: 'gateway_origin_mismatch', status: 502 });
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('re-resolves and refuses a rebinding host (private on hosted) with a 502 and a blocked audit row', async () => {
    // Authoring time: the name resolved to a public address and passed the policy.
    __setLookupForTests(async () => [{ address: '93.184.216.34', family: 4 }]);
    await expect(assertSafeUrl('https://llm.example.com/v1', { allowPrivateNetwork: false })).resolves.toBeUndefined();
    // Dispatch time: the same name now rebinds to a private address.
    __setLookupForTests(async () => [{ address: '10.0.0.9', family: 4 }]);
    await expect(forwardUpstream(grant(), { url: 'https://llm.example.com/v1/models', method: 'GET', headers: {}, stream: false }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'egress_blocked', status: 502 });
    expect(rec.events).toEqual([expect.objectContaining({ blocked: true, resolvedIp: null })]);
  });

  it('never forwards a caller-supplied Authorization; sets its own from the credential', async () => {
    let sent: Record<string, string> = {};
    __setUpstreamFetchForTests((async (_u: string, init: { headers: Record<string, string> }) => { sent = init.headers; return new Response('{}'); }) as never);
    await forwardUpstream(grant(), { url: 'https://llm.example.com/v1/models', method: 'GET', headers: { authorization: 'Bearer stolen', 'x-api-key': 'x', cookie: 'c', 'Proxy-Authorization': 'p', 'x-forwarded-host': 'h' }, stream: false }, new AbortController().signal);
    expect(sent.authorization).toBe('Bearer sk-secret-123456');
    expect(sent['x-api-key']).toBeUndefined();
    expect(sent.cookie).toBeUndefined();
    expect(sent['proxy-authorization']).toBeUndefined();
    expect(sent['x-forwarded-host']).toBeUndefined();
  });

  it('keyless connection sends no Authorization header at all', async () => {
    let sent: Record<string, string> = {};
    __setUpstreamFetchForTests((async (_u: string, init: { headers: Record<string, string> }) => { sent = init.headers; return new Response('{}'); }) as never);
    await forwardUpstream(grant({ credential: { secret: null } }), { url: 'https://llm.example.com/v1/models', method: 'GET', headers: {}, stream: false }, new AbortController().signal);
    expect('authorization' in sent).toBe(false);
  });

  it('skips the audit row (with a one-time warning) when there is no org (partner-level verification)', async () => {
    __setUpstreamFetchForTests((async () => new Response('{}')) as never);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await forwardUpstream(grant({ orgId: null, purpose: 'verification' }), { url: 'https://llm.example.com/v1/models', method: 'GET', headers: {}, stream: false }, new AbortController().signal);
    await forwardUpstream(grant({ orgId: null, purpose: 'verification' }), { url: 'https://llm.example.com/v1/models', method: 'GET', headers: {}, stream: false }, new AbortController().signal);
    expect(rec.events).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('maps an SsrfBlockedError / ResponseTooLarge to GatewayErrors without the resolved IPs', async () => {
    __setUpstreamFetchForTests((async () => { throw new SsrfBlockedError('all resolved IPs for x are private', { hostname: 'x', resolvedIps: ['10.9.9.9'] }); }) as never);
    const err = await forwardUpstream(grant(), { url: 'https://llm.example.com/v1/models', method: 'GET', headers: {}, stream: false }, new AbortController().signal).then(() => null, (e: unknown) => e as Error);
    expect(err).not.toBeNull();
    expect(err!.message).not.toContain('10.9.9.9');
    expect(err).toMatchObject({ code: 'egress_blocked', status: 502 });
  });

  it('refuses an upstream redirect (never follows it) and releases the body', async () => {
    const cancel = vi.fn(async () => {});
    __setUpstreamFetchForTests((async () => {
      const res = new Response('moved', { status: 302, headers: { location: 'http://169.254.169.254/' } });
      vi.spyOn(res.body!, 'cancel').mockImplementation(cancel);
      return res;
    }) as never);
    await expect(forwardUpstream(grant(), { url: 'https://llm.example.com/v1/models', method: 'GET', headers: {}, stream: true }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'upstream_redirect', status: 502 });
    expect(cancel).toHaveBeenCalled();
  });

  it('scrubs the key from an echoed upstream error', async () => {
    // Deliberately NOT a generic key shape (no sk-/Bearer), so only the exact-secret scrub can catch it.
    const key = 'live9f8e7d6c5b4a3210zzQQ';
    const g = grant({ credential: { secret: key } });
    __setUpstreamFetchForTests((async () => new Response(
      JSON.stringify({ error: { message: `Incorrect API key provided: ${key}. Encoded: ${encodeURIComponent(key)} tail ${key.slice(-12)}` } }),
      { status: 401 },
    )) as never);
    const res = await forwardUpstream(g, { url: 'https://llm.example.com/v1/models', method: 'GET', headers: {}, stream: false }, new AbortController().signal);
    expect(res.status).toBe(401);
    const text = await readUpstreamErrorText(res, g);
    expect(text).toContain('Incorrect API key provided');
    expect(text).not.toContain(key);
    expect(text).not.toContain(key.slice(-12));
    expect(text).toContain('[redacted]');
    expect(text.length).toBeLessThanOrEqual(300);
  });

  it('readUpstreamErrorText reads only a bounded prefix of a huge error body', async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > 1000) { controller.close(); return; }
        controller.enqueue(new Uint8Array(64 * 1024).fill(0x61));
      },
    });
    const text = await readUpstreamErrorText(new Response(body, { status: 500 }), grant());
    expect(text.length).toBeLessThanOrEqual(300);
    expect(pulled).toBeLessThan(10);
  });
});
