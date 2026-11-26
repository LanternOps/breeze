import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbMocks = vi.hoisted(() => ({
  /** One entry per db.select() in call order: memberships, users, org. */
  selectResults: [] as unknown[][],
  select: vi.fn(),
}));

vi.mock('../db', () => {
  const chainFor = (result: unknown[]) => {
    const where = () => Object.assign(Promise.resolve(result), { limit: () => Promise.resolve(result) });
    return { from: () => ({ where }) };
  };
  dbMocks.select.mockImplementation(() => chainFor(dbMocks.selectResults.shift() ?? []));
  return {
    db: { select: (...args: unknown[]) => dbMocks.select(...args) },
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
    withDbTransaction: (fn: () => unknown) => fn(),
  };
});
vi.mock('../db/schema', () => ({
  organizations: { id: 'organizations.id', name: 'organizations.name' },
  organizationUsers: { userId: 'ou.user_id', orgId: 'ou.org_id', siteIds: 'ou.site_ids' },
  users: { id: 'users.id', email: 'users.email', status: 'users.status' },
}));

const mocks = vi.hoisted(() => ({
  resolveUsersWithPermissionForOrg: vi.fn(),
  createNotification: vi.fn(),
  sendEmail: vi.fn(),
  emailConfigured: true,
  captureException: vi.fn(),
}));
vi.mock('./usersWithPermission', () => ({ resolveUsersWithPermissionForOrg: mocks.resolveUsersWithPermissionForOrg }));
vi.mock('./userNotifications', () => ({ createNotification: mocks.createNotification }));
vi.mock('./email', () => ({
  getEmailService: () => (mocks.emailConfigured ? { sendEmail: mocks.sendEmail } : null),
}));
vi.mock('./sentry', () => ({ captureException: mocks.captureException }));

import {
  buildPendingElevationEmail,
  notifyPendingElevation,
  pamElevationNotifyDedupeKey,
  PAM_ELEVATION_NOTIFY_WINDOW_MINUTES,
} from './pamElevationNotify';
import { PERMISSIONS } from './permissions';

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

describe('pamElevationNotifyDedupeKey', () => {
  it('is stable inside one window and changes at the next', () => {
    const windowMs = PAM_ELEVATION_NOTIFY_WINDOW_MINUTES * 60_000;
    const start = new Date(Math.floor(Date.parse('2026-11-25T10:07:00Z') / windowMs) * windowMs);
    const a = pamElevationNotifyDedupeKey('device-1', start);
    expect(pamElevationNotifyDedupeKey('device-1', new Date(start.getTime() + windowMs - 1))).toBe(a);
    expect(pamElevationNotifyDedupeKey('device-1', new Date(start.getTime() + windowMs))).not.toBe(a);
    expect(pamElevationNotifyDedupeKey('device-2', start)).not.toBe(a);
  });
});

describe('buildPendingElevationEmail', () => {
  it('escapes the agent-reported hostname in HTML and keeps the subject to one line', () => {
    const mail = buildPendingElevationEmail({
      deviceName: 'evil<script>\r\nBcc: x@example.test',
      orgName: 'Acme & Co',
      reviewUrl: 'https://app.example.test/pam#requests',
    });
    expect(mail.subject).not.toMatch(/[\r\n]/);
    expect(mail.html).not.toContain('<script>');
    expect(mail.html).toContain('evil&lt;script&gt;');
    expect(mail.html).toContain('Acme &amp; Co');
    expect(mail.text).toContain('https://app.example.test/pam#requests');
  });

  it('reads sensibly without an org name', () => {
    const mail = buildPendingElevationEmail({ deviceName: 'WS-01', orgName: '', reviewUrl: 'https://x.test/pam#requests' });
    expect(mail.text).toContain('An elevation request from WS-01 is waiting for a decision.');
  });
});

