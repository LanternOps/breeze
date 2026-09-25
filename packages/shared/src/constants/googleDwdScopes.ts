/**
 * Google Workspace domain-wide-delegation (DWD) OAuth scopes: the single source
 * of truth for both the API (which requests them) and the web integration page
 * (which lists them for the customer's admin to authorize). Leaf module, no imports.
 */

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

/**
 * Comma-separated scope list for the operator's DWD setup instructions. The API
 * error hints and the web integration page both render this one value, so the
 * list an admin pastes into Google Admin cannot drift from what the tools request.
 */
export const GOOGLE_DWD_SCOPES_CSV = [
  ...DIRECTORY_SCOPES,
  ...GMAIL_USER_SCOPES,
  ...GMAIL_INBOUND_SCOPES,
  ...CALENDAR_SCOPES,
  ...LICENSING_SCOPES,
].join(',');
