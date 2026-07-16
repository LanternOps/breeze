import type { Region } from '../regions';
import type { Identity } from '../identity';

// The (partnerId, accessToken) pair the run threads into payment + cleanup.
// SR2-21: this pair no longer comes from register-partner (which now creates
// nothing) — it is minted at verify-email time. See phases/uiFlow.ts, which
// captures it from the verify-email completion response.
export interface SignupResult { partnerId: string; accessToken: string }

/**
 * SR2-21 step 1 smoke: register-partner is now EMAIL-FIRST. It parks a pending
 * registration and returns a uniform { success, message } — it creates no
 * partner, no user, and mints no session. Assert exactly that shape and, as a
 * regression guard, assert the pre-SR2-21 fields (partner / tokens) are ABSENT.
 * Nothing is created here, so there is nothing to record for cleanup.
 */
export async function registerViaApi(region: Region, id: Identity): Promise<void> {
  const res = await fetch(`${region.apiUrl}/auth/register-partner`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      companyName: id.companyName,
      name: id.name,
      email: id.email,
      password: id.password,
      acceptTerms: true,
    }),
  });
  if (!res.ok) throw new Error(`register-partner -> ${res.status} ${await res.text()}`);
  const body = (await res.json()) as {
    success?: boolean;
    message?: string;
    partner?: unknown;
    tokens?: unknown;
    user?: unknown;
  };
  if (body.success !== true || typeof body.message !== 'string') {
    throw new Error(`register-partner did not return { success:true, message }: ${JSON.stringify(body)}`);
  }
  if (body.partner || body.tokens || body.user) {
    throw new Error(
      'register-partner leaked partner/tokens/user — SR2-21 is email-first and must create nothing at step 1',
    );
  }
}
