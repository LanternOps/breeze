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
    getLicensingClient: vi.fn(),
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
  googleDisableForwardingHandler,
  googleSetVacationHandler,
  googleUpdateUserHandler,
  googleShareCalendarHandler,
  googleOffboardUserHandler,
  googleWipeMobileDeviceHandler,
  googleSecurityDriftHandler,
  googleEmailReportHandler,
  computeSecurityDrift,
  googleListUserGroupsHandler,
  googleAddToGroupHandler,
  googleRemoveFromGroupHandler,
  googleMoveOuHandler,
  googleRenameUserHandler,
  googleResetTwoSvHandler,
  googleAddMailDelegateHandler,
  googleRemoveMailDelegateHandler,
  googleListLicensesHandler,
  googleAssignLicenseHandler,
  googleRemoveLicenseHandler,
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

describe('group membership (cluster 3)', () => {
  it('add_to_group requires a reason', async () => {
    const out = await googleAddToGroupHandler({ userEmail: 'u@x.com', groupEmail: 'g@x.com' }, auth, SESSION);
    expect(out).toContain('missing_reason');
  });

  it('list_user_groups returns the user\'s groups', async () => {
    const list = vi.fn().mockResolvedValue({ data: { groups: [{ email: 'g@x.com', name: 'G', id: 'grp-1' }] } });
    (client.getDirectoryClient as any).mockReturnValue({ groups: { list } });
    const out = await googleListUserGroupsHandler({ userEmail: 'u@x.com' }, auth, SESSION);
    expect(list).toHaveBeenCalledWith({ userKey: 'u@x.com', maxResults: 200 });
    expect(out).toContain('g@x.com');
  });

  it('add_to_group inserts the member (defaults to MEMBER)', async () => {
    const insert = vi.fn().mockResolvedValue({});
    (client.getDirectoryClient as any).mockReturnValue({ members: { insert } });
    const out = await googleAddToGroupHandler({ userEmail: 'u@x.com', groupEmail: 'g@x.com', reason: 'onboard' }, auth, SESSION);
    expect(insert).toHaveBeenCalledWith({ groupKey: 'g@x.com', requestBody: { email: 'u@x.com', role: 'MEMBER' } });
    expect(out).toContain('Added u@x.com to group g@x.com');
  });

  it('remove_from_group deletes the member', async () => {
    const del = vi.fn().mockResolvedValue({});
    (client.getDirectoryClient as any).mockReturnValue({ members: { delete: del } });
    const out = await googleRemoveFromGroupHandler({ userEmail: 'u@x.com', groupEmail: 'g@x.com', reason: 'offboard' }, auth, SESSION);
    expect(del).toHaveBeenCalledWith({ groupKey: 'g@x.com', memberKey: 'u@x.com' });
    expect(out).toContain('Removed u@x.com from group g@x.com');
  });
});

describe('ou move + rename (cluster 3)', () => {
  it('move_ou requires a reason', async () => {
    const out = await googleMoveOuHandler({ userEmail: 'u@x.com', orgUnitPath: '/Sales' }, auth, SESSION);
    expect(out).toContain('missing_reason');
  });

  it('move_ou updates orgUnitPath', async () => {
    const update = vi.fn().mockResolvedValue({});
    (client.getDirectoryClient as any).mockReturnValue({ users: { update } });
    const out = await googleMoveOuHandler({ userEmail: 'u@x.com', orgUnitPath: '/Sales', reason: 'team move' }, auth, SESSION);
    expect(update).toHaveBeenCalledWith({ userKey: 'u@x.com', requestBody: { orgUnitPath: '/Sales' } });
    expect(out).toContain('Moved u@x.com to org unit /Sales');
  });

  it('rename_user changes the primary email', async () => {
    const update = vi.fn().mockResolvedValue({});
    (client.getDirectoryClient as any).mockReturnValue({ users: { update } });
    const out = await googleRenameUserHandler({ userEmail: 'old@x.com', newPrimaryEmail: 'new@x.com', reason: 'name change' }, auth, SESSION);
    expect(update).toHaveBeenCalledWith({ userKey: 'old@x.com', requestBody: { primaryEmail: 'new@x.com' } });
    expect(out).toContain('Renamed old@x.com to new@x.com');
  });
});

