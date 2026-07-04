import type { LoginContext, LoginContextBranding, LoginContextPartnerSso } from '@breeze/shared';

export type { LoginContext, LoginContextBranding, LoginContextPartnerSso };

const EMPTY: LoginContext = { branding: null, partnerSso: null };

let cached: Promise<LoginContext> | null = null;

/** Memoized: the branded panel island and LoginPage share one request. */
export function getLoginContext(): Promise<LoginContext> {
  if (!cached) cached = fetchLoginContext();
  return cached;
}

async function fetchLoginContext(): Promise<LoginContext> {
  try {
    const apiHost = import.meta.env.PUBLIC_API_URL || '';
    // Same timeout rationale as checkCfAccessLoginEnabled (LoginPage.tsx):
    // a hung request must not stall the login page.
    const res = await fetch(`${apiHost}/api/v1/auth/login-context`, {
      signal: AbortSignal.timeout(4000)
    });
    if (!res.ok) return EMPTY;
    const body = (await res.json()) as Partial<LoginContext>;
    return { branding: body.branding ?? null, partnerSso: body.partnerSso ?? null };
  } catch (err) {
    // Fail open to stock Breeze branding — but leave a trace, or a
    // deployment-wide config/CORS regression silently disables the feature
    // fleet-wide with no signal.
    console.warn('[login] login-context fetch failed; falling back to stock branding', err);
    return EMPTY;
  }
}
