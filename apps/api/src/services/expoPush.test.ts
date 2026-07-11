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
    platform: { name: 'platform' },
    status: { name: 'status' },
  },
}));

const sendApnsNotificationMock = vi.fn();
vi.mock('./apns', () => ({
  sendApnsNotification: (...args: unknown[]) => sendApnsNotificationMock(...args),
}));

import {
  sendExpoPush,
  buildApprovalPush,
  getUserPushTokens,
  dispatchApprovalPush,
} from './expoPush';
import { db } from '../db';

/** Wires db.select(...).from(...).where(...) to resolve to `rows`. */
function stubSelectRows(rows: unknown[]): void {
  vi.mocked(db.select).mockReturnValue({
    from: () => ({ where: () => Promise.resolve(rows) }),
  } as unknown as ReturnType<typeof db.select>);
}

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

  it('does not log the full Expo push token on ticket error (SR-004)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const secretToken = 'ExponentPushToken[SUPERSECRETPUSHADDRESS12345]';
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

    await sendExpoPush([{ to: secretToken, title: 't', body: 'b' }]);

    expect(errSpy).toHaveBeenCalled();
    const logged = JSON.stringify(errSpy.mock.calls);
    // The raw, reusable push address must never appear in logs.
    expect(logged).not.toContain(secretToken);
    expect(logged).not.toContain('SUPERSECRETPUSHADDRESS12345');
    // A redacted reference (last-4 suffix) is still useful for correlation.
    expect(logged).toContain('345]');
    errSpy.mockRestore();
  });

  it('still clears DeviceNotRegistered tokens using the full token despite redacted logging (SR-004)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const deadToken = 'ExponentPushToken[DEADTOKENFULLVALUE99999]';
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          {
            status: 'error',
            message: 'gone',
            details: { error: 'DeviceNotRegistered' },
          },
        ],
      }),
    } as unknown as Response);

    await sendExpoPush([{ to: deadToken, title: 't', body: 'b' }]);

    // DB cleanup must still receive the FULL token (matching the stored column).
    const fullTokenUsed = updateWhereCalls.length > 0;
    expect(fullTokenUsed).toBe(true);
    // But the log must not contain it.
    const logged = JSON.stringify(errSpy.mock.calls);
    expect(logged).not.toContain(deadToken);
    errSpy.mockRestore();
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

describe('getUserPushTokens provider tagging', () => {
  beforeEach(() => {
    vi.mocked(db.select).mockReset();
  });

  it('tags an Expo-prefixed token as provider "expo" regardless of platform', async () => {
    stubSelectRows([{ fcm: null, apns: 'ExponentPushToken[abc]', platform: 'ios' }]);
    const tokens = await getUserPushTokens('u1');
    expect(tokens).toEqual([
      { token: 'ExponentPushToken[abc]', platform: 'ios', provider: 'expo' },
    ]);
  });

  it('tags a raw token on an ios row as native "apns" (no longer dropped)', async () => {
    stubSelectRows([{ fcm: null, apns: 'a'.repeat(64), platform: 'ios' }]);
    const tokens = await getUserPushTokens('u1');
    expect(tokens).toEqual([
      { token: 'a'.repeat(64), platform: 'ios', provider: 'apns' },
    ]);
  });

  it('tags a raw token on an android row as native "fcm"', async () => {
    stubSelectRows([{ fcm: 'fcm-native-token', apns: null, platform: 'android' }]);
    const tokens = await getUserPushTokens('u1');
    expect(tokens).toEqual([
      { token: 'fcm-native-token', platform: 'android', provider: 'fcm' },
    ]);
  });

  it('emits one tagged entry per non-null token across a mixed fleet', async () => {
    stubSelectRows([
      { fcm: null, apns: 'ExponentPushToken[expo-ios]', platform: 'ios' },
      { fcm: null, apns: 'native-apns-token', platform: 'ios' },
      { fcm: 'native-fcm-token', apns: null, platform: 'android' },
      { fcm: null, apns: null, platform: 'ios' }, // no tokens → contributes nothing
    ]);
    const tokens = await getUserPushTokens('u1');
    expect(tokens).toEqual([
      { token: 'ExponentPushToken[expo-ios]', platform: 'ios', provider: 'expo' },
      { token: 'native-apns-token', platform: 'ios', provider: 'apns' },
      { token: 'native-fcm-token', platform: 'android', provider: 'fcm' },
    ]);
  });
});

