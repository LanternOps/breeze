import { describe, expect, it } from 'vitest';
import { createTestHostApi } from './hostApi';

describe('createTestHostApi', () => {
  it('records an in-namespace request and returns the fake response', async () => {
    const { hostApi, requests } = createTestHostApi({
      extensionName: 'demo',
      respond: () => new Response('{"ok":true}', { status: 200 }),
    });

    const response = await hostApi.fetch('/api/v1/ext/demo/items?orgId=org-1', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer forged' },
      body: '{}',
    });

    expect(await response.json()).toEqual({ ok: true });
    expect(requests).toEqual([
      expect.objectContaining({
        path: '/api/v1/ext/demo/items?orgId=org-1',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
    ]);
  });

  it('applies the real host checks: out-of-namespace requests never reach respond', async () => {
    let called = false;
    const { hostApi, requests } = createTestHostApi({
      extensionName: 'demo',
      respond: () => {
        called = true;
        return new Response('{}');
      },
    });

    await expect(hostApi.fetch('/api/v1/devices')).rejects.toThrow(/refused/);
    await expect(hostApi.fetch('https://evil.example/api/v1/ext/demo/x')).rejects.toThrow(/refused/);
    expect(called).toBe(false);
    expect(requests).toEqual([]);
  });
});
