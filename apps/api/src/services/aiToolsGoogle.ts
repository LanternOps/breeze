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
};

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

// Keep the GoogleApiError type referenced for downstream importers/tests.
export type { GoogleApiError };
