import { request as httpRequest } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rec = vi.hoisted(() => ({ events: [] as unknown[] }));
vi.mock('../../llm/llmEgressRecorder', () => ({ recordLlmEgressEvent: (e: unknown) => rec.events.push(e) }));

import { __resetGatewayAdaptersForTests, assertBoundModel, registerGatewayAdapter } from './adapter';
import { closeModelGateway, getModelGateway, startModelGateway, type ModelGateway } from './server';
import { GATEWAY_MAX_REQUEST_BYTES } from './limits';
import type { GatewayGrantInput } from './types';

const grantInput: GatewayGrantInput = {
  config: { source: 'gateway', kind: 'openai_compatible', partnerId: 'p1', connectionId: 'c1', configVersion: 1, baseUrl: 'https://x.example.com/v1' },
  credential: { secret: 'sk-secret-abcdef' }, wireModels: ['bound-model'], orgId: 'o1', aiSessionId: null, purpose: 'dispatch',
};

let gw: ModelGateway;
const seen: Array<{ path: string; body: string }> = [];
const forwarded: string[] = [];

beforeEach(async () => {
  rec.events.length = 0; seen.length = 0; forwarded.length = 0;
  __resetGatewayAdaptersForTests();
  registerGatewayAdapter({
    kind: 'openai_compatible', dialect: 'anthropic',
    sdkChildEnv: () => ({}),
    async handle(req, grant) {
      seen.push({ path: req.path, body: req.body.toString('utf8') });
      const body = JSON.parse(req.body.toString('utf8') || '{}') as { model?: unknown };
      if (req.path === '/v1/messages') assertBoundModel(grant, body.model);
      forwarded.push(req.path); // stands in for the upstream dial
      async function* chunks() { yield Buffer.from('event: ping\ndata: {}\n\n'); }
      return req.path === '/stream'
        ? { status: 200, headers: { 'content-type': 'text/event-stream' }, body: chunks() }
        : { status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from('{"ok":true}') };
    },
  });
  gw = await startModelGateway();
});
afterEach(async () => { await gw.close(); vi.restoreAllMocks(); });

const url = (token: string, path: string) => `http://127.0.0.1:${gw.port()}/g/${token}${path}`;

/** A request whose path is sent byte-for-byte (fetch normalises `..` away). */
function rawRequest(path: string, method = 'GET'): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: gw.port(), path, method }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on('error', reject);
    req.end();
  });
}