describe('notifyPendingElevation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.selectResults = [];
    mocks.emailConfigured = true;
    mocks.sendEmail.mockResolvedValue(undefined);
    mocks.createNotification.mockImplementation(async (input: { userId: string }) => `notice-${input.userId}`);
  });

  it('notifies nobody and sends nothing when no one holds pam:approve', async () => {
    mocks.resolveUsersWithPermissionForOrg.mockResolvedValue([]);
    const result = await notifyPendingElevation(ARGS);
    expect(mocks.resolveUsersWithPermissionForOrg).toHaveBeenCalledWith('org-1', PERMISSIONS.PAM_APPROVE);
    expect(result).toMatchObject({ recipients: 0, inAppCreated: 0, inAppFailed: 0 });
    expect(await result.emailDelivery).toEqual({ sent: 0, failed: 0 });
    expect(mocks.createNotification).not.toHaveBeenCalled();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it('drops a member restricted to other sites; keeps an unrestricted member and partner staff', async () => {
    mocks.resolveUsersWithPermissionForOrg.mockResolvedValue(['restricted', 'unrestricted', 'partner-staff']);
    dbMocks.selectResults = [
      [{ userId: 'restricted', siteIds: ['site-2'] }, { userId: 'unrestricted', siteIds: null }],
      [person('unrestricted'), person('partner-staff')],
      [{ name: 'Acme' }],
    ];
    const result = await notifyPendingElevation(ARGS);
    expect(result.recipients).toBe(2);
    expect(mocks.createNotification.mock.calls.map(([input]) => input.userId)).toEqual(['unrestricted', 'partner-staff']);
  });

  it('writes one approval notice per recipient keyed to the device window, linking to the requests tab', async () => {
    mocks.resolveUsersWithPermissionForOrg.mockResolvedValue(['u1']);
    dbMocks.selectResults = [[], [person('u1')], [{ name: 'Acme' }]];
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
      dedupeKey: pamElevationNotifyDedupeKey('device-1', ARGS.now),
    });
  });

  it('emails only recipients whose notice is new this window, one message each', async () => {
    mocks.resolveUsersWithPermissionForOrg.mockResolvedValue(['new', 'already-told']);
    dbMocks.selectResults = [[], [person('new'), person('already-told')], [{ name: 'Acme' }]];
    mocks.createNotification.mockImplementation(async (input: { userId: string }) =>
      (input.userId === 'already-told' ? null : 'notice-new'));
    const result = await notifyPendingElevation(ARGS);
    expect(result).toMatchObject({ recipients: 2, inAppCreated: 1, inAppFailed: 0 });
    expect(await result.emailDelivery).toEqual({ sent: 1, failed: 0 });
    expect(mocks.sendEmail).toHaveBeenCalledOnce();
    expect(mocks.sendEmail.mock.calls[0]![0]).toMatchObject({ to: 'new@example.test', purpose: 'staff.pam_elevation_request' });
  });

  it('a failed in-app write for one recipient leaves the others, and that recipient is still emailed', async () => {
    mocks.resolveUsersWithPermissionForOrg.mockResolvedValue(['broken', 'fine']);
    dbMocks.selectResults = [[], [person('broken'), person('fine')], [{ name: 'Acme' }]];
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
      expect(errors.mock.calls[0]![0]).toContain('user=broken elevation=req-1: 23514');
    } finally {
      errors.mockRestore();
    }
  });

  it('a failed send is counted, reported and never rejects', async () => {
    mocks.resolveUsersWithPermissionForOrg.mockResolvedValue(['u1', 'u2']);
    dbMocks.selectResults = [[], [person('u1'), person('u2')], [{ name: 'Acme' }]];
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
    mocks.resolveUsersWithPermissionForOrg.mockResolvedValue(['u1']);
    dbMocks.selectResults = [[], [person('u1')], [{ name: 'Acme' }]];
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

  it('skips the site narrowing read for a device with no site', async () => {
    mocks.resolveUsersWithPermissionForOrg.mockResolvedValue(['u1']);
    dbMocks.selectResults = [[person('u1')], [{ name: 'Acme' }]];
    const result = await notifyPendingElevation({ ...ARGS, siteId: null });
    expect(result.recipients).toBe(1);
    expect(dbMocks.select).toHaveBeenCalledTimes(2);
  });
});
