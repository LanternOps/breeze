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

import * as helpers from './googleHelpers';
import * as client from './googleClient';
import {
  googleLookupUserHandler,
  googleResetPasswordHandler,
  googleSuspendUserHandler,
  googleSignOutHandler,
  googleSetForwardingHandler,
  googleSetVacationHandler,
  googleUpdateUserHandler,
  googleShareCalendarHandler,
} from './aiToolsGoogle';

const auth = {} as any;
const SESSION = 'sess-1';

function armConnection(connOverride?: Record<string, unknown>) {
  (helpers.loadSession as any).mockResolvedValue({ orgId: 'org-A' });
  (helpers.loadGoogleConnection as any).mockResolvedValue({
    orgId: 'org-A',
    status: 'active',
    adminEmail: 'admin@x.com',
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
