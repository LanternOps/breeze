import type { SsoDiscoveryProvider, SsoDiscoveryResult } from '@breeze/shared';

export type { SsoDiscoveryProvider, SsoDiscoveryResult };

// The API always builds this as `/api/v1/sso/login/${orgId}`. The value is
// handed straight to a top-level navigation, so re-assert the shape client-side
// rather than trusting whatever came back: a same-origin absolute path under
// the org SSO entry route, nothing else. Cheap, and it means a malformed or
// tampered response degrades to the password form instead of navigating away.
const ORG_SSO_LOGIN_PREFIX = '/api/v1/sso/login/';

function isUsableLoginUrl(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.startsWith(ORG_SSO_LOGIN_PREFIX) &&
    // `//evil.example` and `/api/v1/sso/login//evil.example` are protocol-
    // relative URLs, not paths — reject anything with a second slash run.
    !value.slice(1).includes('//')
  );
}

/**
 * Home-realm discovery for the address the user just entered (#3229).
 *
 * Returns the org's SSO provider only when that org MANDATES SSO; every other
 * outcome — unknown domain, no SSO, optional SSO, rate limited, network
 * failure — is `null`, which leaves the password form exactly as it is. The
 * server is the only enforcement point (ssoPolicy); this call is presentation.
 */
export async function discoverOrgSso(email: string): Promise<SsoDiscoveryProvider | null> {
  try {
    const apiHost = import.meta.env.PUBLIC_API_URL || '';
    // Same timeout rationale as getLoginContext: a hung request must never
    // stall the login page. It is a progressive enhancement on a form that
    // already works without it.
    const res = await fetch(`${apiHost}/api/v1/auth/sso-discovery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Partial<SsoDiscoveryResult>;
    const sso = body.sso;
    if (!sso || typeof sso.providerName !== 'string' || !isUsableLoginUrl(sso.loginUrl)) return null;
    return { providerName: sso.providerName, loginUrl: sso.loginUrl, enforceSSO: true };
  } catch (err) {
    // Fail open to the password form — but leave a trace, or a deployment-wide
    // config/CORS regression silently disables org SSO discovery with no signal.
    console.warn('[login] SSO discovery failed; leaving the password form in place', err);
    return null;
  }
}
