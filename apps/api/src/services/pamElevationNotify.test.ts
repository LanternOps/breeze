import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  withDbTransaction: (fn: () => unknown) => fn(),
}));

const q = vi.hoisted(() => ({
  lockDeviceAnnouncements: vi.fn(),
  readElevationRequestState: vi.fn(),
  resolveElevationNoticeAudience: vi.fn(),
  deviceAnnouncedWithin: vi.fn(),
  countRecentElevationNotices: vi.fn(),
  readOrgName: vi.fn(),
}));
vi.mock('./pamElevationNotifyQueries', () => ({
  ...q,
  pamElevationNotifyDedupeKey: (id: string) => `pam-elevation:${id}`,
}));

const mocks = vi.hoisted(() => ({
  createNotification: vi.fn(),
  sendEmail: vi.fn(),
  emailConfigured: true,
  captureException: vi.fn(),
}));
vi.mock('./userNotifications', () => ({ createNotification: mocks.createNotification }));
vi.mock('./email', () => ({
  getEmailService: () => (mocks.emailConfigured ? { sendEmail: mocks.sendEmail } : null),
}));
vi.mock('./sentry', () => ({ captureException: mocks.captureException }));

import {
  buildPendingElevationEmail,
  emailDeviceLabel,
  notifyPendingElevation,
  PAM_ELEVATION_EMAILS_PER_RECIPIENT_PER_HOUR,
  pamElevationNotifyDedupeKey,
} from './pamElevationNotify';

const ARGS = {
  elevationRequestId: 'req-1',
  orgId: 'org-1',
  siteId: 'site-1',
  deviceId: 'device-1',
  deviceHostname: 'WS-01',
  now: new Date('2026-11-25T10:07:00Z'),
};

function person(id: string) {
  return { id, email: `${id}@example.test` };
}

function audience(ids: string[], holders = ids.length) {
  return { permissionHolders: holders, withAccess: ids.length, people: ids.map(person) };
}

describe('pamElevationNotifyDedupeKey', () => {
  it('is one key per request', () => {
    expect(pamElevationNotifyDedupeKey('req-1')).toBe(pamElevationNotifyDedupeKey('req-1'));
    expect(pamElevationNotifyDedupeKey('req-1')).not.toBe(pamElevationNotifyDedupeKey('req-2'));
  });
});

describe('emailDeviceLabel', () => {
  it.each([
    ['WS-01', 'WS-01'],
    ['pc01.corp.example.com', 'pc01'],
    ['https://phish.example/login', 'httpsphish'],
    ['phish.example', 'phish'],
    ['user@phish.example', 'userphish'],
    ['www。phish．example', 'wwwphishexample'],
    ['evil<script>\r\nBcc: x@example.test', 'evilscriptBccxexample'],
    ['...', ''],
  ])('%j -> %j', (input, expected) => {
    expect(emailDeviceLabel(input)).toBe(expected);
  });

  it('never leaves a character a mail client could read as a link or address separator', () => {
    for (const host of ['a.b', 'http://a', 'a/b', 'a@b', 'a:b', 'a․b', 'a．b', 'mailto:a@b.c']) {
      expect(emailDeviceLabel(host)).toMatch(/^[\p{L}\p{N}_-]*$/u);
    }
  });
});

describe('buildPendingElevationEmail', () => {
  it('escapes the HTML, keeps the subject to one line, and shows no link-like hostname', () => {
    const mail = buildPendingElevationEmail({
      deviceName: 'https://phish.example/login<script>\r\nBcc: x@example.test',
      orgName: 'Acme & Co',
      reviewUrl: 'https://app.example.test/pam#requests',
    });
    expect(mail.subject).toBe('Elevation request waiting: httpsphish');
    for (const part of [mail.subject, mail.html, mail.text]) {
      expect(part).not.toContain('phish.example');
      expect(part).not.toContain('<script>');
    }
    expect(mail.html).toContain('Acme &amp; Co');
    expect(mail.text).toContain('https://app.example.test/pam#requests');
  });

  it('falls back to "a device" when nothing of the hostname is left', () => {
    const mail = buildPendingElevationEmail({ deviceName: '://', orgName: '', reviewUrl: 'https://x.test/pam#requests' });
    expect(mail.subject).toBe('Elevation request waiting: a device');
  });

  it('reads sensibly without an org name', () => {
    const mail = buildPendingElevationEmail({ deviceName: 'WS-01', orgName: '', reviewUrl: 'https://x.test/pam#requests' });
    expect(mail.text).toContain('An elevation request from WS-01 is waiting for a decision.');
  });
});

