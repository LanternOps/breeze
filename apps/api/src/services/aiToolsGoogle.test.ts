import { describe, it, expect, vi, beforeEach } from 'vitest';

// Keep errorString + authorizeGoogleConnection real; mock only the DB loaders
// and the key decryption.
vi.mock('./googleHelpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./googleHelpers')>();
  return {
    ...actual,
    loadSession: vi.fn(),
    loadGoogleConnection: vi.fn(),
    decryptConnectionKey: vi.fn(() => 'KEYJSON'),
  };
});
// Keep normalizeGoogleError real; mock only the client builders.
vi.mock('./googleClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./googleClient')>();
  return {
    ...actual,
    getDirectoryClient: vi.fn(),
    getGmailClient: vi.fn(),
    getCalendarClient: vi.fn(),
  };
});
// Mock the email service used by google_email_report.
vi.mock('./email', () => ({ getEmailService: vi.fn() }));

import * as helpers from './googleHelpers';
import * as client from './googleClient';
import * as emailSvc from './email';
import {
  googleLookupUserHandler,
  googleResetPasswordHandler,
  googleSuspendUserHandler,
  googleSignOutHandler,
  googleSetForwardingHandler,
  googleSetVacationHandler,
  googleUpdateUserHandler,
  googleShareCalendarHandler,
  googleOffboardUserHandler,
  googleWipeMobileDeviceHandler,
  googleSecurityDriftHandler,
  googleEmailReportHandler,
  computeSecurityDrift,
} from './aiToolsGoogle';

const auth = {} as any;
const SESSION = 'sess-1';

function armConnection(connOverride?: Record<string, unknown>) {
  (helpers.loadSession as any).mockResolvedValue({ orgId: 'org-A' });
  (helpers.loadGoogleConnection as any).mockResolvedValue({
    orgId: 'org-A',
    status: 'active',
    adminEmail: 'admin@x.com',
    customerDomain: 'x.com',
    ...connOverride,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  armConnection();
  (helpers.decryptConnectionKey as any).mockReturnValue('KEYJSON');
});

describe('tier-3 guards', () => {
  it('reset requires a reason', async () => {
    const out = await googleResetPasswordHandler({ userEmail: 'u@x.com' }, auth, SESSION);
    expect(out).toContain('missing_reason');
  });
  it('lookup requires a user email', async () => {
    const out = await googleLookupUserHandler({}, auth, SESSION);
    expect(out).toContain('missing_user');
  });
});

describe('connection resolution', () => {
  it('errors when no active connection for the org', async () => {
    armConnection({ orgId: 'other-org' }); // authorize() fails (org mismatch)
    const out = await googleLookupUserHandler({ userEmail: 'u@x.com' }, auth, SESSION);
    expect(out).toContain('no_google_connection');
  });
});

describe('directory operations', () => {
  it('lookup returns a profile summary', async () => {
    (client.getDirectoryClient as any).mockReturnValue({
      users: { get: vi.fn().mockResolvedValue({ data: { primaryEmail: 'u@x.com', name: { fullName: 'U X' }, suspended: false } }) },
    });
    const out = await googleLookupUserHandler({ userEmail: 'u@x.com' }, auth, SESSION);
    expect(out).toContain('Google Workspace user profile');
    expect(out).toContain('u@x.com');
  });

  it('reset password returns a temporary password and forces change', async () => {
    const update = vi.fn().mockResolvedValue({});
    (client.getDirectoryClient as any).mockReturnValue({ users: { update } });
    const out = await googleResetPasswordHandler({ userEmail: 'u@x.com', reason: 'locked out' }, auth, SESSION);
    expect(out).toContain('Temporary password');
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ userKey: 'u@x.com', requestBody: expect.objectContaining({ changePasswordAtNextLogin: true }) }),
    );
  });

  it('suspend sets suspended=true', async () => {
    const update = vi.fn().mockResolvedValue({});
    (client.getDirectoryClient as any).mockReturnValue({ users: { update } });
    const out = await googleSuspendUserHandler({ userEmail: 'u@x.com', reason: 'offboard' }, auth, SESSION);
    expect(out).toContain('Suspended');
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ requestBody: { suspended: true } }));
  });

  it('signout calls users.signOut and notes the login-challenge caveat', async () => {
    const signOut = vi.fn().mockResolvedValue({});
    (client.getDirectoryClient as any).mockReturnValue({ users: { signOut } });
    const out = await googleSignOutHandler({ userEmail: 'u@x.com', reason: 'lockout' }, auth, SESSION);
    expect(signOut).toHaveBeenCalledWith({ userKey: 'u@x.com' });
    expect(out).toContain('login challenge');
  });

  it('update_user adds an alias', async () => {
    const insert = vi.fn().mockResolvedValue({});
    (client.getDirectoryClient as any).mockReturnValue({ users: { update: vi.fn(), aliases: { insert, delete: vi.fn() } } });
    const out = await googleUpdateUserHandler({ userEmail: 'u@x.com', addAlias: 'nick@x.com', reason: 'rename' }, auth, SESSION);
    expect(insert).toHaveBeenCalledWith({ userKey: 'u@x.com', requestBody: { alias: 'nick@x.com' } });
    expect(out).toContain('added alias nick@x.com');
  });

  it('maps a 403 to a google_forbidden error string', async () => {
    (client.getDirectoryClient as any).mockReturnValue({
      users: { get: vi.fn().mockRejectedValue({ code: 403, message: 'denied' }) },
    });
    const out = await googleLookupUserHandler({ userEmail: 'u@x.com' }, auth, SESSION);
    expect(out).toContain('google_forbidden');
  });
});

