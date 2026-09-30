import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { selectMock, sendPushoverNotificationMock } = vi.hoisted(() => ({
  selectMock: vi.fn(),
  sendPushoverNotificationMock: vi.fn(),
}));

vi.mock('../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db')>()),
  db: { select: selectMock },
  withSystemDbAccessContext: vi.fn(async (fn: () => unknown) => fn()),
}));

vi.mock('./notificationSenders', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./notificationSenders')>()),
  sendPushoverNotification: sendPushoverNotificationMock,
}));

import { encryptSecret } from './secretCrypto';
import { sendPushoverChannelNotification } from './notificationDispatcher';

function partnerSettingsSelect(settings: unknown) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ settings }]) }),
    }),
  };
}

const alert = {
  id: 'alert-1',
  title: 'CPU High',
  severity: 'high',
  message: 'CPU is above threshold',
  triggeredAt: new Date(),
  deviceId: 'device-1',
  orgId: 'org-1',
} as any;

describe('notification dispatcher pushover channel', () => {
  const priorKey = process.env.APP_ENCRYPTION_KEY;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.APP_ENCRYPTION_KEY = 'dispatcher-pushover-test-key-material';
    sendPushoverNotificationMock.mockResolvedValue({ success: true, statusCode: 200 });
  });

  afterEach(() => {
    if (priorKey === undefined) delete process.env.APP_ENCRYPTION_KEY;
    else process.env.APP_ENCRYPTION_KEY = priorKey;
  });

  it('sends with the partner defaults decrypted when the channel leaves token and user blank', async () => {
    selectMock.mockReturnValueOnce(partnerSettingsSelect({
      notifications: {
        pushoverAppToken: encryptSecret('partner-app-token'),
        pushoverDefaultUser: encryptSecret('partner-user-key'),
        pushoverDefaultSound: 'siren',
      },
    }));

    const result = await sendPushoverChannelNotification(
      { token: '', user: '' } as any,
      alert,
      undefined,
      { name: 'Acme', partnerId: 'partner-1' } as any,
    );

    expect(result.success).toBe(true);
    expect(sendPushoverNotificationMock).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'partner-app-token', user: 'partner-user-key', sound: 'siren' }),
      expect.anything(),
    );
  });

  it('still sends with partner defaults stored before they were sealed', async () => {
    selectMock.mockReturnValueOnce(partnerSettingsSelect({
      notifications: { pushoverAppToken: 'legacy-app-token', pushoverDefaultUser: 'legacy-user-key' },
    }));

    await sendPushoverChannelNotification(
      { token: '', user: '' } as any,
      alert,
      undefined,
      { name: 'Acme', partnerId: 'partner-1' } as any,
    );

    expect(sendPushoverNotificationMock).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'legacy-app-token', user: 'legacy-user-key' }),
      expect.anything(),
    );
  });

  it('keeps the channel values when the channel sets its own token and user', async () => {
    selectMock.mockReturnValueOnce(partnerSettingsSelect({
      notifications: { pushoverAppToken: encryptSecret('partner-app-token') },
    }));

    await sendPushoverChannelNotification(
      { token: 'channel-token', user: 'channel-user' } as any,
      alert,
      undefined,
      { name: 'Acme', partnerId: 'partner-1' } as any,
    );

    expect(sendPushoverNotificationMock).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'channel-token', user: 'channel-user' }),
      expect.anything(),
    );
  });
});
