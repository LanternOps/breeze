import type { BrowserContext, Page, Request } from '@playwright/test';
import { test, expect } from '../fixtures';
import { AiAgentsPage } from '../pages/AiAgentsPage';

/**
 * `/settings/ai-agents` — the four-step guided create flow (`AgentCreateFlow.tsx`,
 * Task 13 #5051) and the capability picker (#5048). Gated behind
 * `BREEZE_AI_AGENTS_ENABLED`; the whole file skips (via the `beforeAll` probe
 * below) on a stack that hasn't opted in.
 *
 * ONE browser context for the whole file, not the per-test `authedPage`
 * fixture: every fresh context replays the same stored refresh cookie, and
 * the API rotates that cookie on first use, so a second context bounces to
 * `/login` ("Your session expired") unless it lands inside a short grace
 * window. Running this file in parallel reproduced that (2 of 3 tests
 * bounced at their first navigation), and clearing the refresh state between
 * serial tests was not enough either. A single context sidesteps the race.
 */
test.describe.configure({ mode: 'serial' });

const AGENT_KINDS = ['helpdesk', 'patch', 'triage'] as const;

/**
 * Recover the access token the app itself is using, by watching one of its
 * own authenticated API calls — same approach as `multi-currency.spec.ts`.
 * `fetchWithAuth` sends the token as an `Authorization: Bearer` header, so a
 * direct `request` call needs the same header to reach an authenticated route.
 */
async function readAccessToken(page: Page): Promise<string> {
  let token: string | null = null;
  const seen: string[] = [];
  const onRequest = (req: Request) => {
    if (!req.url().includes('/api/v1/')) return;
    const header = req.headers()['authorization'];
    if (seen.length < 20) seen.push(`${req.method()} ${new URL(req.url()).pathname}${header ? ' (auth)' : ''}`);
    if (!token && header?.startsWith('Bearer ')) token = header.slice(7);
  };
  page.on('request', onRequest);
  try {
    // A fresh context (see beforeAll) is never signed in, so go straight to
    // the login form rather than to '/' — the app's redirect there is
    // client-side and lands after any URL check. Sign in with the credentials
    // the global setup used (in the environment on every stack). The login
    // response carries the access token directly, which is the deterministic
    // source; the request watch above is the fallback should it not.
    await page.goto('/login');
    {
      const email = process.env.E2E_ADMIN_EMAIL;
      const password = process.env.E2E_ADMIN_PASSWORD;
      if (!email || !password) throw new Error('E2E_ADMIN_EMAIL/E2E_ADMIN_PASSWORD are not set');
      await page.getByTestId('login-email-input').fill(email);
      await page.getByTestId('login-password-input').fill(password);
      // A context with no auth-binding cookie yet gets a 428
      // (auth_binding_rotation_required) carrying a fresh binding, and the
      // app retries the login with it on its own — wait for that retry's
      // answer, not the handshake.
      const loginResponse = page.waitForResponse(
        (res) => res.request().method() === 'POST' && res.url().includes('/api/v1/auth/login') && res.status() !== 428,
        { timeout: 30_000 },
      );
      await page.getByTestId('login-submit').click();
      const res = await loginResponse;
      if (!res.ok()) throw new Error(`login failed: POST /api/v1/auth/login -> ${res.status()} ${(await res.text()).slice(0, 200)}`);
      const body = (await res.json()) as { tokens?: { accessToken?: string }; accessToken?: string };
      const fromLogin = body.tokens?.accessToken ?? body.accessToken;
      if (typeof fromLogin === 'string' && fromLogin) token = fromLogin;
      await page.waitForURL((url) => !/\/login/.test(url.pathname), { timeout: 30_000 });
    }
    await expect.poll(() => token, {
      message: () => `an authenticated /api/v1 request from the app (at ${page.url()}; seen: ${seen.join(', ') || 'none'})`,
      timeout: 30_000,
    }).toBeTruthy();
  } finally {
    page.off('request', onRequest);
  }
  return token!;
}

let ctx: BrowserContext;
let page: Page;
let token = '';
/** Set by the create test once its `POST /ai/agents` succeeds; consumed by
 *  `afterAll` so a rerun never trips the one-agent-per-kind-per-owner rule.
 *  DELETE only soft-disables the row, and the web's free-kind rule counts a
 *  disabled row as taken (re-enabling it later must not collide), so the
 *  create test picks whichever kind card is still free rather than a fixed
 *  kind — three local reruns before the partner axis is exhausted; CI runs
 *  against a fresh stack every time. */
let createdAgentId: string | null = null;

