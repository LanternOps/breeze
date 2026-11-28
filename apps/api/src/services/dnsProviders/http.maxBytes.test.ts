import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ safeFetch: vi.fn() }));

vi.mock('../urlSafety', async (orig) => ({
  ...(await orig<typeof import('../urlSafety')>()),
  safeFetch: mocks.safeFetch,
}));

import { requestJson, DNS_PROVIDER_MAX_RESPONSE_BYTES } from './http';

describe('requestJson reply cap', () => {
  beforeEach(() => {
    mocks.safeFetch.mockReset();
    mocks.safeFetch.mockImplementation(async () => new Response('{}', { status: 200 }));
  });

  it('defaults to DNS_PROVIDER_MAX_RESPONSE_BYTES (16 MiB)', async () => {
    await requestJson('https://dns.example.test/x');
    expect(DNS_PROVIDER_MAX_RESPONSE_BYTES).toBe(16 * 1024 * 1024);
    expect(mocks.safeFetch.mock.calls[0]![1].maxBytes).toBe(16 * 1024 * 1024);
  });

  it('lets a caller raise the cap', async () => {
    await requestJson('https://dns.example.test/x', { maxBytes: 64 * 1024 * 1024 });
    expect(mocks.safeFetch.mock.calls[0]![1].maxBytes).toBe(64 * 1024 * 1024);
  });
});
