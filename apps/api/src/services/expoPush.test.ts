import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendExpoPush, buildApprovalPush } from './expoPush';

describe('buildApprovalPush', () => {
  it('limits the body to client label + action label only', () => {
    const msg = buildApprovalPush({
      approvalId: 'a1',
      actionLabel: 'Delete 4 devices in Acme Corp',
      requestingClientLabel: 'Claude Desktop',
    });
    expect(msg.title).toBe('Approval requested');
    expect(msg.body).toBe('Claude Desktop: Delete 4 devices in Acme Corp');
    expect(msg.data).toEqual({ type: 'approval', approvalId: 'a1' });
    expect(msg.priority).toBe('high');
    expect(msg.ttl).toBe(60);
  });
});

describe('sendExpoPush', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => vi.unstubAllGlobals());

  it('returns [] when given no messages without hitting the network', async () => {
    const tickets = await sendExpoPush([]);
    expect(tickets).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('POSTs to the Expo Push endpoint and returns tickets', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ status: 'ok', id: 'tk1' }] }),
    } as unknown as Response);

    const tickets = await sendExpoPush([
      { to: 'ExponentPushToken[abc]', title: 't', body: 'b' },
    ]);
    expect(tickets).toEqual([{ status: 'ok', id: 'tk1' }]);
    expect(fetch).toHaveBeenCalledWith(
      'https://exp.host/--/api/v2/push/send',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('throws when Expo returns non-2xx', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'oops',
    } as unknown as Response);
    await expect(
      sendExpoPush([{ to: 'ExponentPushToken[abc]', title: 't', body: 'b' }])
    ).rejects.toThrow(/Expo push failed: 500/);
  });
});