test.beforeAll(async ({ browser }) => {
  // Deliberately NOT the shared storage state: the refresh cookie in it is
  // single-use, so two contexts booting from the same copy at once (this
  // spec next to multi-currency.spec.ts under three workers) race the
  // rotation and one of them is signed out. A fresh context signs in on its
  // own and holds its own cookie; `readAccessToken` performs that login.
  ctx = await browser.newContext();
  page = await ctx.newPage();
  token = await readAccessToken(page);
  const res = await page.request.get('/api/v1/ai/agents/tool-catalog', {
    headers: { authorization: `Bearer ${token}` },
  });
  test.skip(
    res.status() !== 200,
    `AI agents feature is not enabled on this stack (GET tool-catalog -> ${res.status()}); set BREEZE_AI_AGENTS_ENABLED=true`,
  );
});

test.afterAll(async () => {
  if (createdAgentId) {
    await page.request.delete(`/api/v1/ai/agents/${createdAgentId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    createdAgentId = null;
  }
  await ctx?.close();
});

/** The first kind whose card is still selectable for the current owner
 *  scope (a kind already held by a live OR disabled agent renders its card
 *  disabled). */
async function firstFreeKind(agents: AiAgentsPage): Promise<(typeof AGENT_KINDS)[number]> {
  for (const kind of AGENT_KINDS) {
    if (await agents.kindCard(kind).isEnabled()) return kind;
  }
  throw new Error(`every agent kind is already taken on this owner axis — disable/delete leftover ${AGENT_KINDS.join('/')} agents`);
}

test.describe('AI agents — guided create flow', () => {
  test('creates a partner-wide agent end to end in shadow mode', async () => {
    const agents = new AiAgentsPage(page);
    await agents.goto();
    await agents.openCreateFlow();

    await agents.ownerPartner().click();
    const kind = await firstFreeKind(agents);
    const name = `E2E ${kind} agent ${Date.now()}`;
    await agents.fillPurpose({ kind, ownerScope: 'partner', name });
    await agents.flowNext().click();

    // What it does: applying the recommended preset must produce a
    // non-empty selection — the summary sentence is only ever blank when
    // nothing is selected. Asserted while still on this step; the testid
    // does not exist once the flow has moved past it.
    await agents.applyRecommendedCapabilities();
    await expect(agents.capabilityPickerSummary()).not.toHaveText('');
    await agents.flowNext().click();

    // Safety
    await agents.firstAvailableRoleCheckbox().check();
    const previewResponse = await agents.advanceToReview(page);
    expect(previewResponse.status()).toBe(200);

    await expect(agents.summaryCard()).toBeVisible();
    await expect(agents.summaryRow('limits')).toContainText('per run');

    const createResponse = await agents.create(page);
    expect(createResponse.status()).toBe(201);
    const body = (await createResponse.json()) as { data: { id: string } };
    createdAgentId = body.data.id;
    expect(createdAgentId).toBeTruthy();

    await expect(agents.agentRow(createdAgentId)).toBeVisible();
  });

  test('blocks Next on an empty name and surfaces the issue instead of advancing', async () => {
    const agents = new AiAgentsPage(page);
    await agents.goto();
    await agents.openCreateFlow();

    // Name is empty by default on a fresh draft — Next must refuse to leave
    // Purpose rather than silently advancing to What it does.
    await agents.flowNext().click();

    await expect(agents.issues()).toBeVisible();
    await expect(agents.permissions()).not.toBeVisible();
    await agents.flowCancel().click();
    await expect(agents.flowRoot()).toHaveCount(0);
  });

  test('the stepper lets an operator jump back to Review after visiting Edit', async () => {
    const agents = new AiAgentsPage(page);
    await agents.goto();
    await agents.openCreateFlow();

    // Organization-owned: a different partial-unique-index bucket than the
    // create test's partner-wide row, so the two never contend for a kind.
    await agents.ownerOrg().click();
    const kind = await firstFreeKind(agents);
    const previewResponse = await agents.reachReview(page, {
      kind,
      ownerScope: 'organization',
      name: `E2E ${kind} stepper ${Date.now()}`,
    });
    expect(previewResponse.status()).toBe(200);
    await expect(agents.summaryCard()).toBeVisible();

    // The card's own title-edit link sends the operator back to Purpose
    // (step 0) — Review (step 3) stays reachable from the stepper because it
    // was already visited (`maxStepReached`), not because it is "completed".
    await agents.summaryTitleEdit().click();
    await expect(agents.nameInput()).toBeVisible();
    await expect(agents.stepperStep(3)).toBeEnabled();

    await agents.stepperStep(3).click();
    await expect(agents.summaryCard()).toBeVisible();

    // No create — cancel the flow so nothing needs cleanup.
    await agents.flowCancel().click();
    await expect(agents.flowRoot()).toHaveCount(0);
  });
});
