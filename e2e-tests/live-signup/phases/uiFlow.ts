import { chromium } from 'playwright';
import type { Region } from '../regions';
import type { Identity } from '../identity';
import type { SignupResult } from './apiSmoke';
import { fetchVerifyToken } from '../resendClient';

/**
 * SR2-21 full UI signup, now a TWO-STEP email-first flow:
 *
 *   1. Fill + submit the register form. The response is the uniform
 *      { success, message } (no partner, no tokens) and the UI shows the
 *      terminal "check your email" panel — it does NOT log in or navigate.
 *   2. Pull the verification link out of the test mailbox (Resend), drive the
 *      /auth/verify-email page, and let it complete. That page is the ONLY
 *      signup login site now: it creates the account, auto-logs-in, and lands
 *      on the dashboard. We capture the (partnerId, accessToken) from the
 *      verify-email completion response for downstream payment + cleanup.
 *
 * When `opts.verify` is false (the --skip-verify fast path) we stop after the
 * check-email assertion and return null — no account is created, nothing to
 * clean up.
 */
export async function registerViaUi(
  region: Region,
  id: Identity,
  opts: { resendApiKey: string; verify: boolean },
  onCreated?: (r: SignupResult) => void,
): Promise<SignupResult | null> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();

    const registerResponse = page.waitForResponse(
      (r) => r.url().includes('/auth/register-partner') && r.request().method() === 'POST',
      { timeout: 30_000 },
    );

    await page.goto(`${region.baseUrl}/register-partner`, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('register-company-name').fill(id.companyName);
    await page.getByTestId('register-name').fill(id.name);
    await page.getByTestId('register-email').fill(id.email);
    await page.getByTestId('register-password').fill(id.password);
    await page.getByTestId('register-confirm-password').fill(id.password);
    await page.getByTestId('register-accept-terms').check();
    await page.getByTestId('register-submit').click();

    // Step 1 must return the email-first uniform body — no session.
    const resp = await registerResponse;
    if (!resp.ok()) throw new Error(`UI register-partner -> ${resp.status()}`);
    const body = (await resp.json()) as { success?: boolean; tokens?: unknown; partner?: unknown };
    if (body.success !== true || body.tokens || body.partner) {
      throw new Error(`UI register-partner returned a non-email-first body: ${JSON.stringify(body)}`);
    }

    // The UI shows the terminal check-your-email panel and stays logged out.
    await page.getByTestId('register-check-email').waitFor({ state: 'visible', timeout: 20_000 });

    if (!opts.verify) return null;

    // Step 2: fetch the verification token from the mailbox and drive the
    // verify-email page. Capture the completion response — this is where the
    // account is created and the session is minted.
    const token = await fetchVerifyToken({ apiKey: opts.resendApiKey, recipient: id.email });

    const verifyResponse = page.waitForResponse(
      (r) => r.url().includes('/auth/verify-email') && r.request().method() === 'POST',
      { timeout: 30_000 },
    );
    await page.goto(`${region.baseUrl}/auth/verify-email?token=${encodeURIComponent(token)}`, {
      waitUntil: 'domcontentloaded',
    });
    const vResp = await verifyResponse;
    if (!vResp.ok()) throw new Error(`UI verify-email -> ${vResp.status()} ${await vResp.text()}`);
    const vBody = (await vResp.json()) as {
      verified?: boolean;
      partner?: { id?: string };
      tokens?: { accessToken?: string };
    };
    if (vBody.verified !== true || !vBody.partner?.id || !vBody.tokens?.accessToken) {
      throw new Error(`UI verify-email did not complete the registration: ${JSON.stringify(vBody)}`);
    }

    const result: SignupResult = { partnerId: vBody.partner.id, accessToken: vBody.tokens.accessToken };
    onCreated?.(result); // record for cleanup BEFORE the dashboard assertion can throw

    // The verify-email page auto-logs-in and navigates to the dashboard.
    await page.getByTestId('dashboard-root').waitFor({ state: 'visible', timeout: 20_000 });

    return result;
  } finally {
    await browser.close();
  }
}
