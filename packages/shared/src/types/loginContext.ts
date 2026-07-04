// Wire contract for the public GET /auth/login-context endpoint (#2183).
// Single source of truth shared by the API route (apps/api/src/routes/auth/
// loginContext.ts) and the web client (apps/web/src/lib/loginContext.ts) so
// the two sides cannot silently drift.

export type LoginContextBranding = {
  logoUrl: string | null;
  accentColor: string | null;
  headline: string | null;
};

export type LoginContextPartnerSso = {
  providerName: string;
  loginUrl: string;
  /**
   * The partner's active provider has enforceSSO set. The login page uses
   * this to de-emphasize the password form — enforcement itself always
   * happens server-side at login (ssoPolicy), never from this flag.
   */
  enforceSSO: boolean;
};

// A null field means "not applicable / not configured" — branding null means
// no branding row exists (or multi-partner instance), partnerSso null means
// no active partner-axis provider. Presence of partnerSso IS the availability
// signal; there is no separate `available` flag.
export type LoginContext = {
  branding: LoginContextBranding | null;
  partnerSso: LoginContextPartnerSso | null;
};