describe('license management (cluster 3)', () => {
  it('assign_license requires a reason', async () => {
    const out = await googleAssignLicenseHandler(
      { userEmail: 'u@x.com', productId: 'Google-Apps', skuId: '1010020027' }, auth, SESSION);
    expect(out).toContain('missing_reason');
  });

  it('list_licenses returns assignments for a product', async () => {
    const listForProduct = vi.fn().mockResolvedValue({
      data: { items: [{ userId: 'u@x.com', skuId: '1010020027', skuName: 'Business Standard' }] }
    });
    (client.getLicensingClient as any).mockReturnValue({ licenseAssignments: { listForProduct } });
    const out = await googleListLicensesHandler({ productId: 'Google-Apps' }, auth, SESSION);
    expect(listForProduct).toHaveBeenCalledWith({ productId: 'Google-Apps', customerId: 'my_customer', maxResults: 100 });
    expect(out).toContain('u@x.com');
  });

  it('assign_license inserts the assignment', async () => {
    const insert = vi.fn().mockResolvedValue({});
    (client.getLicensingClient as any).mockReturnValue({ licenseAssignments: { insert } });
    const out = await googleAssignLicenseHandler(
      { userEmail: 'u@x.com', productId: 'Google-Apps', skuId: '1010020027', reason: 'onboard' }, auth, SESSION);
    expect(insert).toHaveBeenCalledWith({ productId: 'Google-Apps', skuId: '1010020027', requestBody: { userId: 'u@x.com' } });
    expect(out).toContain('Assigned license Google-Apps/1010020027 to u@x.com');
  });

  it('remove_license deletes the assignment', async () => {
    const del = vi.fn().mockResolvedValue({});
    (client.getLicensingClient as any).mockReturnValue({ licenseAssignments: { delete: del } });
    const out = await googleRemoveLicenseHandler(
      { userEmail: 'u@x.com', productId: 'Google-Apps', skuId: '1010020027', reason: 'offboard' }, auth, SESSION);
    expect(del).toHaveBeenCalledWith({ productId: 'Google-Apps', skuId: '1010020027', userId: 'u@x.com' });
    expect(out).toContain('Removed license Google-Apps/1010020027 from u@x.com');
  });
});

describe('2sv reset + mail delegation (cluster 3)', () => {
  it('reset_2sv requires a reason', async () => {
    const out = await googleResetTwoSvHandler({ userEmail: 'u@x.com' }, auth, SESSION);
    expect(out).toContain('missing_reason');
  });

  it('reset_2sv turns off two-step verification', async () => {
    const turnOff = vi.fn().mockResolvedValue({});
    (client.getDirectoryClient as any).mockReturnValue({ twoStepVerification: { turnOff } });
    const out = await googleResetTwoSvHandler({ userEmail: 'u@x.com', reason: 'lost phone' }, auth, SESSION);
    expect(turnOff).toHaveBeenCalledWith({ userKey: 'u@x.com' });
    expect(out).toContain('Turned off 2-step verification for u@x.com');
  });

  it('add_mail_delegate creates a delegate on the mailbox', async () => {
    const create = vi.fn().mockResolvedValue({});
    (client.getGmailClient as any).mockReturnValue({ users: { settings: { delegates: { create } } } });
    const out = await googleAddMailDelegateHandler(
      { userEmail: 'owner@x.com', delegateEmail: 'asst@x.com', reason: 'coverage' }, auth, SESSION);
    expect(create).toHaveBeenCalledWith({ userId: 'me', requestBody: { delegateEmail: 'asst@x.com' } });
    expect(out).toContain('Granted asst@x.com delegated access');
  });

  it('remove_mail_delegate deletes the delegate', async () => {
    const del = vi.fn().mockResolvedValue({});
    (client.getGmailClient as any).mockReturnValue({ users: { settings: { delegates: { delete: del } } } });
    const out = await googleRemoveMailDelegateHandler(
      { userEmail: 'owner@x.com', delegateEmail: 'asst@x.com', reason: 'done' }, auth, SESSION);
    expect(del).toHaveBeenCalledWith({ userId: 'me', delegateEmail: 'asst@x.com' });
    expect(out).toContain("Removed asst@x.com's delegated access");
  });
});

