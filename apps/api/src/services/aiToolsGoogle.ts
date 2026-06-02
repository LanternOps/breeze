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
  getLicensingClient,
  normalizeGoogleError,
  type GoogleApiError,
} from './googleClient';
import type { GoogleWorkspaceConnectionRow } from '../db/schema/google';
import { getEmailService } from './email';

export const googleToolTiers: Record<string, 1 | 3> = {
  google_lookup_user: 1,
  google_reset_password: 3,
  google_suspend_user: 3,
  google_restore_user: 3,
  google_signout: 3,
  google_set_forwarding: 3,
  google_disable_forwarding: 3,
  google_set_vacation: 3,
  google_update_user: 3,
  google_share_calendar: 3,
  google_offboard_user: 3,
  google_wipe_mobile_device: 3,
  google_security_drift: 1,
  google_email_report: 1,
  google_list_user_groups: 1,
  google_add_to_group: 3,
  google_remove_from_group: 3,
  google_move_ou: 3,
  google_rename_user: 3,
  google_reset_2sv: 3,
  google_add_mail_delegate: 3,
  google_remove_mail_delegate: 3,
  google_list_licenses: 1,
  google_assign_license: 3,
  google_remove_license: 3,
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

// ── Group membership (cluster 3) ──────────────────────────────────────────────

export async function googleListUserGroupsHandler(
  input: Record<string, unknown>,
  auth: AuthContext,
  sessionId: string,
): Promise<string> {
  const ctx = await resolveContext(auth, sessionId);
  if ('error' in ctx) return ctx.error;
  const email = requireString(input, 'userEmail');
  if (!email) return errorString('missing_user', 'A user email is required.');

  try {
    const dir = getDirectoryClient(ctx.keyJson, ctx.conn.adminEmail);
    const res = await dir.groups.list({ userKey: email, maxResults: 200 });
    const groups = (res.data.groups ?? []).map((g) => ({ email: g.email, name: g.name, id: g.id }));
    return `Google Workspace groups for ${email} (${groups.length}): ${JSON.stringify(groups)}`;
  } catch (err) {
    return googleError(err);
  }
}

export async function googleAddToGroupHandler(
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
  const groupEmail = requireString(input, 'groupEmail');
  if (!groupEmail) return errorString('missing_group', 'A group email is required.');
  const roleRaw = requireString(input, 'role');
  const role =
    roleRaw && ['MEMBER', 'MANAGER', 'OWNER'].includes(roleRaw.toUpperCase())
      ? roleRaw.toUpperCase()
      : 'MEMBER';

  try {
    const dir = getDirectoryClient(ctx.keyJson, ctx.conn.adminEmail);
    await dir.members.insert({ groupKey: groupEmail, requestBody: { email, role } });
    return `Added ${email} to group ${groupEmail} as ${role}.`;
  } catch (err) {
    return googleError(err);
  }
}

export async function googleRemoveFromGroupHandler(
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
  const groupEmail = requireString(input, 'groupEmail');
  if (!groupEmail) return errorString('missing_group', 'A group email is required.');

  try {
    const dir = getDirectoryClient(ctx.keyJson, ctx.conn.adminEmail);
    await dir.members.delete({ groupKey: groupEmail, memberKey: email });
    return `Removed ${email} from group ${groupEmail}.`;
  } catch (err) {
    return googleError(err);
  }
}

export async function googleMoveOuHandler(
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
  const orgUnitPath = requireString(input, 'orgUnitPath');
  if (!orgUnitPath) return errorString('missing_ou', 'An orgUnitPath (e.g. "/Sales") is required.');

  try {
    const dir = getDirectoryClient(ctx.keyJson, ctx.conn.adminEmail);
    await dir.users.update({ userKey: email, requestBody: { orgUnitPath } });
    return `Moved ${email} to org unit ${orgUnitPath}.`;
  } catch (err) {
    return googleError(err);
  }
}

export async function googleRenameUserHandler(
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
  const newPrimaryEmail = requireString(input, 'newPrimaryEmail');
  if (!newPrimaryEmail) return errorString('missing_new_email', 'A newPrimaryEmail is required.');

  try {
    const dir = getDirectoryClient(ctx.keyJson, ctx.conn.adminEmail);
    await dir.users.update({ userKey: email, requestBody: { primaryEmail: newPrimaryEmail } });
    return `Renamed ${email} to ${newPrimaryEmail} (Google keeps the old address as an alias).`;
  } catch (err) {
    return googleError(err);
  }
}

// ── License management (cluster 3) ────────────────────────────────────────────

export async function googleListLicensesHandler(
  input: Record<string, unknown>,
  auth: AuthContext,
  sessionId: string,
): Promise<string> {
  const ctx = await resolveContext(auth, sessionId);
  if ('error' in ctx) return ctx.error;
  const productId = requireString(input, 'productId');
  if (!productId) return errorString('missing_product', 'A productId is required (e.g. "Google-Apps").');

  try {
    const lic = getLicensingClient(ctx.keyJson, ctx.conn.adminEmail);
    const res = await lic.licenseAssignments.listForProduct({
      productId,
      customerId: 'my_customer',
      maxResults: 100,
    });
    const items = (res.data.items ?? []).map((a) => ({ user: a.userId, skuId: a.skuId, skuName: a.skuName }));
    return `Google Workspace license assignments for product ${productId} (${items.length}): ${JSON.stringify(items)}`;
  } catch (err) {
    return googleError(err);
  }
}

export async function googleAssignLicenseHandler(
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
  const productId = requireString(input, 'productId');
  const skuId = requireString(input, 'skuId');
  if (!productId || !skuId) return errorString('missing_sku', 'Both productId and skuId are required.');

  try {
    const lic = getLicensingClient(ctx.keyJson, ctx.conn.adminEmail);
    await lic.licenseAssignments.insert({ productId, skuId, requestBody: { userId: email } });
    return `Assigned license ${productId}/${skuId} to ${email}.`;
  } catch (err) {
    return googleError(err);
  }
}

export async function googleRemoveLicenseHandler(
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
  const productId = requireString(input, 'productId');
  const skuId = requireString(input, 'skuId');
  if (!productId || !skuId) return errorString('missing_sku', 'Both productId and skuId are required.');

  try {
    const lic = getLicensingClient(ctx.keyJson, ctx.conn.adminEmail);
    await lic.licenseAssignments.delete({ productId, skuId, userId: email });
    return `Removed license ${productId}/${skuId} from ${email}.`;
  } catch (err) {
    return googleError(err);
  }
}

export async function googleResetTwoSvHandler(
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
    await dir.twoStepVerification.turnOff({ userKey: email });
    return `Turned off 2-step verification for ${email}. They can re-enroll on next sign-in (use this when a user lost their second factor).`;
  } catch (err) {
    return googleError(err);
  }
}

