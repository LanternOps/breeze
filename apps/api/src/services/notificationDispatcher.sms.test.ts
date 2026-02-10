import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendSmsNotificationMock = vi.hoisted(() => vi.fn());

vi.mock('./notificationSenders/smsSender', () => ({
  sendSmsNotification: sendSmsNotificationMock
}));

import { sendSmsNotification } from './notificationSenders/smsSender';
import { sendSmsChannelNotification } from './notificationDispatcher';

describe('notification dispatcher sms channel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns success when sms sender succeeds', async () => {
    vi.mocked(sendSmsNotification).mockResolvedValue({
      success: true,
      sentCount: 2,
      failedCount: 0
    });

    const result = await sendSmsChannelNotification(
      { phoneNumbers: ['+15551234567'] },
      {
        id: 'alert-1',
        title: 'CPU High',
        severity: 'high',
        message: 'CPU is above threshold',
        triggeredAt: new Date(),
        deviceId: 'device-1',
        orgId: 'org-1'
      } as any,
      { displayName: 'Server-1', hostname: 'server-1' } as any,
      { name: 'Acme Corp' } as any
    );

    expect(result).toEqual({ success: true, error: undefined });
    expect(sendSmsNotification).toHaveBeenCalledTimes(1);
  });

  it('returns failure when sms sender fails', async () => {
    vi.mocked(sendSmsNotification).mockResolvedValue({
      success: false,
      sentCount: 0,
      failedCount: 1,
      error: 'Invalid E.164 phone number'
    });

    const result = await sendSmsChannelNotification(
      { phoneNumbers: ['123'] as unknown as string[] },
      {
        id: 'alert-2',
        title: 'Disk Full',
        severity: 'critical',
        message: 'Disk usage above threshold',
        triggeredAt: new Date(),
        deviceId: 'device-1',
        orgId: 'org-1'
      } as any,
      undefined,
      undefined
    );

    expect(result).toEqual({ success: false, error: 'Invalid E.164 phone number' });
  });
});