describe('model gateway server', () => {
  it('binds 127.0.0.1 only', async () => {
    expect(gw.port()).toBeGreaterThan(0);
    const { baseUrl } = gw.grant(grantInput);
    expect(baseUrl.startsWith(`http://127.0.0.1:${gw.port()}/g/`)).toBe(true);
  });

  it('routes an authenticated request to the kind adapter with the path after the token', async () => {
    const { token } = gw.grant(grantInput);
    const res = await fetch(url(token, '/v1/messages?beta=true'), { method: 'POST', body: JSON.stringify({ model: 'bound-model' }) });
    expect(res.status).toBe(200);
    expect(seen[0]!.path).toBe('/v1/messages');
  });

  it('401 with an Anthropic-shaped error for an unknown, expired or revoked token — no detail leaked', async () => {
    const res = await fetch(url('nope', '/v1/messages'), { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
    const expected = { type: 'error', error: { type: 'authentication_error', message: 'Invalid or expired gateway grant.' } };
    expect(await res.json()).toEqual(expected);
    const { token, revoke } = gw.grant(grantInput);
    revoke();
    const revoked = await fetch(url(token, '/v1/messages'), { method: 'POST', body: '{}' });
    expect(revoked.status).toBe(401);
    // Same body for a well-formed-but-revoked token as for garbage: no existence oracle.
    expect(await revoked.json()).toEqual(expected);
    expect(seen).toHaveLength(0);
  });

  it('refuses a model the grant does not bind: 403, blocked audit row, adapter never forwards', async () => {
    const { token } = gw.grant(grantInput);
    const res = await fetch(url(token, '/v1/messages'), { method: 'POST', body: JSON.stringify({ model: 'claude-opus-unpriced' }) });
    expect(res.status).toBe(403);
    expect((await res.json()).error.type).toBe('permission_error');
    expect(rec.events).toEqual([expect.objectContaining({ blocked: true, surface: 'gateway_forward', connectionId: 'c1', host: 'x.example.com' })]);
    expect(forwarded).toHaveLength(0);
  });

  it('enforces the bound model centrally for the anthropic dialect even if an adapter forgets', async () => {
    registerGatewayAdapter({ kind: 'openai_compatible', dialect: 'anthropic', sdkChildEnv: () => ({}),
      handle: async (req) => { forwarded.push(req.path); return { status: 200, headers: {}, body: Buffer.from('{}') }; } });
    const { token } = gw.grant(grantInput);
    const res = await fetch(url(token, '/v1/messages/count_tokens'), { method: 'POST', body: JSON.stringify({ model: 'other-model' }) });
    expect(res.status).toBe(403);
    expect(forwarded).toHaveLength(0);
    expect(rec.events).toEqual([expect.objectContaining({ blocked: true })]);
  });

  it('413 for a body over the cap, without reading it all', async () => {
    const { token } = gw.grant(grantInput);
    // Declared over the cap: answered before the body is sent (only 1 KiB ever is).
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({
        host: '127.0.0.1', port: gw.port(), path: `/g/${token}/v1/messages`, method: 'POST',
        headers: { 'content-length': String(GATEWAY_MAX_REQUEST_BYTES + 1) },
      }, (res) => { res.resume(); resolve(res.statusCode ?? 0); req.destroy(); });
      req.on('error', (e) => { if (!req.destroyed) reject(e); });
      req.write(Buffer.alloc(1024));
    });
    expect(status).toBe(413);
    // Undeclared (chunked) and over the cap: cut off once the running total passes it.
    const chunked = await new Promise<number | 'reset'>((resolve) => {
      const req = httpRequest({ host: '127.0.0.1', port: gw.port(), path: `/g/${token}/v1/messages`, method: 'POST' },
        (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on('error', () => resolve('reset'));
      const chunk = Buffer.alloc(1024 * 1024);
      let sent = 0;
      const pump = (): void => {
        while (sent <= GATEWAY_MAX_REQUEST_BYTES) {
          sent += chunk.length;
          if (!req.write(chunk)) { req.once('drain', pump); return; }
        }
        req.end();
      };
      pump();
    });
    expect([413, 'reset']).toContain(chunked);
    expect(seen).toHaveLength(0);
  });

  it('rejects path traversal and encoded slashes in the token segment', async () => {
    const { token } = gw.grant(grantInput);
    expect(await rawRequest(`/g/${token}/../admin`)).toBe(400);
    expect(await rawRequest(`/g/${token}/v1/%2e%2e/admin`)).toBe(400);
    expect((await fetch(`http://127.0.0.1:${gw.port()}/g/${token}%2F..%2Fx/v1/messages`, { method: 'POST', body: '{}' })).status).toBe(401);
    expect(await rawRequest('/admin')).toBe(400);
    expect(seen).toHaveLength(0);
  });

  it('streams an adapter iterable body through unchanged', async () => {
    const { token } = gw.grant(grantInput);
    const res = await fetch(url(token, '/stream'), { method: 'POST', body: '{}' });
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(await res.text()).toBe('event: ping\ndata: {}\n\n');
  });

  it('429 beyond the per-grant concurrency limit', async () => {
    const { token } = gw.grant(grantInput);
    // Saturate with requests the fake adapter never finishes:
    registerGatewayAdapter({ kind: 'openai_compatible', dialect: 'anthropic', sdkChildEnv: () => ({}),
      handle: (req) => new Promise((_, reject) => req.signal.addEventListener('abort', () => reject(new Error('aborted')))) });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const pending = Array.from({ length: 8 }, () => fetch(url(token, '/v1/x'), { method: 'POST', body: '{}' }).catch(() => null));
    await new Promise((r) => setTimeout(r, 50));
    expect((await fetch(url(token, '/v1/x'), { method: 'POST', body: '{}' })).status).toBe(429);
    gw.revoke(token);
    await Promise.all(pending);
  });

  it('a GatewayError thrown by an adapter becomes its status + Anthropic envelope; an unexpected error becomes 502 with no internals', async () => {
    const logged: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
    registerGatewayAdapter({ kind: 'openai_compatible', dialect: 'anthropic', sdkChildEnv: () => ({}),
      handle: async () => { throw new Error('ECONNREFUSED 10.0.0.1:443 sk-secret-abcdef'); } });
    const { token } = gw.grant(grantInput);
    const res = await fetch(url(token, '/v1/messages'), { method: 'POST', body: JSON.stringify({ model: 'bound-model' }) });
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).not.toContain('sk-secret-abcdef');
    expect(text).not.toContain('10.0.0.1');
    expect(logged.join('\n')).not.toContain('sk-secret-abcdef');
  });

  it('getModelGateway is a lazy singleton and closeModelGateway resets it', async () => {
    const a = await getModelGateway();
    const b = await getModelGateway();
    expect(a).toBe(b);
    await closeModelGateway();
    const c = await getModelGateway();
    expect(c).not.toBe(a);
    await closeModelGateway();
  });
});