export async function googleAddMailDelegateHandler(
  input: Record<string, unknown>,
  auth: AuthContext,
  sessionId: string,
): Promise<string> {
  const reason = requireString(input, 'reason');
  if (!reason) return errorString('missing_reason', 'A reason is required for this action.');
  const ctx = await resolveContext(auth, sessionId);
  if ('error' in ctx) return ctx.error;
  const email = requireString(input, 'userEmail');
  if (!email) return errorString('missing_user', 'A user (mailbox owner) email is required.');
  const delegateEmail = requireString(input, 'delegateEmail');
  if (!delegateEmail) return errorString('missing_delegate', 'A delegateEmail is required.');

  try {
    const gmailClient = getGmailClient(ctx.keyJson, email);
    await gmailClient.users.settings.delegates.create({ userId: 'me', requestBody: { delegateEmail } });
    return `Granted ${delegateEmail} delegated access to ${email}'s mailbox (read/send/manage).`;
  } catch (err) {
    return googleError(err);
  }
}

export async function googleRemoveMailDelegateHandler(
  input: Record<string, unknown>,
  auth: AuthContext,
  sessionId: string,
): Promise<string> {
  const reason = requireString(input, 'reason');
  if (!reason) return errorString('missing_reason', 'A reason is required for this action.');
  const ctx = await resolveContext(auth, sessionId);
  if ('error' in ctx) return ctx.error;
  const email = requireString(input, 'userEmail');
  if (!email) return errorString('missing_user', 'A user (mailbox owner) email is required.');
  const delegateEmail = requireString(input, 'delegateEmail');
  if (!delegateEmail) return errorString('missing_delegate', 'A delegateEmail is required.');

  try {
    const gmailClient = getGmailClient(ctx.keyJson, email);
    await gmailClient.users.settings.delegates.delete({ userId: 'me', delegateEmail });
    return `Removed ${delegateEmail}'s delegated access to ${email}'s mailbox.`;
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

type ForwardingOutcome =
  | { ok: true; verificationStatus: string }
  | { ok: false; error: { code: string; message: string } };

/**
 * Ensure the forwarding address exists and turn on auto-forwarding for the
 * impersonated mailbox. Returns the destination's verificationStatus ('accepted'
 * once mail will actually forward; 'pending' until the owner confirms Google's
 * verification email). A create failure is NOT swallowed: if the create throws,
 * we probe with a read — the address may already exist from a prior run (Gmail
 * returns 409, which normalizeGoogleError can't tell apart from other 4xx by
 * code) — and only surface the create error when the address is genuinely
 * absent, so we never report forwarding "enabled" when it can't deliver.
 */
async function enableAutoForwarding(
  gmailClient: ReturnType<typeof getGmailClient>,
  forwardTo: string,
  keepCopy: boolean,
): Promise<ForwardingOutcome> {
  let verificationStatus: string | null | undefined;
  try {
    const created = await gmailClient.users.settings.forwardingAddresses.create({
      userId: 'me',
      requestBody: { forwardingEmail: forwardTo },
    });
    verificationStatus = created.data.verificationStatus;
  } catch (createErr) {
    try {
      const existing = await gmailClient.users.settings.forwardingAddresses.get({
        userId: 'me',
        forwardingEmail: forwardTo,
      });
      verificationStatus = existing.data.verificationStatus;
    } catch {
      return { ok: false, error: normalizeGoogleError(createErr) };
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
  return { ok: true, verificationStatus: verificationStatus ?? 'unknown' };
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
    const outcome = await enableAutoForwarding(gmailClient, forwardTo, keepCopy);
    if (!outcome.ok) {
      return errorString(
        outcome.error.code,
        `Could not set up forwarding from ${email} to ${forwardTo}: ${outcome.error.message}`,
      );
    }
    if (outcome.verificationStatus !== 'accepted') {
      // Forwarding is configured but the destination is unverified — Gmail will
      // NOT deliver until the owner confirms. Surface this as a structured error
      // so it is not recorded as a completed forward (it isn't, yet).
      return errorString(
        'forwarding_pending_verification',
        `Forwarding from ${email} to ${forwardTo} is configured but the destination is not yet verified (status: ${outcome.verificationStatus}). Mail will NOT forward until the owner of ${forwardTo} confirms the verification email Google sent; it will start automatically once verified.`,
      );
    }
    return `Enabled forwarding from ${email} to ${forwardTo} (${keepCopy ? 'keeping' : 'not keeping'} a copy in ${email}). The destination is verified, so mail is forwarding now.`;
  } catch (err) {
    return googleError(err);
  }
}

export async function googleDisableForwardingHandler(
  input: Record<string, unknown>,
  auth: AuthContext,
  sessionId: string,
): Promise<string> {
  const reason = requireString(input, 'reason');
  if (!reason) return errorString('missing_reason', 'A reason is required for this action.');
  const ctx = await resolveContext(auth, sessionId);
  if ('error' in ctx) return ctx.error;
  const email = requireString(input, 'userEmail');
  if (!email) return errorString('missing_user', 'A user email (the mailbox to stop forwarding) is required.');
  // Optionally also delete the forwarding address; `forwardTo` is only needed
  // for that. Disabling auto-forwarding alone is enough to stop delivery.
  const removeAddress = input.removeAddress === true;
  const forwardTo = requireString(input, 'forwardTo');

  try {
    // Gmail per-mailbox settings impersonate the USER, not the admin.
    const gmailClient = getGmailClient(ctx.keyJson, email);
    await gmailClient.users.settings.updateAutoForwarding({
      userId: 'me',
      requestBody: { enabled: false },
    });
    if (removeAddress && forwardTo) {
      try {
        await gmailClient.users.settings.forwardingAddresses.delete({
          userId: 'me',
          forwardingEmail: forwardTo,
        });
      } catch (delErr) {
        const norm = normalizeGoogleError(delErr);
        // Already gone is fine; surface any other deletion failure.
        if (norm.code !== 'google_not_found') {
          return errorString(
            norm.code,
            `Disabled forwarding for ${email}, but could not remove the forwarding address ${forwardTo}: ${norm.message}`,
          );
        }
      }
    }
    return `Disabled mail forwarding for ${email}.${removeAddress && forwardTo ? ` Removed the forwarding address ${forwardTo}.` : ''}`;
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
      const outcome = await enableAutoForwarding(g, forwardTo, false);
      // A genuine create/enable failure throws so this step is recorded FAILED
      // (and the offboard reports incomplete), rather than being swallowed.
      if (!outcome.ok) throw new Error(`${outcome.error.code}: ${outcome.error.message}`);
      return outcome.verificationStatus === 'accepted'
        ? `forwarding to ${forwardTo} (no copy kept)`
        : `forwarding to ${forwardTo} configured but PENDING verification (status: ${outcome.verificationStatus}); will not deliver until ${forwardTo} is confirmed`;
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
  const summary = `Offboard of ${email}: ${okCount}/${steps.length} steps OK.\n${lines}\nNote: the mobile step removed only the corporate account (BYOD-safe), not the whole device.`;
  // If any step failed, surface a structured error so the post-tool-use audit
  // records this as a FAILED Tier-3 mutation. Returning prose makes the success
  // detector (JSON-with-error-key) treat a 0/6 offboard as a success — a leaver
  // who still has access showing a green check in the audit trail.
  if (okCount < steps.length) {
    return errorString('offboard_incomplete', summary);
  }
  return summary;
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

// ── Cluster 2: security drift (read) + reports-by-email ───────────────────────

interface DriftUser {
  primaryEmail?: string | null;
  isAdmin?: boolean | null;
  suspended?: boolean | null;
  isEnrolledIn2Sv?: boolean | null;
  lastLoginTime?: string | null;
}

/** Page through every user in the customer's directory (projection kept small). */
async function listAllDomainUsers(dir: DirectoryClient): Promise<DriftUser[]> {
  const users: DriftUser[] = [];
  let pageToken: string | undefined;
  do {
    const res = await dir.users.list({
      customer: 'my_customer',
      maxResults: 500,
      orderBy: 'email',
      pageToken,
      fields: 'nextPageToken,users(primaryEmail,isAdmin,suspended,isEnrolledIn2Sv,lastLoginTime)',
    });
    for (const u of res.data.users ?? []) users.push(u as DriftUser);
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return users;
}

interface DriftBucket {
  count: number;
  users: string[];
}
interface SecurityDrift {
  totalUsers: number;
  noTwoStep: DriftBucket;
  superAdmins: DriftBucket;
  suspended: DriftBucket;
  neverLoggedIn: DriftBucket;
  stale: DriftBucket & { thresholdDays: number };
}

/** Bucket users into the security-drift categories. Pure function (testable). */
function computeSecurityDrift(users: DriftUser[], staleDays: number, nowMs: number): SecurityDrift {
  const staleMs = staleDays * 86_400_000;
  const emailOf = (u: DriftUser) => u.primaryEmail ?? '(unknown)';
  const active = users.filter((u) => !u.suspended);
  const bucket = (list: DriftUser[]): DriftBucket => ({ count: list.length, users: list.map(emailOf).slice(0, 50) });

  const noTwoStep = active.filter((u) => u.isEnrolledIn2Sv === false);
  const superAdmins = users.filter((u) => u.isAdmin === true);
  const suspended = users.filter((u) => u.suspended === true);
  const neverLoggedIn = active.filter((u) => {
    const t = Date.parse(u.lastLoginTime ?? '');
    return !u.lastLoginTime || Number.isNaN(t) || t <= 0;
  });
  const stale = active.filter((u) => {
    const t = Date.parse(u.lastLoginTime ?? '');
    return t > 0 && nowMs - t > staleMs;
  });

  return {
    totalUsers: users.length,
    noTwoStep: bucket(noTwoStep),
    superAdmins: bucket(superAdmins),
    suspended: bucket(suspended),
    neverLoggedIn: bucket(neverLoggedIn),
    stale: { ...bucket(stale), thresholdDays: staleDays },
  };
}

function resolveStaleDays(input: Record<string, unknown>): number {
  const v = input.staleDays;
  return typeof v === 'number' && v > 0 && v <= 3650 ? v : 90;
}

export async function googleSecurityDriftHandler(
  input: Record<string, unknown>,
  auth: AuthContext,
  sessionId: string,
): Promise<string> {
  const ctx = await resolveContext(auth, sessionId);
  if ('error' in ctx) return ctx.error;
  const staleDays = resolveStaleDays(input);
  try {
    const dir = getDirectoryClient(ctx.keyJson, ctx.conn.adminEmail);
    const users = await listAllDomainUsers(dir);
    const drift = computeSecurityDrift(users, staleDays, Date.now());
    return `Google Workspace security drift for ${ctx.conn.customerDomain}: ${JSON.stringify(drift)}`;
  } catch (err) {
    return googleError(err);
  }
}

/** Minimal HTML report for the drift email. */
function renderDriftHtml(domain: string, drift: SecurityDrift): string {
  const row = (label: string, b: DriftBucket) =>
    `<tr><td style="padding:4px 12px 4px 0"><b>${label}</b></td><td style="padding:4px 0">${b.count}</td></tr>`;
  const list = (label: string, b: DriftBucket) =>
    b.users.length
      ? `<h4 style="margin:14px 0 4px">${label} (${b.count}${b.count > b.users.length ? ', first ' + b.users.length : ''})</h4><div style="font:13px/1.5 monospace">${b.users.join('<br>')}</div>`
      : '';
  return `<div style="font:14px/1.5 -apple-system,Segoe UI,sans-serif">
<h2 style="margin:0 0 8px">Google Workspace security drift — ${domain}</h2>
<p>${drift.totalUsers} users scanned. Stale threshold: ${drift.stale.thresholdDays} days.</p>
<table>${row('No 2-step', drift.noTwoStep)}${row('Super-admins', drift.superAdmins)}${row('Suspended', drift.suspended)}${row('Never logged in', drift.neverLoggedIn)}${row('Stale', drift.stale)}</table>
${list('Users with no 2-step verification', drift.noTwoStep)}
${list('Super-admins', drift.superAdmins)}
${list('Never logged in', drift.neverLoggedIn)}
${list('Stale accounts', drift.stale)}
</div>`;
}

/**
 * Run the security-drift report and email it. The recipient is LOCKED to the
 * connection's admin address (no arbitrary recipient) so the agent cannot use
 * this to exfiltrate directory data. Tier 1: it changes no Google or device
 * state, only emails a read-only summary to the org's own admin.
 */
export async function googleEmailReportHandler(
  input: Record<string, unknown>,
  auth: AuthContext,
  sessionId: string,
): Promise<string> {
  const ctx = await resolveContext(auth, sessionId);
  if ('error' in ctx) return ctx.error;
  const svc = getEmailService();
  if (!svc) {
    return errorString('email_not_configured', 'No email provider is configured on this instance; cannot send the report.');
  }
  const staleDays = resolveStaleDays(input);
  try {
    const dir = getDirectoryClient(ctx.keyJson, ctx.conn.adminEmail);
    const users = await listAllDomainUsers(dir);
    const drift = computeSecurityDrift(users, staleDays, Date.now());
    const to = ctx.conn.adminEmail; // locked to the connection admin
    await svc.sendEmail({
      to,
      subject: `Google Workspace security drift — ${ctx.conn.customerDomain}`,
      html: renderDriftHtml(ctx.conn.customerDomain, drift),
    });
    return `Emailed the Google Workspace security-drift report for ${ctx.conn.customerDomain} to ${to} (${users.length} users scanned, stale threshold ${staleDays}d).`;
  } catch (err) {
    return googleError(err);
  }
}

// Keep the GoogleApiError type referenced for downstream importers/tests.
export type { GoogleApiError, SecurityDrift };
export { computeSecurityDrift };