describe('notifyPendingElevation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.emailConfigured = true;
    mocks.sendEmail.mockResolvedValue(undefined);
    mocks.createNotification.mockImplementation(async (input: { userId: string }) => `notice-${input.userId}`);
    q.lockDeviceAnnouncements.mockResolvedValue(undefined);
    q.readElevationRequestState.mockResolvedValue({ flowType: 'uac_intercept', status: 'pending' });
    q.resolveElevationNoticeAudience.mockResolvedValue(audience(['u1']));
    q.deviceAnnouncedWithin.mockResolvedValue(false);
    q.countRecentElevationNotices.mockResolvedValue(new Map());
    q.readOrgName.mockResolvedValue('Acme');
  });

  it('takes the device lock before reading anything', async () => {
    await notifyPendingElevation(ARGS);
    expect(q.lockDeviceAnnouncements).toHaveBeenCalledWith('device-1');
    const lockOrder = q.lockDeviceAnnouncements.mock.invocationCallOrder[0]!;
    expect(lockOrder).toBeLessThan(q.readElevationRequestState.mock.invocationCallOrder[0]!);
    expect(lockOrder).toBeLessThan(q.deviceAnnouncedWithin.mock.invocationCallOrder[0]!);
  });

  it.each([
    ['withdrawn', 'uac_intercept'],
    ['denied', 'uac_intercept'],
    ['expired', 'uac_intercept'],
  ])('tells nobody about a request that is %s by the time it runs', async (status, flowType) => {
    q.readElevationRequestState.mockResolvedValue({ flowType, status });
    const result = await notifyPendingElevation(ARGS);
    expect(result).toMatchObject({ skipped: 'not_pending', recipients: 0, inAppCreated: 0 });
    expect(await result.emailDelivery).toEqual({ sent: 0, failed: 0 });
    expect(q.resolveElevationNoticeAudience).not.toHaveBeenCalled();
    expect(mocks.createNotification).not.toHaveBeenCalled();
  });

  it('tells nobody, and warns with ids, when the request row is missing', async () => {
    q.readElevationRequestState.mockResolvedValue(null);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await notifyPendingElevation(ARGS);
      expect(result.skipped).toBe('request_not_found');
      expect(mocks.createNotification).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith('[PamElevationNotify] pending elevation not announced', {
        elevationRequestId: 'req-1', orgId: 'org-1', deviceId: 'device-1', skipped: 'request_not_found',
      });
    } finally {
      warn.mockRestore();
    }
  });

  it('records every rule-based skip with ids at info', async () => {
    q.deviceAnnouncedWithin.mockResolvedValue(true);
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      await notifyPendingElevation(ARGS);
      expect(info).toHaveBeenCalledWith('[PamElevationNotify] pending elevation not announced', {
        elevationRequestId: 'req-1', orgId: 'org-1', deviceId: 'device-1', skipped: 'device_cooldown',
      });
    } finally {
      info.mockRestore();
    }
  });

  it('tells nobody about a request of another flow', async () => {
    q.readElevationRequestState.mockResolvedValue({ flowType: 'tech_jit_admin', status: 'pending' });
    const result = await notifyPendingElevation(ARGS);
    expect(result.skipped).toBe('not_uac_request');
    expect(mocks.createNotification).not.toHaveBeenCalled();
  });

  it('tells nobody inside the device cooldown, asking with the recipients and a 15-minute window', async () => {
    q.resolveElevationNoticeAudience.mockResolvedValue(audience(['u1', 'u2']));
    q.deviceAnnouncedWithin.mockResolvedValue(true);
    const result = await notifyPendingElevation(ARGS);
    expect(q.deviceAnnouncedWithin).toHaveBeenCalledWith({
      orgId: 'org-1',
      deviceId: 'device-1',
      elevationRequestId: 'req-1',
      recipientIds: ['u1', 'u2'],
      since: new Date('2026-11-25T09:52:00Z'),
    });
    expect(result).toMatchObject({ skipped: 'device_cooldown', recipients: 0, inAppCreated: 0 });
    expect(await result.emailDelivery).toEqual({ sent: 0, failed: 0 });
    expect(mocks.createNotification).not.toHaveBeenCalled();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('notifies nobody and logs counts when no one can be told', async () => {
    q.resolveElevationNoticeAudience.mockResolvedValue({ permissionHolders: 2, withAccess: 0, people: [] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await notifyPendingElevation(ARGS);
      expect(q.resolveElevationNoticeAudience).toHaveBeenCalledWith('org-1', 'site-1');
      expect(result).toMatchObject({ skipped: null, recipients: 0, inAppCreated: 0, inAppFailed: 0 });
      expect(await result.emailDelivery).toEqual({ sent: 0, failed: 0 });
      expect(q.deviceAnnouncedWithin).not.toHaveBeenCalled();
      expect(mocks.createNotification).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith('[PamElevationNotify] pending elevation has no one to notify', {
        elevationRequestId: 'req-1', orgId: 'org-1', permissionHolders: 2, withSiteAccess: 0,
      });
    } finally {
      warn.mockRestore();
    }
  });

  it('writes one approval notice per recipient, linking to the requests tab', async () => {
    await notifyPendingElevation(ARGS);
    expect(mocks.createNotification).toHaveBeenCalledWith({
      userId: 'u1',
      orgId: 'org-1',
      type: 'approval',
      priority: 'high',
      title: 'Elevation request waiting',
      message: 'An elevation request from WS-01 (Acme) is waiting for a decision.',
      link: '/pam#requests',
      metadata: { elevationRequestId: 'req-1', deviceId: 'device-1' },
      dedupeKey: pamElevationNotifyDedupeKey('req-1'),
    });
  });

  it('emails only recipients whose notice this call created, one message each', async () => {
    q.resolveElevationNoticeAudience.mockResolvedValue(audience(['new', 'already-told']));
    mocks.createNotification.mockImplementation(async (input: { userId: string }) =>
      (input.userId === 'already-told' ? null : 'notice-new'));
    const result = await notifyPendingElevation(ARGS);
    expect(result).toMatchObject({ recipients: 2, inAppCreated: 1, inAppFailed: 0 });
    expect(await result.emailDelivery).toEqual({ sent: 1, failed: 0 });
    expect(mocks.sendEmail).toHaveBeenCalledOnce();
    expect(mocks.sendEmail.mock.calls[0]![0]).toMatchObject({ to: 'new@example.test', purpose: 'staff.pam_elevation_request' });
  });

  it('at the hourly ceiling a recipient gets the notice but no email, and the skip is logged with counts', async () => {
    q.resolveElevationNoticeAudience.mockResolvedValue(audience(['busy', 'almost', 'quiet']));
    q.countRecentElevationNotices.mockResolvedValue(new Map([
      ['busy', PAM_ELEVATION_EMAILS_PER_RECIPIENT_PER_HOUR],
      ['almost', PAM_ELEVATION_EMAILS_PER_RECIPIENT_PER_HOUR - 1],
    ]));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await notifyPendingElevation(ARGS);
      expect(q.countRecentElevationNotices).toHaveBeenCalledWith(['busy', 'almost', 'quiet'], new Date('2026-11-25T09:07:00Z'));
      expect(result).toMatchObject({ recipients: 3, inAppCreated: 3, emailCeilingReached: 1 });
      expect(await result.emailDelivery).toEqual({ sent: 2, failed: 0 });
      expect(mocks.sendEmail.mock.calls.map(([p]) => p.to)).toEqual(['almost@example.test', 'quiet@example.test']);
      expect(warn).toHaveBeenCalledWith('[PamElevationNotify] email ceiling reached; in-app notice only', {
        elevationRequestId: 'req-1', orgId: 'org-1', recipients: 3, overCeiling: 1, ceilingPerHour: 12,
      });
    } finally {
      warn.mockRestore();
    }
  });

  it('a failed in-app write for one recipient leaves the others, and that recipient is still emailed', async () => {
    q.resolveElevationNoticeAudience.mockResolvedValue(audience(['broken', 'fine']));
    mocks.createNotification.mockImplementation(async (input: { userId: string }) => {
      if (input.userId === 'broken') throw Object.assign(new Error('insert failed'), { cause: { code: '23514' } });
      return 'notice-fine';
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await notifyPendingElevation(ARGS);
      expect(result).toMatchObject({ recipients: 2, inAppCreated: 1, inAppFailed: 1 });
      expect(await result.emailDelivery).toEqual({ sent: 2, failed: 0 });
      expect(mocks.captureException).toHaveBeenCalledOnce();
      expect(errors.mock.calls[0]![0]).toBe('[PamElevationNotify] in-app notice failed for user=broken elevation=req-1: 23514');
    } finally {
      errors.mockRestore();
    }
  });

  it('a failed in-app write does not bypass the ceiling', async () => {
    q.resolveElevationNoticeAudience.mockResolvedValue(audience(['fine', 'broken']));
    q.countRecentElevationNotices.mockResolvedValue(new Map([['broken', PAM_ELEVATION_EMAILS_PER_RECIPIENT_PER_HOUR]]));
    mocks.createNotification.mockImplementation(async (input: { userId: string }) => {
      if (input.userId === 'broken') throw new Error('insert failed');
      return 'notice-fine';
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await notifyPendingElevation(ARGS);
      expect(result).toMatchObject({ inAppCreated: 1, inAppFailed: 1, emailCeilingReached: 1 });
      expect(await result.emailDelivery).toEqual({ sent: 1, failed: 0 });
      expect(mocks.sendEmail.mock.calls.map(([p]) => p.to)).toEqual(['fine@example.test']);
    } finally {
      errors.mockRestore();
      warn.mockRestore();
    }
  });

  it('when every in-app write fails, nobody is emailed and the withheld email is logged with counts', async () => {
    q.resolveElevationNoticeAudience.mockResolvedValue(audience(['u1', 'u2']));
    mocks.createNotification.mockRejectedValue(Object.assign(new Error('insert failed'), { cause: { code: '42501' } }));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await notifyPendingElevation(ARGS);
      expect(result).toMatchObject({ skipped: null, recipients: 2, inAppCreated: 0, inAppFailed: 2 });
      expect(await result.emailDelivery).toEqual({ sent: 0, failed: 0 });
      expect(mocks.sendEmail).not.toHaveBeenCalled();
      expect(errors).toHaveBeenCalledWith('[PamElevationNotify] no in-app notice written; email withheld', {
        elevationRequestId: 'req-1', orgId: 'org-1', recipients: 2, inAppFailed: 2,
      });
    } finally {
      errors.mockRestore();
    }
  });

  it('a failed send is counted, reported and never rejects', async () => {
    q.resolveElevationNoticeAudience.mockResolvedValue(audience(['u1', 'u2']));
    mocks.sendEmail.mockRejectedValueOnce(new Error('smtp down'));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await notifyPendingElevation(ARGS);
      expect(await result.emailDelivery).toEqual({ sent: 1, failed: 1 });
      expect(mocks.captureException).toHaveBeenCalledOnce();
    } finally {
      errors.mockRestore();
    }
  });

  it('with email not configured, writes the in-app notices and sends nothing', async () => {
    mocks.emailConfigured = false;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await notifyPendingElevation(ARGS);
      expect(result.inAppCreated).toBe(1);
      expect(await result.emailDelivery).toEqual({ sent: 0, failed: 0 });
      expect(mocks.sendEmail).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('the in-app notice keeps the full hostname; the email shows only its safe label', async () => {
    await notifyPendingElevation({ ...ARGS, deviceHostname: 'pc01.corp.example.com' });
    expect(mocks.createNotification.mock.calls[0]![0].message)
      .toBe('An elevation request from pc01.corp.example.com (Acme) is waiting for a decision.');
    await vi.waitFor(() => expect(mocks.sendEmail).toHaveBeenCalledOnce());
    const sent = mocks.sendEmail.mock.calls[0]![0] as { subject: string; text: string };
    expect(sent.subject).toBe('Elevation request waiting: pc01');
    expect(sent.text).not.toContain('example.com');
  });
});
