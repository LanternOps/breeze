import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'crypto';

import { sendAPNS, type PushPayload } from './notifications';

const payload: PushPayload = {
  title: 'Test alert',
  body: 'Body',
  data: {},
  alertId: null,
  eventType: 'alert.triggered',
};

describe('sendAPNS', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not log the raw APNS token', async () => {
    const token = 'apns-sensitive-token';
    const tokenFingerprint = createHash('sha256')
      .update(token)
      .digest('hex')
      .slice(0, 12);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await sendAPNS(token, payload);

    expect(warn).toHaveBeenCalledWith(
      '[Notifications] APNS sending is not implemented yet.',
      { tokenFingerprint, title: payload.title }
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain(token);
  });
});
