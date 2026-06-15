import { chromium } from 'playwright';
import type { Region } from '../regions';
import type { Identity } from '../identity';
import type { SignupResult } from './apiSmoke';

export async function registerViaUi(region: Region, id: Identity): Promise<SignupResult> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();

    const responsePromise = page.waitForResponse(
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

    const resp = await responsePromise;
    if (!resp.ok()) throw new Error(`UI register-partner -> ${resp.status()}`);
    const body = (await resp.json()) as { partner?: { id?: string }; tokens?: { accessToken?: string } };
    if (!body.partner?.id || !body.tokens?.accessToken) {
      throw new Error('UI register-partner response missing partner.id/accessToken');
    }

    await page.getByTestId('dashboard-root').waitFor({ state: 'visible', timeout: 20_000 });

    return { partnerId: body.partner.id, accessToken: body.tokens.accessToken };
  } finally {
    await browser.close();
  }
}
