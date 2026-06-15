import type { Region } from '../regions';

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

  const dash = await fetch(`${region.apiUrl}/partner/dashboard`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (dash.status !== 200) {
    throw new Error(`partner/dashboard after payment -> ${dash.status} (expected 200 = activated)`);
  }

  const me = await fetch(`${region.apiUrl}/partner/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const body = (await me.json()) as { status?: string };
  if (body.status !== 'active') throw new Error(`partner/me status = ${body.status} (expected active)`);
}
