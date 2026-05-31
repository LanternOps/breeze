/**
 * Google Workspace helpdesk AI tool handlers.
 *
 * Mirrors aiToolsM365: each handler is (input, auth, sessionId) => Promise<string>
 * and is registered inside createBreezeMcpServer (aiAgentSdkTools.ts). Flow per
 * call: resolve session -> resolve the org's single Google connection (cross-org
 * guard + status check) -> decrypt the SA key -> impersonate (admin for Directory,
 * the target user for Gmail) -> call -> format a concise LLM-readable string.
 *
 * Tier 1 = read (auto). Tier 3 = mutation (per-step human approval + audit; a
 * `reason` is required). All writes go through the existing guardrail/approval
 * gate in aiAgentSdk.ts — these handlers do not bypass it.
 *
 * Note on the "disable login challenge" workflow: Google exposes NO API to turn
 * a user's login challenge off for 10 minutes (admin-console only). The
 * google_signout tool is the supported substitute — it ends all the user's
 * sessions, which clears most lockout states.
 */

import { randomBytes } from 'node:crypto';
import type { AuthContext } from '../middleware/auth';
import {
  errorString,
  loadSession,
  loadGoogleConnection,
  authorizeGoogleConnection,
  decryptConnectionKey,
} from './googleHelpers';
import {
  getDirectoryClient,
  getGmailClient,
  getCalendarClient,
  normalizeGoogleError,
  type GoogleApiError,
} from './googleClient';
import type { GoogleWorkspaceConnectionRow } from '../db/schema/google';

export const googleToolTiers: Record<string, 1 | 3> = {
  google_lookup_user: 1,
  google_reset_password: 3,
  google_suspend_user: 3,
  google_restore_user: 3,
  google_signout: 3,
  google_set_forwarding: 3,
  google_set_vacation: 3,
  google_update_user: 3,
  google_share_calendar: 3,
  google_offboard_user: 3,
  google_wipe_mobile_device: 3,
};

const CALENDAR_ROLES = ['freeBusyReader', 'reader', 'writer', 'owner'] as const;
type CalendarRole = (typeof CALENDAR_ROLES)[number];

type DirectoryClient = ReturnType<typeof getDirectoryClient>;

/**
 * Issue a mobile-device action to every device enrolled to a user.
 *   - admin_account_wipe: remove ONLY the managed corporate account + its data
 *     (mail/Drive) from the device. Safe for BYOD; the personal device is intact.
 *   - admin_remote_wipe: full factory reset of the entire device. STOLEN-DEVICE
 *     use only — never part of offboarding.
 */
async function wipeMobileDevices(
  dir: DirectoryClient,
  userEmail: string,
  action: 'admin_account_wipe' | 'admin_remote_wipe',
): Promise<number> {
  const list = await dir.mobiledevices.list({ customerId: 'my_customer', query: `email:${userEmail}` });
  const devices = list.data.mobiledevices ?? [];
  let n = 0;
  for (const d of devices) {
    if (!d.resourceId) continue;
    await dir.mobiledevices.action({
      customerId: 'my_customer',
      resourceId: d.resourceId,
      requestBody: { action },
    });
    n++;
  }
  return n;
}

interface StepResult {
  step: string;
  ok: boolean;
  detail: string;
}

async function runStep(step: string, fn: () => Promise<string>): Promise<StepResult> {
  try {
    return { step, ok: true, detail: await fn() };
  } catch (err) {
    const norm = normalizeGoogleError(err);
    return { step, ok: false, detail: `${norm.code}: ${norm.message}` };
  }
}

type ResolvedContext =
  | { error: string }
  | { conn: GoogleWorkspaceConnectionRow; keyJson: string };

async function resolveContext(_auth: AuthContext, sessionId: string): Promise<ResolvedContext> {
  const session = await loadSession(sessionId);
  if (!session) return { error: errorString('session_not_found', 'AI session not found.') };
  const conn = await loadGoogleConnection(session.orgId);
  const authz = authorizeGoogleConnection(conn, session.orgId);
  if (!authz.ok) {
    return {
      error: errorString(
        'no_google_connection',
        'No active Google Workspace connection for this organization. Connect one in settings first.',
      ),
    };
  }
  let keyJson: string;
  try {
    keyJson = decryptConnectionKey(authz.conn);
  } catch (err) {
    return { error: errorString('connection_key_error', (err as Error).message) };
  }
  return { conn: authz.conn, keyJson };
}

