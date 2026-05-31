/**
 * Google Workspace API client construction for the Breeze identity tools.
 *
 * Auth model: per-org service account with domain-wide delegation (DWD). One
 * service account, TWO impersonation subjects:
 *   - Admin SDK Directory calls impersonate the customer super-admin
 *     (`connection.adminEmail`).
 *   - Gmail (per-mailbox) calls impersonate the TARGET end user, because
 *     forwarding / vacation are per-user mailbox settings, not admin operations.
 *
 * The DWD grant in the customer's Admin console (Security > API controls >
 * Domain-wide delegation) must authorize this service account's client id for
 * exactly the scopes in DIRECTORY_SCOPES + GMAIL_USER_SCOPES.
 *
 * The service-account key JSON arrives DECRYPTED (caller decrypts via
 * secretCrypto). It is a domain god-key: never log it, never echo it back.
 */

import { admin, auth as adminAuth, type admin_directory_v1 } from '@googleapis/admin';
import { gmail, auth as gmailAuth, type gmail_v1 } from '@googleapis/gmail';
import { calendar, auth as calendarAuth, type calendar_v3 } from '@googleapis/calendar';

// Least-privilege scope sets. Keep these minimal; the DWD grant authorizes
// exactly this union, so widening here widens the god-key.
export const DIRECTORY_SCOPES = [
  'https://www.googleapis.com/auth/admin.directory.user', // read + update user (password, suspend, profile)
  'https://www.googleapis.com/auth/admin.directory.user.security', // signOut, 2SV state, OAuth token revoke
  'https://www.googleapis.com/auth/admin.directory.user.alias', // aliases
  'https://www.googleapis.com/auth/admin.directory.group', // list a user's groups (offboard)
  'https://www.googleapis.com/auth/admin.directory.group.member', // remove from groups (offboard)
  'https://www.googleapis.com/auth/admin.directory.device.mobile.action', // selective account-wipe / stolen-device wipe
] as const;

export const GMAIL_USER_SCOPES = [
  'https://www.googleapis.com/auth/gmail.settings.basic', // vacation responder
  'https://www.googleapis.com/auth/gmail.settings.sharing', // forwarding addresses + auto-forwarding
] as const;

export const CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar.acls', // share a calendar (ACL insert), nothing more
] as const;

/** Comma-separated scope list for the operator's DWD setup instructions. */
export const ALL_DWD_SCOPES_CSV = [
  ...DIRECTORY_SCOPES,
  ...GMAIL_USER_SCOPES,
  ...CALENDAR_SCOPES,
].join(',');

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
}

/**
 * Parse + validate the decrypted service-account JSON. Throws a tagged error
 * (never leaking key material) if the JSON is malformed or missing fields.
 */
export function parseServiceAccountKey(decryptedKeyJson: string): ServiceAccountKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decryptedKeyJson);
  } catch {
    throw new GoogleApiError('invalid_service_account', 'Service-account key is not valid JSON.');
  }
  const obj = parsed as Record<string, unknown>;
  const clientEmail = typeof obj.client_email === 'string' ? obj.client_email : '';
  const privateKey = typeof obj.private_key === 'string' ? obj.private_key : '';
  if (!clientEmail || !privateKey) {
    throw new GoogleApiError(
      'invalid_service_account',
      'Service-account key is missing client_email or private_key.',
    );
  }
  return { client_email: clientEmail, private_key: privateKey };
}

/**
 * Admin SDK Directory client, impersonating the super-admin `adminEmail`.
 * Used for user lookup, password reset, suspend, profile/alias edits, signOut.
 *
 * The JWT is built from the @googleapis/admin package's own auth namespace so
 * the auth client type matches admin()'s expected type exactly (avoids the
 * google-auth-library dual-version skew you get importing JWT separately).
 */
export function getDirectoryClient(
  decryptedKeyJson: string,
  adminEmail: string,
): admin_directory_v1.Admin {
  const key = parseServiceAccountKey(decryptedKeyJson);
  const auth = new adminAuth.JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: [...DIRECTORY_SCOPES],
    subject: adminEmail, // DWD: impersonate the super-admin
  });
  return admin({ version: 'directory_v1', auth });
}

/**
 * Gmail client impersonating the TARGET end user (not the admin). Used for
 * per-mailbox settings: forwarding, vacation responder.
 */
export function getGmailClient(
  decryptedKeyJson: string,
  targetUserEmail: string,
): gmail_v1.Gmail {
  const key = parseServiceAccountKey(decryptedKeyJson);
  const auth = new gmailAuth.JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: [...GMAIL_USER_SCOPES],
    subject: targetUserEmail, // DWD: impersonate the end user
  });
  return gmail({ version: 'v1', auth });
}

/**
 * Calendar client impersonating the calendar OWNER (the user whose calendar is
 * being shared). Sharing = inserting an ACL rule on the owner's calendar, so the
 * subject is the owner, not the admin. Scope is the narrow calendar.acls only.
 */
export function getCalendarClient(
  decryptedKeyJson: string,
  ownerEmail: string,
): calendar_v3.Calendar {
  const key = parseServiceAccountKey(decryptedKeyJson);
  const auth = new calendarAuth.JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: [...CALENDAR_SCOPES],
    subject: ownerEmail, // DWD: impersonate the calendar owner
  });
  return calendar({ version: 'v3', auth });
}

/** Tagged error for Google operations; carries a stable code + safe message. */
export class GoogleApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'GoogleApiError';
  }
}

/**
 * Normalize a thrown error from the Google client (Gaxios) into a stable
 * { code, message }. Never includes response bodies or key material — only the
 * HTTP status class and the API's top-level message, suitable for an audit
 * column or an LLM-readable string.
 */
export function normalizeGoogleError(err: unknown): { code: string; message: string } {
  if (err instanceof GoogleApiError) return { code: err.code, message: err.message };
  const e = err as { code?: number | string; status?: number; message?: string; errors?: Array<{ message?: string }> };
  const status = typeof e?.code === 'number' ? e.code : e?.status;
  const apiMessage = e?.errors?.[0]?.message ?? e?.message ?? 'Unknown Google API error.';
  if (status === 401 || status === 403) {
    return { code: 'google_forbidden', message: `Google denied the request (${status}): ${apiMessage}` };
  }
  if (status === 404) {
    return { code: 'google_not_found', message: `Google resource not found: ${apiMessage}` };
  }
  if (status === 429) {
    return { code: 'google_rate_limited', message: 'Google rate limit hit; try again shortly.' };
  }
  return { code: 'google_error', message: apiMessage };
}
