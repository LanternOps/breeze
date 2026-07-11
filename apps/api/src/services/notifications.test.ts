import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'crypto';

const isApnsConfiguredMock = vi.fn();
const sendApnsNotificationMock = vi.fn();
vi.mock('./apns', () => ({
  isApnsConfigured: () => isApnsConfiguredMock(),
  sendApnsNotification: (...args: unknown[]) => sendApnsNotificationMock(...args),
}));

const updateSetCalls: Record<string, unknown>[] = [];
const updateWhereCalls: unknown[] = [];
vi.mock('../db', () => ({
  db: {
    update: vi.fn(() => ({
      set: (vals: Record<string, unknown>) => {
        updateSetCalls.push(vals);
        return {
          where: (clause: unknown) => {
            updateWhereCalls.push(clause);
            return Promise.resolve();
          },
        };
      },
    })),
  },
}));

vi.mock('../db/schema', () => ({
  alerts: {},
  mobileDevices: { apnsToken: { name: 'apnsToken' } },
  organizationUsers: {},
  pushNotifications: {},
  users: {},
}));

import { sendAPNS, type PushPayload } from './notifications';
import { db } from '../db';

const payload: PushPayload = {
  title: 'Test alert',
  body: 'Body',
  data: { severity: 'high' },
  alertId: 'alert-1',
  eventType: 'alert.triggered',
};

describe('sendAPNS', () => {
  beforeEach(() => {
    isApnsConfiguredMock.mockReset();
    sendApnsNotificationMock.mockReset();
    vi.mocked(db.update).mockClear();
    updateSetCalls.length = 0;
    updateWhereCalls.length = 0;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns a stubbed result and never logs the raw token when APNs is not configured', async () => {
    isApnsConfiguredMock.mockReturnValue(false);
    const token = 'apns-sensitive-token';
    const tokenFingerprint = createHash('sha256').update(token).digest('hex').slice(0, 12);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await sendAPNS(token, payload);

    expect(res.status).toBe('stubbed');
    expect(sendApnsNotificationMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      '[Notifications] APNS not configured; push stubbed.',
      { tokenFingerprint, title: payload.title },
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain(token);
  });

  it('delivers via the native sender and folds alertId/eventType into data when configured', async () => {
    isApnsConfiguredMock.mockReturnValue(true);
    sendApnsNotificationMock.mockResolvedValueOnce({ ok: true, status: 200 });

    const res = await sendAPNS('apns-token', payload);

    expect(res.status).toBe('sent');
    expect(res.messageId).toMatch(/^apns-/);
    expect(sendApnsNotificationMock).toHaveBeenCalledWith('apns-token', {
      title: 'Test alert',
      body: 'Body',
      data: { severity: 'high', alertId: 'alert-1', eventType: 'alert.triggered' },
    });
  });

  it('throws (marking the notification failed) and purges the token when unregistered', async () => {
    isApnsConfiguredMock.mockReturnValue(true);
    sendApnsNotificationMock.mockResolvedValueOnce({
      ok: false,
      status: 410,
      reason: 'Unregistered',
      unregistered: true,
    });

    await expect(sendAPNS('dead-token', payload)).rejects.toThrow(/APNS delivery failed/);
    expect(db.update).toHaveBeenCalled();
    expect(updateSetCalls.some((s) => s.apnsToken === null)).toBe(true);
  });

  it('throws but does NOT purge on a non-unregistered delivery failure', async () => {
    isApnsConfiguredMock.mockReturnValue(true);
    sendApnsNotificationMock.mockResolvedValueOnce({ ok: false, status: 400, reason: 'BadRequest' });

    await expect(sendAPNS('apns-token', payload)).rejects.toThrow(/status 400/);
    expect(db.update).not.toHaveBeenCalled();
  });
});