function requireString(input: Record<string, unknown>, key: string): string | null {
  const v = input[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

const googleError = (err: unknown): string => {
  const norm = normalizeGoogleError(err);
  return errorString(norm.code, norm.message);
};

/** Generate a strong temporary password (mixed classes, ~20 chars). */
function generateTempPassword(): string {
  const raw = randomBytes(16).toString('base64').replace(/[+/=]/g, '');
  // Guarantee at least one of each required class.
  return `Bz9!${raw.slice(0, 16)}`;
}

// ── Tier 1: read ──────────────────────────────────────────────────────────────

export async function googleLookupUserHandler(
  input: Record<string, unknown>,
  auth: AuthContext,
  sessionId: string,
): Promise<string> {
  const ctx = await resolveContext(auth, sessionId);
  if ('error' in ctx) return ctx.error;
  const email = requireString(input, 'userEmail');
  if (!email) return errorString('missing_user', 'A user email (primary email) is required.');

  try {
    const dir = getDirectoryClient(ctx.keyJson, ctx.conn.adminEmail);
    const res = await dir.users.get({ userKey: email });
    const u = res.data;
    const summary = {
      primaryEmail: u.primaryEmail,
      name: u.name?.fullName,
      suspended: u.suspended ?? false,
      isAdmin: u.isAdmin ?? false,
      isEnrolledIn2Sv: u.isEnrolledIn2Sv ?? false,
      lastLoginTime: u.lastLoginTime,
      orgUnitPath: u.orgUnitPath,
      aliases: u.aliases ?? [],
    };
    return `Google Workspace user profile: ${JSON.stringify(summary)}`;
  } catch (err) {
    return googleError(err);
  }
}

// ── Tier 3: mutations (require reason + approval) ─────────────────────────────

export async function googleResetPasswordHandler(
  input: Record<string, unknown>,
  auth: AuthContext,
  sessionId: string,
): Promise<string> {
  const reason = requireString(input, 'reason');
  if (!reason) return errorString('missing_reason', 'A reason is required for this action.');
  const ctx = await resolveContext(auth, sessionId);
  if ('error' in ctx) return ctx.error;
  const email = requireString(input, 'userEmail');
  if (!email) return errorString('missing_user', 'A user email is required.');

  const temp = generateTempPassword();
  try {
    const dir = getDirectoryClient(ctx.keyJson, ctx.conn.adminEmail);
    await dir.users.update({
      userKey: email,
      requestBody: { password: temp, changePasswordAtNextLogin: true },
    });
    return `Reset the password for ${email}. Temporary password: ${temp} (the user must change it at next sign-in).`;
  } catch (err) {
    return googleError(err);
  }
}

export async function googleSuspendUserHandler(
  input: Record<string, unknown>,
  auth: AuthContext,
  sessionId: string,
): Promise<string> {
  const reason = requireString(input, 'reason');
  if (!reason) return errorString('missing_reason', 'A reason is required for this action.');
  const ctx = await resolveContext(auth, sessionId);
  if ('error' in ctx) return ctx.error;
  const email = requireString(input, 'userEmail');
  if (!email) return errorString('missing_user', 'A user email is required.');

  try {
    const dir = getDirectoryClient(ctx.keyJson, ctx.conn.adminEmail);
    await dir.users.update({ userKey: email, requestBody: { suspended: true } });
    return `Suspended Google Workspace user ${email}.`;
  } catch (err) {
    return googleError(err);
  }
}

export async function googleRestoreUserHandler(
  input: Record<string, unknown>,
  auth: AuthContext,
  sessionId: string,
): Promise<string> {
  const reason = requireString(input, 'reason');
  if (!reason) return errorString('missing_reason', 'A reason is required for this action.');
  const ctx = await resolveContext(auth, sessionId);
  if ('error' in ctx) return ctx.error;
  const email = requireString(input, 'userEmail');
  if (!email) return errorString('missing_user', 'A user email is required.');

  try {
    const dir = getDirectoryClient(ctx.keyJson, ctx.conn.adminEmail);
    await dir.users.update({ userKey: email, requestBody: { suspended: false } });
    return `Restored (un-suspended) Google Workspace user ${email}.`;
  } catch (err) {
    return googleError(err);
  }
}

export async function googleSignOutHandler(
  input: Record<string, unknown>,
  auth: AuthContext,
  sessionId: string,
): Promise<string> {
  const reason = requireString(input, 'reason');
  if (!reason) return errorString('missing_reason', 'A reason is required for this action.');
  const ctx = await resolveContext(auth, sessionId);
  if ('error' in ctx) return ctx.error;
  const email = requireString(input, 'userEmail');
  if (!email) return errorString('missing_user', 'A user email is required.');

  try {
    const dir = getDirectoryClient(ctx.keyJson, ctx.conn.adminEmail);
    await dir.users.signOut({ userKey: email });
    return `Signed ${email} out of all sessions. (Note: Google has no API to toggle the login challenge for 10 minutes; sign-out clears most lockout states.)`;
  } catch (err) {
    return googleError(err);
  }
}

export async function googleSetForwardingHandler(
  input: Record<string, unknown>,
  auth: AuthContext,
  sessionId: string,
): Promise<string> {
  const reason = requireString(input, 'reason');
  if (!reason) return errorString('missing_reason', 'A reason is required for this action.');
  const ctx = await resolveContext(auth, sessionId);
  if ('error' in ctx) return ctx.error;
  const email = requireString(input, 'userEmail');
  const forwardTo = requireString(input, 'forwardTo');
  if (!email) return errorString('missing_user', 'A user email (the mailbox to forward FROM) is required.');
  if (!forwardTo) return errorString('missing_forward_to', 'A forwarding destination address is required.');
  const keepCopy = input.keepCopy !== false; // default to keeping a copy

  try {
    // Gmail per-mailbox settings impersonate the USER, not the admin.
    const gmailClient = getGmailClient(ctx.keyJson, email);
    // The forwarding address must exist first. Creating it may require the user
    // to verify it (Google sends a confirmation) unless same-domain policy
    // auto-accepts. Tolerate "already exists".
    try {
      await gmailClient.users.settings.forwardingAddresses.create({
        userId: 'me',
        requestBody: { forwardingEmail: forwardTo },
      });
    } catch (err) {
      const norm = normalizeGoogleError(err);
      // 409/duplicate is fine; anything else (e.g. needs verification) is surfaced.
      if (norm.code !== 'google_error' && norm.code !== 'google_not_found') {
        // fall through to enabling; if it truly failed, updateAutoForwarding errors next.
      }
    }
    await gmailClient.users.settings.updateAutoForwarding({
      userId: 'me',
      requestBody: {
        enabled: true,
        emailAddress: forwardTo,
        disposition: keepCopy ? 'leaveInInbox' : 'archive',
      },
    });
    return `Enabled forwarding from ${email} to ${forwardTo} (${keepCopy ? 'keeping' : 'not keeping'} a copy in ${email}). If Google requires the destination to be verified, the owner must confirm the verification email before forwarding takes effect.`;
  } catch (err) {
    return googleError(err);
  }
}

export async function googleSetVacationHandler(
  input: Record<string, unknown>,
  auth: AuthContext,
  sessionId: string,
): Promise<string> {
  const reason = requireString(input, 'reason');
  if (!reason) return errorString('missing_reason', 'A reason is required for this action.');
  const ctx = await resolveContext(auth, sessionId);
  if ('error' in ctx) return ctx.error;
  const email = requireString(input, 'userEmail');
  if (!email) return errorString('missing_user', 'A user email is required.');
  const enable = input.enable !== false; // default enable
  const subject = requireString(input, 'subject') ?? '';
  const message = requireString(input, 'message') ?? '';
  if (enable && !message) return errorString('missing_message', 'A response message is required to enable the vacation responder.');

  try {
    const gmailClient = getGmailClient(ctx.keyJson, email);
    await gmailClient.users.settings.updateVacation({
      userId: 'me',
      requestBody: {
        enableAutoReply: enable,
        responseSubject: subject || undefined,
        responseBodyPlainText: message || undefined,
      },
    });
    return enable
      ? `Enabled the out-of-office responder for ${email}.`
      : `Disabled the out-of-office responder for ${email}.`;
  } catch (err) {
    return googleError(err);
  }
}

export async function googleUpdateUserHandler(
  input: Record<string, unknown>,
  auth: AuthContext,
  sessionId: string,
): Promise<string> {
  const reason = requireString(input, 'reason');
  if (!reason) return errorString('missing_reason', 'A reason is required for this action.');
  const ctx = await resolveContext(auth, sessionId);
  if ('error' in ctx) return ctx.error;
  const email = requireString(input, 'userEmail');
  if (!email) return errorString('missing_user', 'A user email is required.');

  const givenName = requireString(input, 'givenName');
  const familyName = requireString(input, 'familyName');
  const recoveryEmail = requireString(input, 'recoveryEmail');
  const recoveryPhone = requireString(input, 'recoveryPhone');
  const addAlias = requireString(input, 'addAlias');
  const removeAlias = requireString(input, 'removeAlias');

  try {
    const dir = getDirectoryClient(ctx.keyJson, ctx.conn.adminEmail);
    const changes: string[] = [];

    if (givenName || familyName || recoveryEmail || recoveryPhone) {
      const requestBody: Record<string, unknown> = {};
      if (givenName || familyName) {
        requestBody.name = {
          ...(givenName ? { givenName } : {}),
          ...(familyName ? { familyName } : {}),
        };
      }
      if (recoveryEmail) requestBody.recoveryEmail = recoveryEmail;
      if (recoveryPhone) requestBody.recoveryPhone = recoveryPhone;
      await dir.users.update({ userKey: email, requestBody });
      changes.push('profile');
    }
    if (addAlias) {
      await dir.users.aliases.insert({ userKey: email, requestBody: { alias: addAlias } });
      changes.push(`added alias ${addAlias}`);
    }
    if (removeAlias) {
      await dir.users.aliases.delete({ userKey: email, alias: removeAlias });
      changes.push(`removed alias ${removeAlias}`);
    }
    if (changes.length === 0) {
      return errorString('no_changes', 'No fields to update were provided.');
    }
    return `Updated ${email}: ${changes.join(', ')}.`;
  } catch (err) {
    return googleError(err);
  }
}

export async function googleShareCalendarHandler(
  input: Record<string, unknown>,
  auth: AuthContext,
  sessionId: string,
): Promise<string> {
  const reason = requireString(input, 'reason');
  if (!reason) return errorString('missing_reason', 'A reason is required for this action.');
  const ctx = await resolveContext(auth, sessionId);
  if ('error' in ctx) return ctx.error;
  const ownerEmail = requireString(input, 'ownerEmail');
  const shareWithEmail = requireString(input, 'shareWithEmail');
  if (!ownerEmail) return errorString('missing_owner', 'The calendar owner email is required.');
  if (!shareWithEmail) return errorString('missing_share_with', 'The email to share the calendar with is required.');
  // Default to a read share of the owner's primary calendar.
  const calendarId = requireString(input, 'calendarId') ?? 'primary';
  const roleInput = requireString(input, 'role') ?? 'reader';
  if (!CALENDAR_ROLES.includes(roleInput as CalendarRole)) {
    return errorString('invalid_role', `role must be one of: ${CALENDAR_ROLES.join(', ')}.`);
  }
  const role = roleInput as CalendarRole;

  try {
    // Calendar ACL writes impersonate the calendar OWNER, not the admin.
    const cal = getCalendarClient(ctx.keyJson, ownerEmail);
    await cal.acl.insert({
      calendarId,
      requestBody: { role, scope: { type: 'user', value: shareWithEmail } },
    });
    const which = calendarId === 'primary' ? `${ownerEmail}'s primary calendar` : `calendar ${calendarId}`;
    return `Shared ${which} with ${shareWithEmail} as ${role}.`;
  } catch (err) {
    return googleError(err);
  }
}

/**
 * Guided offboard: a single, best-effort sequence over one departing user.
 * Mailbox steps (OOO, forwarding) run FIRST, while the account is still active —
 * suspending first would block per-user Gmail impersonation. The mobile step is
 * a SELECTIVE account wipe (corporate data only), never a full device wipe,
 * because the fleet is BYOD. Suspend is last. Each step is independent: a failure
 * is recorded and the rest still run.
 */
export async function googleOffboardUserHandler(
  input: Record<string, unknown>,
  auth: AuthContext,
  sessionId: string,
): Promise<string> {
  const reason = requireString(input, 'reason');
  if (!reason) return errorString('missing_reason', 'A reason is required for this action.');
  const ctx = await resolveContext(auth, sessionId);
  if ('error' in ctx) return ctx.error;
  const email = requireString(input, 'userEmail');
  if (!email) return errorString('missing_user', 'A user email is required.');

  const forwardTo = requireString(input, 'forwardTo'); // optional manager mailbox
  const oooMessage = requireString(input, 'oooMessage'); // optional auto-reply text
  const accountWipeMobile = input.accountWipeMobile !== false; // default true (SELECTIVE)
  const removeFromGroups = input.removeFromGroups !== false; // default true
  const revokeTokens = input.revokeTokens !== false; // default true
  const doSuspend = input.suspend !== false; // default true

  const dir = getDirectoryClient(ctx.keyJson, ctx.conn.adminEmail);
  const steps: StepResult[] = [];

  // 1. Mailbox settings first (account still active for impersonation).
  if (oooMessage) {
    steps.push(await runStep('out_of_office', async () => {
      const g = getGmailClient(ctx.keyJson, email);
      await g.users.settings.updateVacation({
        userId: 'me',
        requestBody: { enableAutoReply: true, responseBodyPlainText: oooMessage },
      });
      return 'auto-reply enabled';
    }));
  }
  if (forwardTo) {
    steps.push(await runStep('forwarding', async () => {
      const g = getGmailClient(ctx.keyJson, email);
      try {
        await g.users.settings.forwardingAddresses.create({
          userId: 'me',
          requestBody: { forwardingEmail: forwardTo },
        });
      } catch {
        // tolerate already-exists / pending-verification; updateAutoForwarding will surface a real failure
      }
      await g.users.settings.updateAutoForwarding({
        userId: 'me',
        requestBody: { enabled: true, emailAddress: forwardTo, disposition: 'archive' },
      });
      return `forwarding to ${forwardTo} (no copy kept)`;
    }));
  }

  // 2. Revoke third-party OAuth app grants.
  if (revokeTokens) {
    steps.push(await runStep('revoke_oauth_tokens', async () => {
      const res = await dir.tokens.list({ userKey: email });
      let n = 0;
      for (const t of res.data.items ?? []) {
        if (!t.clientId) continue;
        await dir.tokens.delete({ userKey: email, clientId: t.clientId });
        n++;
      }
      return `revoked ${n} OAuth app grant(s)`;
    }));
  }

  // 3. Remove from all groups.
  if (removeFromGroups) {
    steps.push(await runStep('remove_from_groups', async () => {
      const res = await dir.groups.list({ userKey: email, maxResults: 200 });
      let n = 0;
      for (const grp of res.data.groups ?? []) {
        if (!grp.id) continue;
        await dir.members.delete({ groupKey: grp.id, memberKey: email });
        n++;
      }
      return `removed from ${n} group(s)`;
    }));
  }

  // 4. SELECTIVE mobile account-wipe (BYOD: corporate data only).
  if (accountWipeMobile) {
    steps.push(await runStep('mobile_account_wipe', async () => {
      const n = await wipeMobileDevices(dir, email, 'admin_account_wipe');
      return n === 0 ? 'no mobile devices enrolled' : `account-wiped ${n} device(s) (corporate data only)`;
    }));
  }

  // 5. End all sessions.
  steps.push(await runStep('sign_out', async () => {
    await dir.users.signOut({ userKey: email });
    return 'all sessions ended';
  }));

  // 6. Suspend last.
  if (doSuspend) {
    steps.push(await runStep('suspend', async () => {
      await dir.users.update({ userKey: email, requestBody: { suspended: true } });
      return 'sign-in blocked';
    }));
  }

  const okCount = steps.filter((s) => s.ok).length;
  const lines = steps.map((s) => `  - ${s.step}: ${s.ok ? 'OK' : 'FAILED'} (${s.detail})`).join('\n');
  return `Offboard of ${email}: ${okCount}/${steps.length} steps OK.\n${lines}\nNote: the mobile step removed only the corporate account (BYOD-safe), not the whole device.`;
}

/**
 * STOLEN-DEVICE remote wipe: a full factory reset of every device enrolled to a
 * user. This erases the ENTIRE device, not just corporate data — it is NOT part
 * of offboarding (offboard uses a selective account wipe). Use only for lost or
 * stolen hardware.
 */
export async function googleWipeMobileDeviceHandler(
  input: Record<string, unknown>,
  auth: AuthContext,
  sessionId: string,
): Promise<string> {
  const reason = requireString(input, 'reason');
  if (!reason) return errorString('missing_reason', 'A reason is required for this action.');
  const ctx = await resolveContext(auth, sessionId);
  if ('error' in ctx) return ctx.error;
  const email = requireString(input, 'userEmail');
  if (!email) return errorString('missing_user', 'The user whose lost/stolen device should be fully wiped is required.');

  try {
    const dir = getDirectoryClient(ctx.keyJson, ctx.conn.adminEmail);
    const n = await wipeMobileDevices(dir, email, 'admin_remote_wipe');
    if (n === 0) return `No mobile devices are enrolled for ${email}; nothing to wipe.`;
    return `Issued a FULL factory reset to ${n} device(s) for ${email} (stolen-device remote wipe). This erases the entire device, not just corporate data.`;
  } catch (err) {
    return googleError(err);
  }
}

// Keep the GoogleApiError type referenced for downstream importers/tests.
export type { GoogleApiError };
