import type { LoginContext, LoginContextBranding, LoginContextPartnerSso } from '@breeze/shared';

export type { LoginContext, LoginContextBranding, LoginContextPartnerSso };

const EMPTY: LoginContext = { branding: null, partnerSso: null };

// Keyed by partner slug ('' = the singleton /login page) so the branded panel
// island and LoginPage share one request per page load.
const cache = new Map<string, Promise<LoginContext>>();

/**
 * Memoized: the branded panel island and LoginPage share one request.
 * `partnerSlug` selects the slug-scoped context behind /login/<partner-slug>
 * (#4017); omitted, it is the singleton context of the stock /login page.
 */
export function getLoginContext(partnerSlug?: string): Promise<LoginContext> {
  const key = partnerSlug ?? '';
  let cached = cache.get(key);
  if (!cached) {
    cached = fetchLoginContext(partnerSlug);
    cache.set(key, cached);
  }
  return cached;
}

async function fetchLoginContext(partnerSlug?: string): Promise<LoginContext> {
  try {
    const apiHost = import.meta.env.PUBLIC_API_URL || '';
    const path = partnerSlug
      ? `/api/v1/auth/login-context/partner/${encodeURIComponent(partnerSlug)}`
      : '/api/v1/auth/login-context';
    // Same timeout rationale as checkCfAccessLoginEnabled (LoginPage.tsx):
    // a hung request must not stall the login page.
    const res = await fetch(`${apiHost}${path}`, {
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
