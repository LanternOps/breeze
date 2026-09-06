// Wire contract for the public POST /auth/sso-discovery endpoint (#3229).
// Single source of truth shared by the API route (apps/api/src/routes/auth/
// ssoDiscovery.ts) and the web client (apps/web/src/lib/ssoDiscovery.ts) so
// the two sides cannot silently drift — same arrangement as LoginContext.

export type SsoDiscoveryProvider = {
  providerName: string;
  /** Org-axis SSO entry route: `/api/v1/sso/login/${orgId}`. */
  loginUrl: string;
  /**
   * Always `true` when present. The endpoint only answers with a provider for
   * a tenant that MANDATES SSO — a tenant with optional SSO is indistinguishable
   * from an unrecognized domain (see the route's disclosure comment). Kept as an
   * explicit field so the shape mirrors LoginContextPartnerSso and so a future
   * "optional SSO" answer is an additive change, not a breaking one.
   */
  enforceSSO: true;
};

/**
 * `sso: null` is the ONLY negative answer, and it is returned for every
 * negative case alike: unrecognized domain, a domain claimed by more than one
 * organization, a tenant without SSO, a tenant with SSO but no enforcement, a
 * tenant whose entry-route provider cannot actually start a login, and a
 * transient database failure. Callers cannot tell those apart, by design.
 */
export type SsoDiscoveryResult = {
  sso: SsoDiscoveryProvider | null;
};
