import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rec = vi.hoisted(() => ({ events: [] as unknown[] }));
vi.mock('../../../llm/llmEgressRecorder', () => ({ recordLlmEgressEvent: (e: unknown) => rec.events.push(e) }));

import { ResponseTooLargeError, SsrfBlockedError } from '../../../urlSafety';
import { __setUpstreamFetchForTests } from '../forward';
import { DiscoveryTruncatedError, discoverOpenAiCompatibleModels, sanitizeDiscoveredModels } from './discovery';

const config = { source: 'gateway', kind: 'openai_compatible', partnerId: 'p', connectionId: 'c', configVersion: 1, baseUrl: 'https://llm.example.com/v1' } as const;
const KEY = 'sk-x-123456789';

beforeEach(() => { rec.events.length = 0; });
afterEach(() => { __setUpstreamFetchForTests(null); vi.restoreAllMocks(); });

describe('openai_compatible discovery', () => {
  it('GETs {base}/models with the bearer key, 1 MiB cap, no redirects, and returns sanitized ids', async () => {
    let seen: { url: string; init: Record<string, unknown> } | null = null;
    __setUpstreamFetchForTests((async (url: string, init: Record<string, unknown>) => {
      seen = { url, init };
      return Response.json({ object: 'list', data: [{ id: 'qwen2.5-coder:7b' }, { id: 'llama3.1:8b', name: 'Llama 3.1 8B' }] });
    }) as never);
    const models = await discoverOpenAiCompatibleModels({ config, credential: { secret: KEY } });
    expect(seen!.url).toBe('https://llm.example.com/v1/models');
    expect(seen!.init).toMatchObject({ method: 'GET', maxBytes: 1024 * 1024, streamResponse: false, redirect: 'error' });
    expect((seen!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    expect(models).toEqual([{ modelId: 'qwen2.5-coder:7b', displayName: null }, { modelId: 'llama3.1:8b', displayName: 'Llama 3.1 8B' }]);
  });

  it('a keyless connection lists without any Authorization header', async () => {
    let headers: Record<string, string> = {};
    __setUpstreamFetchForTests((async (_u: string, init: { headers: Record<string, string> }) => {
      headers = init.headers;
      return Response.json({ data: [{ id: 'a' }] });
    }) as never);
    await expect(discoverOpenAiCompatibleModels({ config, credential: { secret: null } })).resolves.toEqual([{ modelId: 'a', displayName: null }]);
    expect('authorization' in headers).toBe(false);
  });

  it('is a partner-level (org-less) discovery egress: never persisted under an invented org', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    __setUpstreamFetchForTests((async () => Response.json({ data: [{ id: 'a' }] })) as never);
    await discoverOpenAiCompatibleModels({ config, credential: { secret: KEY } });
    expect(rec.events).toEqual([]);
  });

  it('sanitize: a list beyond the cap throws (never a silently truncated inventory — Codex review #9)', () => {
    const over = { data: Array.from({ length: 501 }, (_, i) => ({ id: `m${i}` })) };
    expect(() => sanitizeDiscoveredModels(over)).toThrow(DiscoveryTruncatedError);
    expect(() => sanitizeDiscoveredModels(over)).toThrow(/more than 500/);
    expect(sanitizeDiscoveredModels({ data: Array.from({ length: 500 }, (_, i) => ({ id: `m${i}` })) })).toHaveLength(500);
  });

  it('sanitize: drops invalid ids, dedupes, strips control chars from names, caps name length', () => {
    const data = [
      { id: 'ok-1' }, { id: 'ok-1' }, { id: 'bad id' }, { id: '<img src=x>' }, { id: 42 }, null, 'str', { id: 'x'.repeat(201) },
      { id: 'named', name: `Evil\u0000\u001b[31m‮${'x'.repeat(300)}` },
      ...Array.from({ length: 100 }, (_, i) => ({ id: `m${i}` })),
    ];
    const out = sanitizeDiscoveredModels({ data });
    expect(out.length).toBe(102);
    expect(out.filter((m) => m.modelId === 'ok-1')).toHaveLength(1);
    expect(out.some((m) => m.modelId === 'bad id' || m.modelId === '<img src=x>')).toBe(false);
    const named = out.find((m) => m.modelId === 'named')!;
    expect(named.displayName!.length).toBeLessThanOrEqual(120);
    expect(named.displayName).not.toMatch(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/);
  });

  it('a long name carrying the key\'s base64 is dropped, judged on the FULL name before the length cut', async () => {
    const longKey = 'sk-live-partner-key-0123456789-abcdefghijklmnopqrstuvwxyz';
    const b64 = Buffer.from(longKey).toString('base64');
    // The encoding straddles the 120-char display cut: only a fragment would remain.
    const name = `${'Model '.repeat(17)}${b64}${'z'.repeat(300 - 102 - b64.length)}`;
    expect(name.length).toBe(300);
    __setUpstreamFetchForTests((async () => Response.json({ data: [{ id: 'a', name }, { id: 'b', name: 'Llama 3.1 8B' }] })) as never);
    const models = await discoverOpenAiCompatibleModels({ config, credential: { secret: longKey } });
    expect(models).toEqual([{ modelId: 'a', displayName: null }, { modelId: 'b', displayName: 'Llama 3.1 8B' }]);
    expect(sanitizeDiscoveredModels({ data: [{ id: 'a', name }] }, longKey)).toEqual([{ modelId: 'a', displayName: null }]);
  });

  it('sanitize: a whitespace-only or non-string name is null', () => {
    expect(sanitizeDiscoveredModels({ data: [{ id: 'a', name: '  \u0007 ' }, { id: 'b', name: { x: 1 } }] }))
      .toEqual([{ modelId: 'a', displayName: null }, { modelId: 'b', displayName: null }]);
  });

  it('accepts the bare-array shape some servers return', () => {
    expect(sanitizeDiscoveredModels([{ id: 'a' }])).toEqual([{ modelId: 'a', displayName: null }]);
  });

  it('sanitize: a wrong-shape payload throws', () => {
    for (const p of [null, 'x', 42, {}, { data: 'x' }, { data: { id: 'a' } }]) {
      expect(() => sanitizeDiscoveredModels(p)).toThrow(/model list/);
    }
  });

  it('non-2xx → throws a scrubbed, capped error (no key in the message)', async () => {
    __setUpstreamFetchForTests((async () => new Response(`bad key ${KEY} ${'y'.repeat(5000)}`, { status: 401 })) as never);
    const err = (await discoverOpenAiCompatibleModels({ config, credential: { secret: KEY } }).catch((e: unknown) => e)) as Error;
    expect(err.message).toMatch(/401/);
    expect(err.message).not.toContain(KEY);
    expect(err.message.length).toBeLessThanOrEqual(600);
  });

  it.each([401, 403])('HTTP %i → a fixed message; the upstream body (which may echo part of the key) is not kept', async (status) => {
    __setUpstreamFetchForTests((async () => new Response(
      'Incorrect API key provided: sk-x-1234****6789. You can find your key at https://example.test/keys',
      { status },
    )) as never);
    const err = (await discoverOpenAiCompatibleModels({ config, credential: { secret: KEY } }).catch((e: unknown) => e)) as Error;
    expect(err.message).toBe(`The endpoint rejected the connection's key (HTTP ${status} for /models).`);
  });

  it('other non-2xx statuses still carry the (scrubbed) upstream detail', async () => {
    __setUpstreamFetchForTests((async () => new Response('model registry offline', { status: 503 })) as never);
    const err = (await discoverOpenAiCompatibleModels({ config, credential: { secret: KEY } }).catch((e: unknown) => e)) as Error;
    expect(err.message).toContain('HTTP 503');
    expect(err.message).toContain('model registry offline');
  });

  it('a non-JSON or wrong-shape body → throws, never returns partial garbage', async () => {
    __setUpstreamFetchForTests((async () => new Response('<html>')) as never);
    await expect(discoverOpenAiCompatibleModels({ config, credential: { secret: null } })).rejects.toThrow(/model list/);
    __setUpstreamFetchForTests((async () => Response.json({ models: [{ id: 'a' }] })) as never);
    await expect(discoverOpenAiCompatibleModels({ config, credential: { secret: null } })).rejects.toThrow(/model list/);
  });

  it('a redirect, an oversize body, or a blocked address → throws (nothing returned)', async () => {
    __setUpstreamFetchForTests((async () => new Response('', { status: 302, headers: { location: 'http://169.254.169.254/' } })) as never);
    await expect(discoverOpenAiCompatibleModels({ config, credential: { secret: KEY } })).rejects.toThrow(/redirect/);
    __setUpstreamFetchForTests((async () => { throw new ResponseTooLargeError(1024 * 1024); }) as never);
    await expect(discoverOpenAiCompatibleModels({ config, credential: { secret: KEY } })).rejects.toThrow(/size limit/);
    __setUpstreamFetchForTests((async () => { throw new SsrfBlockedError('private', { hostname: 'x', resolvedIps: ['10.0.0.1'] }); }) as never);
    const err = (await discoverOpenAiCompatibleModels({ config, credential: { secret: KEY } }).catch((e: unknown) => e)) as Error;
    expect(err.message).toMatch(/address/);
    expect(err.message).not.toContain('10.0.0.1');
  });

  it('refuses a config whose base URL is unparseable (never dials)', async () => {
    const spy = vi.fn();
    __setUpstreamFetchForTests(spy as never);
    await expect(discoverOpenAiCompatibleModels({ config: { ...config, baseUrl: 'not a url' }, credential: { secret: KEY } })).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });
});
