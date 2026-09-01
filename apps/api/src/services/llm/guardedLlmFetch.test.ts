import { afterEach, describe, expect, it, vi } from 'vitest';

const { safeFetchMock } = vi.hoisted(() => ({
  safeFetchMock: vi.fn(
    async (_url: string, _init?: RequestInit & { onConnect?: (ip: string) => void }) =>
      new Response('{}', { status: 200 }),
  ),
}));

vi.mock('../urlSafety', () => ({
  safeFetch: safeFetchMock,
}));

import {
  buildGuardedLlmFetch,
  DEFAULT_MAX_LLM_RESPONSE_BYTES,
  LlmEgressViolationError,
} from './guardedLlmFetch';

const ALLOWED_ORIGIN = 'https://openrouter.ai';

describe('buildGuardedLlmFetch', () => {
  afterEach(() => {
    safeFetchMock.mockReset();
    safeFetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
  });

  it('rejects a cross-origin URL without making any network call', async () => {
    const recordEgress = vi.fn();
    const fetchImpl = buildGuardedLlmFetch({ allowedOrigin: ALLOWED_ORIGIN, recordEgress });

    await expect(fetchImpl('https://evil.example.com/v1/messages')).rejects.toBeInstanceOf(
      LlmEgressViolationError,
    );
    expect(safeFetchMock).not.toHaveBeenCalled();
  });

  it('rejects a request whose origin was rewritten away from the pin, even via a Request object', async () => {
    const recordEgress = vi.fn();
    const fetchImpl = buildGuardedLlmFetch({ allowedOrigin: ALLOWED_ORIGIN, recordEgress });

    await expect(
      fetchImpl(new Request('http://169.254.169.254/latest/meta-data/')),
    ).rejects.toBeInstanceOf(LlmEgressViolationError);
    expect(safeFetchMock).not.toHaveBeenCalled();
  });

  it('carries the llm_egress_blocked code and a 502 status on the violation error', async () => {
    const fetchImpl = buildGuardedLlmFetch({ allowedOrigin: ALLOWED_ORIGIN, recordEgress: vi.fn() });
    const error = await fetchImpl('https://evil.example.com/x').catch((e) => e);
    expect(error).toBeInstanceOf(LlmEgressViolationError);
    expect(error.status).toBe(502);
    expect(error.code).toBe('llm_egress_blocked');
  });

  it('delegates a same-origin request to safeFetch with the caller init preserved', async () => {
    const fetchImpl = buildGuardedLlmFetch({ allowedOrigin: ALLOWED_ORIGIN, recordEgress: vi.fn() });

    await fetchImpl(`${ALLOWED_ORIGIN}/v1/messages`, { method: 'POST', body: '{"a":1}' });

    expect(safeFetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = safeFetchMock.mock.calls[0]!;
    expect(calledUrl).toBe(`${ALLOWED_ORIGIN}/v1/messages`);
    expect(calledInit).toMatchObject({ method: 'POST', body: '{"a":1}' });
  });

  it('never follows a 3xx: an off-origin Location is handed back unfollowed, with no second request', async () => {
    safeFetchMock.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { Location: 'https://evil.example.com/v1/messages' } }),
    );
    const fetchImpl = buildGuardedLlmFetch({ allowedOrigin: ALLOWED_ORIGIN, recordEgress: vi.fn() });

    const res = await fetchImpl(`${ALLOWED_ORIGIN}/v1/messages`, { method: 'GET', redirect: 'follow' });

    expect(safeFetchMock).toHaveBeenCalledTimes(1);
    // Two assertions, deliberately: the observable behaviour (one call, the 3xx
    // handed straight back) AND the mechanism that produces it. `safeFetch`
    // happens not to follow redirects today, so the behaviour assertion alone
    // stays green if `redirect: 'error'` is deleted from the call site — and
    // that flag is the only thing standing between a future fetch-backed
    // safeFetch and a silently followed off-origin Location.
    const [, calledInit] = safeFetchMock.mock.calls[0]!;
    expect((calledInit as { redirect?: RequestRedirect }).redirect).toBe('error');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://evil.example.com/v1/messages');
  });

  it('caps the buffered response body via safeFetch maxBytes by default', async () => {
    const fetchImpl = buildGuardedLlmFetch({ allowedOrigin: ALLOWED_ORIGIN, recordEgress: vi.fn() });

    await fetchImpl(`${ALLOWED_ORIGIN}/v1/messages`);

    const [, calledInit] = safeFetchMock.mock.calls[0]!;
    expect((calledInit as { maxBytes?: number }).maxBytes).toBe(DEFAULT_MAX_LLM_RESPONSE_BYTES);
    expect(DEFAULT_MAX_LLM_RESPONSE_BYTES).toBeGreaterThan(0);
  });

  it('honours an explicit maxResponseBytes ceiling and never lets a caller init override it', async () => {
    const fetchImpl = buildGuardedLlmFetch({
      allowedOrigin: ALLOWED_ORIGIN,
      recordEgress: vi.fn(),
      maxResponseBytes: 4096,
    });

    await fetchImpl(`${ALLOWED_ORIGIN}/v1/messages`, {
      maxBytes: Number.MAX_SAFE_INTEGER,
    } as RequestInit);

    const [, calledInit] = safeFetchMock.mock.calls[0]!;
    expect((calledInit as { maxBytes?: number }).maxBytes).toBe(4096);
  });

  it('returns the Response safeFetch resolved with', async () => {
    const body = JSON.stringify({ ok: true });
    safeFetchMock.mockResolvedValueOnce(new Response(body, { status: 201 }));
    const fetchImpl = buildGuardedLlmFetch({ allowedOrigin: ALLOWED_ORIGIN, recordEgress: vi.fn() });

    const res = await fetchImpl(`${ALLOWED_ORIGIN}/v1/messages`);
    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  it('propagates a safeFetch rejection to the caller', async () => {
    safeFetchMock.mockRejectedValueOnce(new Error('dns failure'));
    const fetchImpl = buildGuardedLlmFetch({ allowedOrigin: ALLOWED_ORIGIN, recordEgress: vi.fn() });

    await expect(fetchImpl(`${ALLOWED_ORIGIN}/v1/messages`)).rejects.toThrow('dns failure');
  });

  it('invokes the recorder with the host and blocked:false on a successful same-origin request', async () => {
    const recordEgress = vi.fn();
    const fetchImpl = buildGuardedLlmFetch({ allowedOrigin: ALLOWED_ORIGIN, recordEgress });

    await fetchImpl(`${ALLOWED_ORIGIN}/v1/messages`);

    expect(recordEgress).toHaveBeenCalledTimes(1);
    expect(recordEgress).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'openrouter.ai', blocked: false }),
    );
  });

  it('passes the resolved IP through to the recorder via safeFetch onConnect', async () => {
    safeFetchMock.mockImplementationOnce(async (_url, init) => {
      init?.onConnect?.('93.184.216.34');
      return new Response('{}', { status: 200 });
    });
    const recordEgress = vi.fn();
    const fetchImpl = buildGuardedLlmFetch({ allowedOrigin: ALLOWED_ORIGIN, recordEgress });

    await fetchImpl(`${ALLOWED_ORIGIN}/v1/messages`);

    expect(recordEgress).toHaveBeenCalledWith({
      host: 'openrouter.ai',
      resolvedIp: '93.184.216.34',
      blocked: false,
    });
  });

  it('records blocked:true when safeFetch refuses the connection (SSRF pin) — never a success row', async () => {
    safeFetchMock.mockRejectedValueOnce(new Error('URL points to blocked address: openrouter.ai'));
    const recordEgress = vi.fn();
    const fetchImpl = buildGuardedLlmFetch({ allowedOrigin: ALLOWED_ORIGIN, recordEgress });

    await fetchImpl(`${ALLOWED_ORIGIN}/v1/messages`).catch(() => {});

    expect(recordEgress).toHaveBeenCalledWith({
      host: 'openrouter.ai',
      resolvedIp: null,
      blocked: true,
    });
  });

  it('records a blocked event for a cross-origin request refused before any network call', async () => {
    const recordEgress = vi.fn();
    const fetchImpl = buildGuardedLlmFetch({ allowedOrigin: ALLOWED_ORIGIN, recordEgress });

    await fetchImpl('https://evil.example.com/x').catch(() => {});

    expect(safeFetchMock).not.toHaveBeenCalled();
    expect(recordEgress).toHaveBeenCalledTimes(1);
    expect(recordEgress).toHaveBeenCalledWith({
      host: 'evil.example.com',
      resolvedIp: null,
      blocked: true,
    });
  });

  it('records a blocked event for an unparseable target without throwing out of the recorder', async () => {
    const recordEgress = vi.fn();
    const fetchImpl = buildGuardedLlmFetch({ allowedOrigin: ALLOWED_ORIGIN, recordEgress });

    await fetchImpl('not-a-url').catch(() => {});

    expect(recordEgress).toHaveBeenCalledWith(
      expect.objectContaining({ resolvedIp: null, blocked: true }),
    );
  });

  it('does not fail the origin-pin refusal when the recorder throws', async () => {
    const recordEgress = vi.fn(() => {
      throw new Error('recorder blew up');
    });
    const fetchImpl = buildGuardedLlmFetch({ allowedOrigin: ALLOWED_ORIGIN, recordEgress });

    await expect(fetchImpl('https://evil.example.com/x')).rejects.toBeInstanceOf(
      LlmEgressViolationError,
    );
  });

  it('does not fail the request when the recorder throws', async () => {
    const recordEgress = vi.fn(() => {
      throw new Error('recorder blew up');
    });
    const fetchImpl = buildGuardedLlmFetch({ allowedOrigin: ALLOWED_ORIGIN, recordEgress });

    const res = await fetchImpl(`${ALLOWED_ORIGIN}/v1/messages`);
    expect(res.status).toBe(200);
    expect(recordEgress).toHaveBeenCalledTimes(1);
  });

  it('still propagates the safeFetch rejection when the recorder also throws', async () => {
    safeFetchMock.mockRejectedValueOnce(new Error('dns failure'));
    const recordEgress = vi.fn(() => {
      throw new Error('recorder blew up');
    });
    const fetchImpl = buildGuardedLlmFetch({ allowedOrigin: ALLOWED_ORIGIN, recordEgress });

    await expect(fetchImpl(`${ALLOWED_ORIGIN}/v1/messages`)).rejects.toThrow('dns failure');
  });
});
