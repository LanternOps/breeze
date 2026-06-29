import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./mailboxToken', () => ({ getMailboxToken: vi.fn(async () => 'tok') }));
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { probeMailbox } from './connectionService';

describe('probeMailbox', () => {
  beforeEach(() => fetchMock.mockReset());

  it('returns ok on a 200 from the mailbox messages endpoint', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ value: [] }) });
    const r = await probeMailbox('11111111-1111-1111-1111-111111111111', 'support@a.com');
    expect(r.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/users/support%40a.com/messages?%24top=1"),
      expect.objectContaining({ redirect: 'error' })
    );
  });

  it('returns an error string on 403 (access policy not scoped)', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403, text: async () => 'denied' });
    const r = await probeMailbox('11111111-1111-1111-1111-111111111111', 'support@a.com');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/403/);
  });
});
