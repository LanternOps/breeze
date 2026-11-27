import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ safeFetch: vi.fn() }));

vi.mock('../../urlSafety', async (orig) => ({
  ...(await orig<typeof import('../../urlSafety')>()),
  safeFetch: mocks.safeFetch,
}));

import { CoveJsonRpcClient } from './client';
import loginSuccess from './__fixtures__/login-success.json';

describe('CoveJsonRpcClient default fetch', () => {
  beforeEach(() => {
    mocks.safeFetch.mockReset();
  });

  it('forwards maxBytes to safeFetch', async () => {
    mocks.safeFetch.mockResolvedValueOnce(new Response(JSON.stringify(loginSuccess), { status: 200 }));
    const client = new CoveJsonRpcClient({ baseUrl: 'https://api.backup.management/jsonapi', delayMs: 0 });
    await client.login({ partnerName: 'Fabrikam MSP', username: 'api@fabrikam.example', password: 'pw' });
    expect(mocks.safeFetch.mock.calls[0]![1].maxBytes).toBe(32 * 1024 * 1024);
  });
});
