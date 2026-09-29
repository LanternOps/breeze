import { createServer } from 'node:http';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startCaptureProxy, type CaptureProxy } from './captureProxy';

const SSE = [
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":900,"cache_creation_input_tokens":41000,"cache_read_input_tokens":0,"output_tokens":1}}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":42}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
].join('');

let upstream: ReturnType<typeof createServer>; let upstreamUrl: string; let proxy: CaptureProxy;
let seenAuth: string | undefined;
let seenRequest: { method?: string; path?: string; host?: string; body: string };

beforeAll(async () => {
  upstream = createServer((req, res) => {
    seenAuth = req.headers['x-api-key'] as string | undefined;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      seenRequest = { method: req.method, path: req.url, host: req.headers.host, body: Buffer.concat(chunks).toString() };
      if (req.url?.startsWith('/json')) {
        res.writeHead(201, { 'content-type': 'application/json', 'x-upstream': 'forwarded' });
        res.end(JSON.stringify({ usage: { input_tokens: 12, cache_read_input_tokens: 5, output_tokens: 3 } }));
        return;
      }
      if (req.url === '/gzip' || req.url === '/br') {
        const encoded = req.url === '/gzip' ? gzipSync(SSE) : brotliCompressSync(SSE);
        res.writeHead(200, { 'content-type': 'text/event-stream', 'content-encoding': req.url.slice(1) });
        res.end(encoded);
        return;
      }
      if (req.url === '/invalid') {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end('not json');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(SSE);
    });
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  proxy = await startCaptureProxy(upstreamUrl);
});
afterAll(async () => {
  await proxy.close();
  await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
});

describe('startCaptureProxy', () => {
  it('forwards the request, streams the response back, and records tools/system/usage', async () => {
    proxy.setLabel('chat/on');
    const body = {
      model: 'claude-sonnet-5', system: [{ type: 'text', text: 'x'.repeat(100) }],
      tools: [{ name: 'a' }, { name: 'b', defer_loading: true }],
      messages: [{ role: 'user', content: [{ type: 'tool_reference', tool_name: 'b' }] }],
    };
    const res = await fetch(`${proxy.url}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'k', 'anthropic-beta': 'tool-search-2026-01-01' }, body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(SSE);
    expect(seenAuth).toBe('k');
    const [rec] = proxy.records();
    expect(rec).toMatchObject({
      label: 'chat/on', path: '/v1/messages', model: 'claude-sonnet-5', betaHeader: 'tool-search-2026-01-01', status: 200,
      tools: [{ name: 'a', deferLoading: false }, { name: 'b', deferLoading: true }], toolReferenceCount: 1,
      usage: { inputTokens: 900, cacheCreationInputTokens: 41000, cacheReadInputTokens: 0, outputTokens: 42 },
    });
    expect(rec!.systemBytes).toBeGreaterThan(100);
    expect(rec!.ttfbMs).toBeGreaterThanOrEqual(0);
  });

  it('preserves method, query, body and response headers, replacing host and capturing JSON usage', async () => {
    proxy.setLabel('json');
    const body = JSON.stringify({
      system: 'é', tools: [null, { name: 'a', defer_loading: false }],
      messages: [{ role: 'user', content: [{ type: 'tool_result', content: [
        { type: 'tool_reference', tool_name: 'a' }, { type: 'tool_reference', tool_name: 'b' },
      ] }] }],
    });
    const res = await fetch(`${proxy.url}/json?beta=true`, {
      method: 'PUT', headers: { 'content-type': 'application/json', 'x-api-key': 'secret-key' }, body,
    });
    expect(res.status).toBe(201);
    expect(res.headers.get('x-upstream')).toBe('forwarded');
    expect(await res.json()).toEqual({ usage: { input_tokens: 12, cache_read_input_tokens: 5, output_tokens: 3 } });
    expect(seenRequest).toEqual({ method: 'PUT', path: '/json?beta=true', host: new URL(upstreamUrl).host, body });
    const record = proxy.records().at(-1)!;
    expect(record).toMatchObject({
      label: 'json', path: '/json?beta=true', model: null, betaHeader: null,
      systemBytes: JSON.stringify('é').length, tools: [{ name: 'a', deferLoading: false }],
      toolReferenceCount: 2, status: 201,
      usage: { inputTokens: 12, cacheCreationInputTokens: 0, cacheReadInputTokens: 5, outputTokens: 3 },
    });
    expect(new Date(record.at).toISOString()).toBe(record.at);
    expect(JSON.stringify(record)).not.toContain('secret-key');
  });

  it('forwards malformed JSON without crashing or inventing usage', async () => {
    const res = await fetch(`${proxy.url}/invalid`, { method: 'POST', body: '{broken' });
    expect(res.status).toBe(400);
    expect(await res.text()).toBe('not json');
    expect(seenRequest.body).toBe('{broken');
    expect(proxy.records().at(-1)).toMatchObject({
      model: null, tools: [], systemBytes: 0, toolReferenceCount: 0, usage: null, status: 400,
    });
  });

  it('keeps the upstream base path when forwarding, instead of dropping it', async () => {
    const proxyWithBasePath = await startCaptureProxy(`${upstreamUrl}/anthropic`);
    try {
      const res = await fetch(`${proxyWithBasePath.url}/v1/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
      });
      await res.text();
      expect(seenRequest.path).toBe('/anthropic/v1/messages');
    } finally {
      await proxyWithBasePath.close();
    }
  });

  it('records a failed request (upstream unreachable) as a 502 with no invented usage, instead of dropping it', async () => {
    const deadProxy = await startCaptureProxy('http://127.0.0.1:1');
    try {
      deadProxy.setLabel('unreachable');
      const res = await fetch(`${deadProxy.url}/v1/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'x' }),
      });
      expect(res.status).toBe(502);
      const record = deadProxy.records().at(-1);
      expect(record).toMatchObject({ label: 'unreachable', status: 502, usage: null });
    } finally {
      await deadProxy.close();
    }
  });

  it.each(['gzip', 'br'])('reads usage from a %s-encoded response (the real API compresses) while forwarding the bytes untouched', async (encoding) => {
    proxy.setLabel(encoding);
    const res = await fetch(`${proxy.url}/${encoding}`, { method: 'POST', body: JSON.stringify({ model: 'm' }) });
    expect(res.status).toBe(200);
    // fetch transparently decodes, so the client saw the original stream.
    expect(await res.text()).toBe(SSE);
    expect(proxy.records().at(-1)).toMatchObject({
      label: encoding,
      usage: { inputTokens: 900, cacheCreationInputTokens: 41000, cacheReadInputTokens: 0, outputTokens: 42 },
    });
  });

  it('fingerprints tools, system and the first message so cache-prefix identity is comparable across sessions', async () => {
    const send = async (firstText: string, tools: unknown[]) => {
      const res = await fetch(`${proxy.url}/v1/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'm', system: [{ type: 'text', text: 'sys' }], tools,
          messages: [{ role: 'user', content: [{ type: 'text', text: firstText }] }, { role: 'assistant', content: 'x' }],
        }),
      });
      await res.text();
      return proxy.records().at(-1)!;
    };
    const one = await send('deferred: hudu__get_asset', [{ name: 'a' }]);
    const two = await send('deferred: itglue__get_document', [{ name: 'a' }]);
    const three = await send('deferred: hudu__get_asset', [{ name: 'a' }, { name: 'b', defer_loading: true }]);

    expect(one.prefixDigest.tools).toMatch(/^[0-9a-f]{16}$/);
    expect(two.prefixDigest.tools).toBe(one.prefixDigest.tools);
    expect(two.prefixDigest.system).toBe(one.prefixDigest.system);
    expect(two.prefixDigest.firstMessage).not.toBe(one.prefixDigest.firstMessage);
    expect(three.prefixDigest.tools).not.toBe(one.prefixDigest.tools);
    expect(three.prefixDigest.firstMessage).toBe(one.prefixDigest.firstMessage);
    expect(one.firstMessageBytes).toBe(JSON.stringify({ role: 'user', content: [{ type: 'text', text: 'deferred: hudu__get_asset' }] }).length);
    expect(JSON.stringify(proxy.records())).not.toContain('hudu__get_asset');
  });

  it('ignores cache_control markers, which the CLI moves to the newest block every request', async () => {
    const send = async (firstMessage: unknown, system: unknown) => {
      const res = await fetch(`${proxy.url}/v1/messages`, {
        method: 'POST', body: JSON.stringify({ model: 'm', system, tools: [{ name: 'a' }], messages: [firstMessage] }),
      });
      await res.text();
      return proxy.records().at(-1)!.prefixDigest;
    };
    const marked = await send(
      { role: 'user', content: [{ type: 'text', text: 'q', cache_control: { type: 'ephemeral' } }] },
      [{ type: 'text', text: 's', cache_control: { type: 'ephemeral' } }],
    );
    const unmarked = await send({ role: 'user', content: [{ type: 'text', text: 'q' }] }, [{ type: 'text', text: 's' }]);
    const changed = await send({ role: 'user', content: [{ type: 'text', text: 'q2' }] }, [{ type: 'text', text: 's' }]);
    expect(unmarked).toEqual(marked);
    expect(changed.firstMessage).not.toBe(marked.firstMessage);
  });

  it('leaves the fingerprint null for a request with no tools, system or messages', async () => {
    const res = await fetch(`${proxy.url}/v1/messages`, { method: 'POST', body: JSON.stringify({ model: 'm' }) });
    await res.text();
    expect(proxy.records().at(-1)).toMatchObject({
      prefixDigest: { tools: null, system: null, firstMessage: null }, firstMessageBytes: 0,
    });
  });
});
