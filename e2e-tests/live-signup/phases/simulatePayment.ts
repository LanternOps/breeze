import type { Region } from '../regions';
import { getWithRetry } from '../httpRetry';

/**
 * Simulate a successful payment on the canary (writes payment_method_attached_at),
 * then trigger the REAL partnerGuard reconciliation by hitting a guarded partner
 * endpoint with the canary's own token, and confirm status flipped to 'active'.
 */
export async function simulatePaymentAndAssertActivation(opts: {
  region: Region;
  partnerId: string;
  accessToken: string;
  syntheticToken: string;
}): Promise<void> {
  const { region, partnerId, accessToken, syntheticToken } = opts;

  const sim = await fetch(`${region.apiUrl}/internal/synthetic/simulate-payment`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${syntheticToken}` },
    body: JSON.stringify({ partnerId }),
  });
  if (!sim.ok) throw new Error(`simulate-payment -> ${sim.status} ${await sim.text()}`);

  // Idempotent reads → retry transient 5xx so a deploy-window blip doesn't
  // false-alarm. A persistent 4xx is returned as-is for the assertion below.
  const dash = await getWithRetry(`${region.apiUrl}/partner/dashboard`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (dash.status !== 200) {
    throw new Error(`partner/dashboard after payment -> ${dash.status} (expected 200 = activated)`);
  }

  const me = await getWithRetry(`${region.apiUrl}/partner/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  // Guard the status code before parsing JSON so a 401/500/Caddy HTML page is
  // reported as the transport failure it is, not as a misleading
  // "status = undefined (expected active)" activation failure.
  if (me.status !== 200) {
    throw new Error(`partner/me -> ${me.status} ${await me.text()}`);
  }
  const body = (await me.json()) as { status?: string };
  if (body.status !== 'active') throw new Error(`partner/me status = ${body.status} (expected active)`);
}
