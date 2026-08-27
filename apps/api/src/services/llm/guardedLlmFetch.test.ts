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

import { buildGuardedLlmFetch, LlmEgressViolationError } from './guardedLlmFetch';

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

  it('always forces redirect:"error" on the safeFetch call, even when the caller passes redirect:"follow"', async () => {
    const fetchImpl = buildGuardedLlmFetch({ allowedOrigin: ALLOWED_ORIGIN, recordEgress: vi.fn() });

    await fetchImpl(`${ALLOWED_ORIGIN}/v1/messages`, { method: 'GET', redirect: 'follow' });

    const [, calledInit] = safeFetchMock.mock.calls[0]!;
    expect((calledInit as RequestInit).redirect).toBe('error');
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

  it('invokes the recorder with the host on a same-origin request', async () => {
    const recordEgress = vi.fn();
    const fetchImpl = buildGuardedLlmFetch({ allowedOrigin: ALLOWED_ORIGIN, recordEgress });

    await fetchImpl(`${ALLOWED_ORIGIN}/v1/messages`);

    expect(recordEgress).toHaveBeenCalledTimes(1);
    expect(recordEgress).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'openrouter.ai' }),
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

    expect(recordEgress).toHaveBeenCalledWith({ host: 'openrouter.ai', resolvedIp: '93.184.216.34' });
  });

  it('records resolvedIp: null when safeFetch never calls onConnect (e.g. it rejected before connecting)', async () => {
    safeFetchMock.mockRejectedValueOnce(new Error('boom'));
    const recordEgress = vi.fn();
    const fetchImpl = buildGuardedLlmFetch({ allowedOrigin: ALLOWED_ORIGIN, recordEgress });

    await fetchImpl(`${ALLOWED_ORIGIN}/v1/messages`).catch(() => {});

    expect(recordEgress).toHaveBeenCalledWith({ host: 'openrouter.ai', resolvedIp: null });
  });

  it('does not invoke the recorder for a cross-origin request that never reached safeFetch', async () => {
    const recordEgress = vi.fn();
    const fetchImpl = buildGuardedLlmFetch({ allowedOrigin: ALLOWED_ORIGIN, recordEgress });

    await fetchImpl('https://evil.example.com/x').catch(() => {});

    expect(recordEgress).not.toHaveBeenCalled();
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
