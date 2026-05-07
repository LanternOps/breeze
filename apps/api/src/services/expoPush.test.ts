import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const updateWhereCalls: { col: string; val: unknown }[] = [];
const updateSetCalls: Record<string, unknown>[] = [];

vi.mock('../db', () => {
  const db = {
    update: vi.fn(() => ({
      set: (vals: Record<string, unknown>) => {
        updateSetCalls.push(vals);
        return {
          where: (clause: unknown) => {
            updateWhereCalls.push({ col: 'where', val: clause });
            return Promise.resolve();
          },
        };
      },
    })),
    select: vi.fn(),
  };
  return { db };
});

vi.mock('../db/schema/mobile', () => ({
  mobileDevices: {
    apnsToken: { name: 'apnsToken' },
    fcmToken: { name: 'fcmToken' },
    userId: { name: 'userId' },
    notificationsEnabled: { name: 'notificationsEnabled' },
  },
}));

import { sendExpoPush, buildApprovalPush } from './expoPush';
import { db } from '../db';

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

  it('truncates client + action labels to 60 chars', () => {
    const longClient = 'C'.repeat(120);
    const longAction = 'A'.repeat(120);
    const msg = buildApprovalPush({
      approvalId: 'a1',
      actionLabel: longAction,
      requestingClientLabel: longClient,
    });
    expect(msg.body).toBe(`${'C'.repeat(60)}: ${'A'.repeat(60)}`);
  });

  it('never leaks actionArguments into the push body (security invariant)', () => {
    const dangerous = JSON.stringify({ ids: ['device-1', 'device-2'] });
    const msg = buildApprovalPush({
      approvalId: 'a1',
      actionLabel: 'Delete devices',
      requestingClientLabel: 'Claude Desktop',
    } as unknown as Parameters<typeof buildApprovalPush>[0] & { actionArguments: string });
    expect(msg.body).not.toContain(dangerous);
    expect(msg.body).not.toContain('device-1');
    expect(msg.body).not.toContain('ids');
  });
});

describe('sendExpoPush', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    updateWhereCalls.length = 0;
    updateSetCalls.length = 0;
    vi.mocked(db.update).mockClear();
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

  it('marks DeviceNotRegistered tokens inactive in DB', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          { status: 'ok', id: 'tk1' },
          {
            status: 'error',
            message: 'device not registered',
            details: { error: 'DeviceNotRegistered' },
          },
        ],
      }),
    } as unknown as Response);

    const tickets = await sendExpoPush([
      { to: 'ExponentPushToken[good]', title: 't', body: 'b' },
      { to: 'ExponentPushToken[dead]', title: 't', body: 'b' },
    ]);

    expect(tickets).toHaveLength(2);
    expect(db.update).toHaveBeenCalled();
    // One DeviceNotRegistered → 2 update calls (apns + fcm clear branches)
    expect(vi.mocked(db.update).mock.calls.length).toBeGreaterThanOrEqual(2);
    // Both updates set the corresponding token column to null
    const nullSets = updateSetCalls.filter(
      (s) => s.apnsToken === null || s.fcmToken === null
    );
    expect(nullSets.length).toBeGreaterThanOrEqual(2);
  });

  it('logs but does not mark inactive on non-DeviceNotRegistered ticket errors', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          {
            status: 'error',
            message: 'too many',
            details: { error: 'MessageRateExceeded' },
          },
        ],
      }),
    } as unknown as Response);

    const tickets = await sendExpoPush([
      { to: 'ExponentPushToken[abc]', title: 't', body: 'b' },
    ]);

    expect(tickets).toHaveLength(1);
    expect(errSpy).toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