describe('gmail operations', () => {
  it('forwarding without keep-copy uses disposition=archive', async () => {
    const updateAutoForwarding = vi.fn().mockResolvedValue({});
    (client.getGmailClient as any).mockReturnValue({
      users: { settings: { forwardingAddresses: { create: vi.fn().mockResolvedValue({}) }, updateAutoForwarding } },
    });
    const out = await googleSetForwardingHandler(
      { userEmail: 'a@x.com', forwardTo: 'b@x.com', keepCopy: false, reason: 'leave' },
      auth,
      SESSION,
    );
    expect(updateAutoForwarding).toHaveBeenCalledWith(
      expect.objectContaining({ requestBody: expect.objectContaining({ enabled: true, emailAddress: 'b@x.com', disposition: 'archive' }) }),
    );
    expect(out).toContain('not keeping a copy');
  });

  it('vacation responder enables with a message', async () => {
    const updateVacation = vi.fn().mockResolvedValue({});
    (client.getGmailClient as any).mockReturnValue({ users: { settings: { updateVacation } } });
    const out = await googleSetVacationHandler(
      { userEmail: 'a@x.com', message: 'Out until Monday', reason: 'pto' },
      auth,
      SESSION,
    );
    expect(updateVacation).toHaveBeenCalledWith(
      expect.objectContaining({ requestBody: expect.objectContaining({ enableAutoReply: true, responseBodyPlainText: 'Out until Monday' }) }),
    );
    expect(out).toContain('Enabled the out-of-office');
  });
});

describe('calendar sharing', () => {
  it('requires a reason', async () => {
    const out = await googleShareCalendarHandler(
      { ownerEmail: 'a@x.com', shareWithEmail: 'b@x.com' },
      auth,
      SESSION,
    );
    expect(out).toContain('missing_reason');
  });

  it('rejects an invalid role', async () => {
    const out = await googleShareCalendarHandler(
      { ownerEmail: 'a@x.com', shareWithEmail: 'b@x.com', role: 'admin', reason: 'share' },
      auth,
      SESSION,
    );
    expect(out).toContain('invalid_role');
  });

  it('shares the primary calendar as reader by default, impersonating the owner', async () => {
    const insert = vi.fn().mockResolvedValue({});
    (client.getCalendarClient as any).mockReturnValue({ acl: { insert } });
    const out = await googleShareCalendarHandler(
      { ownerEmail: 'a@x.com', shareWithEmail: 'b@x.com', reason: 'team coverage' },
      auth,
      SESSION,
    );
    expect(client.getCalendarClient).toHaveBeenCalledWith('KEYJSON', 'a@x.com');
    expect(insert).toHaveBeenCalledWith({
      calendarId: 'primary',
      requestBody: { role: 'reader', scope: { type: 'user', value: 'b@x.com' } },
    });
    expect(out).toContain("a@x.com's primary calendar");
    expect(out).toContain('as reader');
  });

  it('honors an explicit calendarId and writer role', async () => {
    const insert = vi.fn().mockResolvedValue({});
    (client.getCalendarClient as any).mockReturnValue({ acl: { insert } });
    const out = await googleShareCalendarHandler(
      { ownerEmail: 'a@x.com', shareWithEmail: 'b@x.com', calendarId: 'team@x.com', role: 'writer', reason: 'shared cal' },
      auth,
      SESSION,
    );
    expect(insert).toHaveBeenCalledWith({
      calendarId: 'team@x.com',
      requestBody: { role: 'writer', scope: { type: 'user', value: 'b@x.com' } },
    });
    expect(out).toContain('calendar team@x.com');
    expect(out).toContain('as writer');
  });
});

