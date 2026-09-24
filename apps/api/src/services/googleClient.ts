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
import { licensing, auth as licensingAuth, type licensing_v1 } from '@googleapis/licensing';

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

// Inbound ticket connector scope, deliberately separate from GMAIL_USER_SCOPES
// (the settings scopes) so each caller requests only what it needs. Uses
// gmail.readonly: the connector only reads (the historyId cursor is the
// incremental mechanism, history.list / messages.get / getProfile are all
// covered). Access is granted by domain-wide delegation, so the scope applies to
// every mailbox in the customer's Workspace; request the least the connector
// needs. A later phase that writes labels would add its scope, and the
// customer's admin would authorize that change explicitly.
// Explicit per-request deadline for every Gmail/UserInfo call. gaxios has no
// finite default, so a hung Google connection would never settle — and the ticket
// mailbox poll worker sweeps mailboxes serially, so one hung request would stall
// every later mailbox. With a timeout the request rejects, the per-mailbox catch in
// runMailboxSweep records it, and the sweep moves on.
export const GMAIL_REQUEST_TIMEOUT_MS = 30_000;

export const GMAIL_INBOUND_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  // Identity: `openid` yields the impersonated mailbox's immutable Google account
  // `sub` (stable across email/alias changes, never reused), and userinfo.email
  // lets us cross-check the returned principal is the address we impersonated.
  // The sub is the connector's dedup namespace AND the same-account proof used to
  // decide, on reconnect, whether a preserved history cursor still belongs to the
  // same mailbox (org merge safety).
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
] as const;

export const CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar.acls', // share a calendar (ACL insert), nothing more
] as const;

export const LICENSING_SCOPES = [
  'https://www.googleapis.com/auth/apps.licensing', // assign / list / remove Workspace license assignments
] as const;

/** Comma-separated scope list for the operator's DWD setup instructions. */
export const ALL_DWD_SCOPES_CSV = [
  ...DIRECTORY_SCOPES,
  ...GMAIL_USER_SCOPES,
  ...GMAIL_INBOUND_SCOPES,
  ...CALENDAR_SCOPES,
  ...LICENSING_SCOPES,
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
  return gmail({ version: 'v1', auth, timeout: GMAIL_REQUEST_TIMEOUT_MS });
}

/**
 * Gmail client for the inbound ticket connector, impersonating the target
 * mailbox via DWD. Requests only GMAIL_INBOUND_SCOPES (gmail.readonly plus the
 * identity scopes) — not the settings scopes getGmailClient uses.
 */
export interface MailboxIdentity {
  /** The impersonated account's immutable Google `sub` (opaque string; NEVER a
   *  number). Stable across email/alias changes and never reused. */
  sub: string;
  /** The account's primary email as Google reports it (cross-check only). */
  email: string | null;
}

/**
 * ONE inbound DWD session for a mailbox: a single JWT (one impersonation subject,
 * one token) that serves BOTH the Gmail client and the OpenID identity read. Using
 * one session is the point — the history cursor and the immutable `sub` are then
 * bound to the SAME credential/token and cannot straddle an address reassignment
 * between two separately-minted requests.
 */
export interface InboundMailboxSession {
  gmail: gmail_v1.Gmail;
  /** Read the impersonated account's immutable identity via this session's token. */
  identity(): Promise<MailboxIdentity>;
}

export function getInboundMailboxSession(
  decryptedKeyJson: string,
  targetMailboxEmail: string,
): InboundMailboxSession {
  const key = parseServiceAccountKey(decryptedKeyJson);
  const auth = new gmailAuth.JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: [...GMAIL_INBOUND_SCOPES],
    subject: targetMailboxEmail, // DWD: impersonate the mailbox
  });
  return {
    gmail: gmail({ version: 'v1', auth, timeout: GMAIL_REQUEST_TIMEOUT_MS }),
    async identity(): Promise<MailboxIdentity> {
      // `openid` makes the DWD token carry the impersonated user's identity; the
      // OpenID UserInfo endpoint returns that account's immutable `sub`. Uses the
      // JWT auth client's own authenticated request (it extends OAuth2Client) so no
      // extra @googleapis package is pulled in.
      const res = await auth.request<{ sub?: unknown; email?: unknown }>({
        url: 'https://openidconnect.googleapis.com/v1/userinfo',
        timeout: GMAIL_REQUEST_TIMEOUT_MS,
      });
      const sub = res.data?.sub;
      if (typeof sub !== 'string' || sub.length === 0) {
        throw new Error('Google UserInfo returned no immutable account sub');
      }
      const email = typeof res.data?.email === 'string' ? res.data.email : null;
      return { sub, email };
    },
  };
}

export function getInboundGmailClient(
  decryptedKeyJson: string,
  targetMailboxEmail: string,
): gmail_v1.Gmail {
  return getInboundMailboxSession(decryptedKeyJson, targetMailboxEmail).gmail;
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

/**
 * Enterprise License Manager client, impersonating the super-admin. Used to
 * assign / list / remove Workspace license assignments for users.
 */
export function getLicensingClient(
  decryptedKeyJson: string,
  adminEmail: string,
): licensing_v1.Licensing {
  const key = parseServiceAccountKey(decryptedKeyJson);
  const auth = new licensingAuth.JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: [...LICENSING_SCOPES],
    subject: adminEmail, // DWD: impersonate the super-admin
  });
  return licensing({ version: 'v1', auth });
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
