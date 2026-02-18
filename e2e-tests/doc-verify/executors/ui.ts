// e2e-tests/doc-verify/executors/ui.ts
import { chromium, type Browser, type Page } from 'playwright';
import Anthropic from '@anthropic-ai/sdk';
import type { UiAssertion, AssertionResult } from '../types';

let browser: Browser | null = null;
let page: Page | null = null;
let loginFailed = false;

export async function initBrowser(): Promise<void> {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  page = await context.newPage();
  loginFailed = false;
}

export async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close();
    browser = null;
    page = null;
  }
}

async function loginIfNeeded(
  p: Page,
  baseUrl: string,
  env: Record<string, string>,
): Promise<void> {
  const url = p.url();
  if (url.includes('/login') || url === 'about:blank') {
    await p.goto(`${baseUrl}/login`, { waitUntil: 'networkidle', timeout: 15_000 });
    // Wait for the React login form to hydrate
    const emailField = p.locator('#email');
    await emailField.waitFor({ state: 'visible', timeout: 10_000 });
    await emailField.fill(env.ADMIN_EMAIL || 'admin@breeze.local');
    await p.locator('#password').fill(env.ADMIN_PASSWORD || 'BreezeAdmin123!');
    await p.locator('button[type="submit"]').click();
    await p.waitForURL('**/*', { timeout: 15_000 });
    await p.waitForTimeout(2000);
  }
}

export async function executeUiAssertion(
  assertion: UiAssertion,
  baseUrl: string,
  env: Record<string, string>,
): Promise<AssertionResult> {
  const start = Date.now();

  if (!page) {
    return {
      id: assertion.id,
      type: 'ui',
      claim: assertion.claim,
      status: 'error',
      reason: 'Browser not initialized. Call initBrowser() first.',
      durationMs: Date.now() - start,
    };
  }

  // Skip all remaining UI tests if login already failed (web app likely not running)
  if (loginFailed) {
    return {
      id: assertion.id,
      type: 'ui',
      claim: assertion.claim,
      status: 'skip',
      reason: 'Skipped: web app login failed (web dashboard may not be running)',
      durationMs: Date.now() - start,
    };
  }

  try {
    try {
      await loginIfNeeded(page, baseUrl, env);
    } catch (loginErr) {
      loginFailed = true;
      return {
        id: assertion.id,
        type: 'ui',
        claim: assertion.claim,
        status: 'skip',
        reason: `Login failed (web dashboard may not be running): ${loginErr instanceof Error ? loginErr.message.slice(0, 100) : String(loginErr)}`,
        durationMs: Date.now() - start,
      };
    }

    const targetUrl = `${baseUrl}${assertion.test.navigate}`;
    await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 30_000 });
    await page.waitForTimeout(1000);

    const bodyText = await page.locator('body').innerText();
    const ariaSnapshot = await page.locator('body').ariaSnapshot();

    const client = new Anthropic();
    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 512,
      messages: [
        {
          role: 'user',
          content: `You are verifying a documentation claim against a live web application.

Page URL: ${targetUrl}

Page text content (truncated to 5000 chars):
${bodyText.slice(0, 5000)}

Accessibility snapshot (truncated):
${ariaSnapshot.slice(0, 3000)}

Documentation claim to verify:
"${assertion.claim}"

Specific verification instruction:
${assertion.test.verify}

Respond with ONLY this JSON (no markdown):
{"pass": true/false, "reason": "brief explanation"}`,
        },
      ],
    });

    const text = message.content[0].type === 'text' ? message.content[0].text : '';
    let verification: { pass: boolean; reason: string };
    try {
      verification = JSON.parse(text);
    } catch {
      verification = { pass: false, reason: `Failed to parse AI response: ${text.slice(0, 200)}` };
    }

    return {
      id: assertion.id,
      type: 'ui',
      claim: assertion.claim,
      status: verification.pass ? 'pass' : 'fail',
      reason: verification.reason,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      id: assertion.id,
      type: 'ui',
      claim: assertion.claim,
      status: 'error',
      reason: `UI verification failed: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: Date.now() - start,
    };
  }
}
