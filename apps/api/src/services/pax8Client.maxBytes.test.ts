import { describe, expect, it, vi } from 'vitest';

const safeFetchMock = vi.hoisted(() => vi.fn());
vi.mock('./urlSafety', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./urlSafety')>()),
  safeFetch: safeFetchMock,
}));

import { Pax8Client } from './pax8Client';

describe('Pax8Client default fetch', () => {
  it('forwards maxBytes to safeFetch', async () => {
    safeFetchMock.mockResolvedValue(
      new Response(JSON.stringify({ content: [], page: 0, totalPages: 1 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const client = new Pax8Client({
      apiBaseUrl: 'https://api.pax8.com/v1',
      credentials: {
        clientId: 'id',
        clientSecret: 'secret',
        accessToken: 'tok',
        accessTokenExpiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    await client.listCompanies();

    expect(safeFetchMock).toHaveBeenCalledTimes(1);
    expect(safeFetchMock.mock.calls[0]![1].maxBytes).toBe(16 * 1024 * 1024);
  });
});
