import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../c2cM365', () => ({
  isM365TenantId: (x: string) => /^[0-9a-f-]{36}$/i.test(x),
  acquireClientCredentialsToken: vi.fn(async () => ({ accessToken: 'tok-1', expiresIn: 3600 })),
}));

import { acquireClientCredentialsToken } from '../c2cM365';
import { getMailboxToken, _clearMailboxTokenCache } from './mailboxToken';

const TENANT = '11111111-1111-1111-1111-111111111111';

describe('getMailboxToken', () => {
  beforeEach(() => {
    _clearMailboxTokenCache();
    vi.mocked(acquireClientCredentialsToken).mockClear();
    process.env.TICKET_MAILBOX_M365_CLIENT_ID = 'cid';
    process.env.TICKET_MAILBOX_M365_CLIENT_SECRET = 'csecret';
  });

  it('acquires once and caches within the freshness window', async () => {
    const a = await getMailboxToken(TENANT);
    const b = await getMailboxToken(TENANT);
    expect(a).toBe('tok-1');
    expect(b).toBe('tok-1');
    expect(acquireClientCredentialsToken).toHaveBeenCalledTimes(1);
  });

  it('rejects a non-GUID tenant id', async () => {
    await expect(getMailboxToken('common')).rejects.toThrow(/tenant id/i);
  });

  it('throws when app creds are not configured', async () => {
    delete process.env.TICKET_MAILBOX_M365_CLIENT_ID;
    await expect(getMailboxToken(TENANT)).rejects.toThrow(/not configured/i);
  });
});