describe('offboard workflow', () => {
  function mockDir(overrides: Record<string, any> = {}) {
    return {
      users: { signOut: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}) },
      tokens: {
        list: vi.fn().mockResolvedValue({ data: { items: [{ clientId: 'app-1' }, { clientId: 'app-2' }] } }),
        delete: vi.fn().mockResolvedValue({}),
      },
      groups: { list: vi.fn().mockResolvedValue({ data: { groups: [{ id: 'grp-1' }] } }) },
      members: { delete: vi.fn().mockResolvedValue({}) },
      mobiledevices: {
        list: vi.fn().mockResolvedValue({ data: { mobiledevices: [{ resourceId: 'dev-1' }] } }),
        action: vi.fn().mockResolvedValue({}),
      },
      ...overrides,
    };
  }

  it('requires a reason', async () => {
    const out = await googleOffboardUserHandler({ userEmail: 'u@x.com' }, auth, SESSION);
    expect(out).toContain('missing_reason');
  });

  it('runs the full sequence, account-wipes (not remote-wipes) mobile, and suspends last', async () => {
    const dir = mockDir();
    const gmail = {
      users: {
        settings: {
          updateVacation: vi.fn().mockResolvedValue({}),
          forwardingAddresses: { create: vi.fn().mockResolvedValue({}) },
          updateAutoForwarding: vi.fn().mockResolvedValue({}),
        },
      },
    };
    (client.getDirectoryClient as any).mockReturnValue(dir);
    (client.getGmailClient as any).mockReturnValue(gmail);

    const out = await googleOffboardUserHandler(
      { userEmail: 'leaver@x.com', forwardTo: 'mgr@x.com', oooMessage: 'I have left', reason: 'departure' },
      auth,
      SESSION,
    );

    // selective account wipe, never a full remote wipe
    expect(dir.mobiledevices.action).toHaveBeenCalledWith(
      expect.objectContaining({ resourceId: 'dev-1', requestBody: { action: 'admin_account_wipe' } }),
    );
    expect(dir.mobiledevices.action).not.toHaveBeenCalledWith(
      expect.objectContaining({ requestBody: { action: 'admin_remote_wipe' } }),
    );
    // forwarding without a kept copy
    expect(gmail.users.settings.updateAutoForwarding).toHaveBeenCalledWith(
      expect.objectContaining({ requestBody: expect.objectContaining({ disposition: 'archive' }) }),
    );
    expect(dir.tokens.delete).toHaveBeenCalledTimes(2);
    expect(dir.members.delete).toHaveBeenCalledWith({ groupKey: 'grp-1', memberKey: 'leaver@x.com' });
    expect(dir.users.update).toHaveBeenCalledWith({ userKey: 'leaver@x.com', requestBody: { suspended: true } });
    expect(out).toContain('steps OK');
    expect(out).toContain('BYOD-safe');
  });

  it('is best-effort: a failed step is reported but the rest still run + suspend', async () => {
    const dir = mockDir({ groups: { list: vi.fn().mockRejectedValue({ code: 403, message: 'no group scope' }) } });
    (client.getDirectoryClient as any).mockReturnValue(dir);

    const out = await googleOffboardUserHandler({ userEmail: 'leaver@x.com', reason: 'departure' }, auth, SESSION);
    expect(out).toContain('remove_from_groups: FAILED');
    // suspend still happened despite the group failure
    expect(dir.users.update).toHaveBeenCalledWith({ userKey: 'leaver@x.com', requestBody: { suspended: true } });
  });

  it('can skip optional steps via flags', async () => {
    const dir = mockDir();
    (client.getDirectoryClient as any).mockReturnValue(dir);
    await googleOffboardUserHandler(
      { userEmail: 'leaver@x.com', reason: 'departure', accountWipeMobile: false, removeFromGroups: false, revokeTokens: false },
      auth,
      SESSION,
    );
    expect(dir.mobiledevices.action).not.toHaveBeenCalled();
    expect(dir.members.delete).not.toHaveBeenCalled();
    expect(dir.tokens.delete).not.toHaveBeenCalled();
    expect(dir.users.signOut).toHaveBeenCalled();
  });
});

