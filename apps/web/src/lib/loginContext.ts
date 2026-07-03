export type LoginContextBranding = {
  logoUrl: string | null;
  accentColor: string | null;
  headline: string | null;
};

export type LoginContext = {
  branding: LoginContextBranding | null;
  partnerSso: { available: boolean; providerName: string; loginUrl: string } | null;
};

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
    // Same timeout rationale as the CF Access check (LoginPage.tsx:38-58):
    // a hung request must not stall the login page.
    const res = await fetch(`${apiHost}/api/v1/auth/login-context`, {
      signal: AbortSignal.timeout(4000)
    });
    if (!res.ok) return EMPTY;
    const body = (await res.json()) as Partial<LoginContext>;
    return { branding: body.branding ?? null, partnerSso: body.partnerSso ?? null };
  } catch {
    return EMPTY; // fail open to stock Breeze branding
  }
}