describe('gmail operations', () => {
  it('forwarding without keep-copy uses disposition=archive', async () => {
    const updateAutoForwarding = vi.fn().mockResolvedValue({});
    (client.getGmailClient as any).mockReturnValue({
      users: { settings: { forwardingAddresses: { create: vi.fn().mockResolvedValue({ data: { verificationStatus: 'accepted' } }) }, updateAutoForwarding } },
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

  it('forwarding to an unverified destination returns a pending-verification error, not a false success', async () => {
    const updateAutoForwarding = vi.fn().mockResolvedValue({});
    (client.getGmailClient as any).mockReturnValue({
      users: { settings: { forwardingAddresses: { create: vi.fn().mockResolvedValue({ data: { verificationStatus: 'pending' } }) }, updateAutoForwarding } },
    });
    const out = await googleSetForwardingHandler({ userEmail: 'a@x.com', forwardTo: 'b@x.com', reason: 'leave' }, auth, SESSION);
    const parsed = JSON.parse(out);
    expect(parsed.error).toBe('forwarding_pending_verification');
    expect(parsed.message).toContain('not yet verified');
  });

  it('forwarding surfaces a real create failure instead of enabling forwarding that cannot deliver', async () => {
    const create = vi.fn().mockRejectedValue({ code: 403, message: 'denied' });
    const get = vi.fn().mockRejectedValue({ code: 404, message: 'no such address' });
    const updateAutoForwarding = vi.fn().mockResolvedValue({});
    (client.getGmailClient as any).mockReturnValue({
      users: { settings: { forwardingAddresses: { create, get }, updateAutoForwarding } },
    });
    const out = await googleSetForwardingHandler({ userEmail: 'a@x.com', forwardTo: 'b@x.com', reason: 'leave' }, auth, SESSION);
    expect(JSON.parse(out).error).toBe('google_forbidden');
    expect(updateAutoForwarding).not.toHaveBeenCalled();
  });

  it('forwarding tolerates an already-existing address by reading its verification status', async () => {
    const create = vi.fn().mockRejectedValue({ code: 409, message: 'exists' });
    const get = vi.fn().mockResolvedValue({ data: { verificationStatus: 'accepted' } });
    const updateAutoForwarding = vi.fn().mockResolvedValue({});
    (client.getGmailClient as any).mockReturnValue({
      users: { settings: { forwardingAddresses: { create, get }, updateAutoForwarding } },
    });
    const out = await googleSetForwardingHandler({ userEmail: 'a@x.com', forwardTo: 'b@x.com', reason: 'leave' }, auth, SESSION);
    expect(get).toHaveBeenCalled();
    expect(updateAutoForwarding).toHaveBeenCalled();
    expect(out).toContain('forwarding now');
  });

  it('disable forwarding turns auto-forwarding off and removes the address when asked', async () => {
    const updateAutoForwarding = vi.fn().mockResolvedValue({});
    const del = vi.fn().mockResolvedValue({});
    (client.getGmailClient as any).mockReturnValue({
      users: { settings: { updateAutoForwarding, forwardingAddresses: { delete: del } } },
    });
    const out = await googleDisableForwardingHandler({ userEmail: 'a@x.com', forwardTo: 'b@x.com', removeAddress: true, reason: 'no longer needed' }, auth, SESSION);
    expect(updateAutoForwarding).toHaveBeenCalledWith(expect.objectContaining({ requestBody: { enabled: false } }));
    expect(del).toHaveBeenCalledWith({ userId: 'me', forwardingEmail: 'b@x.com' });
    expect(out).toContain('Disabled mail forwarding');
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
          forwardingAddresses: { create: vi.fn().mockResolvedValue({ data: { verificationStatus: 'accepted' } }) },
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

  it('returns a structured error envelope when a step fails, so the audit records a FAILED mutation', async () => {
    const dir = mockDir({ groups: { list: vi.fn().mockRejectedValue({ code: 403, message: 'no group scope' }) } });
    (client.getDirectoryClient as any).mockReturnValue(dir);
    const out = await googleOffboardUserHandler({ userEmail: 'leaver@x.com', reason: 'departure' }, auth, SESSION);
    const parsed = JSON.parse(out);
    expect(parsed.error).toBe('offboard_incomplete');
    expect(parsed.message).toContain('FAILED');
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