describe('stolen-device full wipe', () => {
  it('requires a reason', async () => {
    const out = await googleWipeMobileDeviceHandler({ userEmail: 'u@x.com' }, auth, SESSION);
    expect(out).toContain('missing_reason');
  });

  it('issues a FULL remote wipe and says it erases the whole device', async () => {
    const action = vi.fn().mockResolvedValue({});
    (client.getDirectoryClient as any).mockReturnValue({
      mobiledevices: { list: vi.fn().mockResolvedValue({ data: { mobiledevices: [{ resourceId: 'dev-1' }] } }), action },
    });
    const out = await googleWipeMobileDeviceHandler({ userEmail: 'u@x.com', reason: 'phone stolen' }, auth, SESSION);
    expect(action).toHaveBeenCalledWith(
      expect.objectContaining({ resourceId: 'dev-1', requestBody: { action: 'admin_remote_wipe' } }),
    );
    expect(out).toContain('FULL factory reset');
    expect(out).toContain('entire device');
  });

  it('reports when no devices are enrolled', async () => {
    (client.getDirectoryClient as any).mockReturnValue({
      mobiledevices: { list: vi.fn().mockResolvedValue({ data: { mobiledevices: [] } }), action: vi.fn() },
    });
    const out = await googleWipeMobileDeviceHandler({ userEmail: 'u@x.com', reason: 'stolen' }, auth, SESSION);
    expect(out).toContain('nothing to wipe');
  });
});

describe('computeSecurityDrift', () => {
  const NOW = Date.parse('2026-05-31T00:00:00Z');
  const users = [
    { primaryEmail: 'admin@x.com', isAdmin: true, suspended: false, isEnrolledIn2Sv: true, lastLoginTime: '2026-05-30T00:00:00Z' },
    { primaryEmail: 'no2sv@x.com', isAdmin: false, suspended: false, isEnrolledIn2Sv: false, lastLoginTime: '2026-05-29T00:00:00Z' },
    { primaryEmail: 'stale@x.com', isAdmin: false, suspended: false, isEnrolledIn2Sv: true, lastLoginTime: '2026-01-01T00:00:00Z' },
    { primaryEmail: 'never@x.com', isAdmin: false, suspended: false, isEnrolledIn2Sv: false, lastLoginTime: '1970-01-01T00:00:00Z' },
    { primaryEmail: 'gone@x.com', isAdmin: false, suspended: true, isEnrolledIn2Sv: false, lastLoginTime: null },
  ];

  it('buckets users correctly', () => {
    const d = computeSecurityDrift(users, 90, NOW);
    expect(d.totalUsers).toBe(5);
    expect(d.superAdmins.users).toEqual(['admin@x.com']);
    expect(d.suspended.users).toEqual(['gone@x.com']);
    // no2sv + never are active + not enrolled; gone is suspended so excluded
    expect(d.noTwoStep.users.sort()).toEqual(['never@x.com', 'no2sv@x.com']);
    expect(d.neverLoggedIn.users).toEqual(['never@x.com']);
    expect(d.stale.users).toEqual(['stale@x.com']);
    expect(d.stale.thresholdDays).toBe(90);
  });

  it('excludes suspended users from active buckets', () => {
    const d = computeSecurityDrift(users, 90, NOW);
    expect(d.noTwoStep.users).not.toContain('gone@x.com');
  });
});

describe('security drift + email report', () => {
  function armUserList(users: any[]) {
    (client.getDirectoryClient as any).mockReturnValue({
      users: { list: vi.fn().mockResolvedValue({ data: { users, nextPageToken: undefined } }) },
    });
  }

  it('security_drift returns a summary with counts', async () => {
    armUserList([
      { primaryEmail: 'a@x.com', isAdmin: true, suspended: false, isEnrolledIn2Sv: true, lastLoginTime: '2026-05-30T00:00:00Z' },
      { primaryEmail: 'b@x.com', isAdmin: false, suspended: false, isEnrolledIn2Sv: false, lastLoginTime: '2026-05-30T00:00:00Z' },
    ]);
    const out = await googleSecurityDriftHandler({}, auth, SESSION);
    expect(out).toContain('security drift for x.com');
    expect(out).toContain('"superAdmins"');
    expect(out).toContain('b@x.com');
  });

  it('email_report sends to the admin address and reports success', async () => {
    armUserList([{ primaryEmail: 'b@x.com', isAdmin: false, suspended: false, isEnrolledIn2Sv: false, lastLoginTime: '2026-05-30T00:00:00Z' }]);
    const sendEmail = vi.fn().mockResolvedValue(undefined);
    (emailSvc.getEmailService as any).mockReturnValue({ sendEmail });
    const out = await googleEmailReportHandler({}, auth, SESSION);
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'admin@x.com', subject: expect.stringContaining('x.com') }),
    );
    expect(out).toContain('Emailed the Google Workspace security-drift report');
  });

  it('email_report errors cleanly when no email provider is configured', async () => {
    (emailSvc.getEmailService as any).mockReturnValue(null);
    const out = await googleEmailReportHandler({}, auth, SESSION);
    expect(out).toContain('email_not_configured');
  });
});