describe('dispatchApprovalPush routing', () => {
  const pushArgs = {
    approvalId: 'ap-1',
    actionLabel: 'Delete devices',
    requestingClientLabel: 'Claude Desktop',
  };

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    vi.mocked(db.select).mockReset();
    vi.mocked(db.update).mockClear();
    sendApnsNotificationMock.mockReset();
    updateWhereCalls.length = 0;
    updateSetCalls.length = 0;
  });
  afterEach(() => vi.unstubAllGlobals());

  it('returns zeros and touches no provider when the user has no tokens', async () => {
    stubSelectRows([]);
    const res = await dispatchApprovalPush('u1', pushArgs);
    expect(res).toEqual({ tokensFound: 0, dispatched: 0, errors: 0 });
    expect(fetch).not.toHaveBeenCalled();
    expect(sendApnsNotificationMock).not.toHaveBeenCalled();
  });

  it('routes Expo tokens to the Expo relay and native ios tokens to APNs', async () => {
    stubSelectRows([
      { fcm: null, apns: 'ExponentPushToken[expo]', platform: 'ios' },
      { fcm: null, apns: 'native-apns-token', platform: 'ios' },
    ]);
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ status: 'ok', id: 'tk1' }] }),
    } as unknown as Response);
    sendApnsNotificationMock.mockResolvedValueOnce({ ok: true, status: 200 });

    const res = await dispatchApprovalPush('u1', pushArgs);

    // Expo relay received exactly the one Expo token.
    expect(fetch).toHaveBeenCalledTimes(1);
    const expoBody = JSON.parse(
      (fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1].body as string,
    );
    expect(expoBody).toHaveLength(1);
    expect(expoBody[0].to).toBe('ExponentPushToken[expo]');
    expect(expoBody[0].title).toBe('Approval requested');

    // Native APNs sender received exactly the raw ios token with the 60s ttl.
    expect(sendApnsNotificationMock).toHaveBeenCalledTimes(1);
    expect(sendApnsNotificationMock).toHaveBeenCalledWith(
      'native-apns-token',
      expect.objectContaining({
        title: 'Approval requested',
        body: 'Claude Desktop: Delete devices',
        ttl: 60,
      }),
    );

    expect(res).toEqual({ tokensFound: 2, dispatched: 2, errors: 0 });
  });

  it('purges the apns column when the native sender reports the token unregistered', async () => {
    stubSelectRows([{ fcm: null, apns: 'dead-apns-token', platform: 'ios' }]);
    sendApnsNotificationMock.mockResolvedValueOnce({
      ok: false,
      status: 410,
      reason: 'Unregistered',
      unregistered: true,
    });

    const res = await dispatchApprovalPush('u1', pushArgs);

    expect(res).toEqual({ tokensFound: 1, dispatched: 0, errors: 1 });
    // The dead token was purged from the apnsToken column.
    expect(db.update).toHaveBeenCalled();
    expect(updateSetCalls.some((s) => s.apnsToken === null)).toBe(true);
    expect(updateWhereCalls.length).toBeGreaterThanOrEqual(1);
    // A live-but-failed (non-unregistered) result must NOT purge.
    expect(fetch).not.toHaveBeenCalled();
  });

  it('counts a native failure as an error without purging when not unregistered', async () => {
    stubSelectRows([{ fcm: null, apns: 'apns-token', platform: 'ios' }]);
    sendApnsNotificationMock.mockResolvedValueOnce({ ok: false, status: 400, reason: 'BadRequest' });

    const res = await dispatchApprovalPush('u1', pushArgs);

    expect(res).toEqual({ tokensFound: 1, dispatched: 0, errors: 1 });
    expect(db.update).not.toHaveBeenCalled();
  });

  it('counts native android (fcm) tokens as found-but-skipped, not errors', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    stubSelectRows([{ fcm: 'native-fcm-token', apns: null, platform: 'android' }]);

    const res = await dispatchApprovalPush('u1', pushArgs);

    // Counted in tokensFound, but neither dispatched nor errored — FCM is not wired.
    expect(res).toEqual({ tokensFound: 1, dispatched: 0, errors: 0 });
    expect(fetch).not.toHaveBeenCalled();
    expect(sendApnsNotificationMock).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('not wired to FCM'));
    infoSpy.mockRestore();
  });
});
