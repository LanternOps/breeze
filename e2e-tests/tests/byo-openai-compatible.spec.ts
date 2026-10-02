import type { BrowserContext, Page, Request } from '@playwright/test';
import { test, expect } from '../fixtures';
import { clearRefreshState } from '../test-helpers';
import { persistStorageState } from '../auth-state';
import { PartnerAiModelsPage } from '../pages/PartnerAiModelsPage';
import { MockLlm, mockLlmUrl } from '../helpers/topologyAiSeed';

/**
 * BYO OpenAI-compatible connection (#7604, W06) against the topology-ai e2e
 * stack: the same self-host stack, mock model and gating as topology-ai.spec.ts
 * (see its header for how to bring it up). The mock runs on the stack network
 * as http://mock-llm:8080/v1, a private address a self-hosted
 * (IS_HOSTED=false) API may dial.
 *
 * Flow: add the connection in the UI (base URL = the mock), see the discovered
 * model, set a price, verify (the mock answers the capability harness), enable
 * it, make it the chat default, then chat and see a tool round trip.
 *
 * The boot env bootstrap (MCP_LLM_PROVIDER=openai-compatible) may already have
 * created an env-managed "Instance OpenAI-compatible endpoint" connection with
 * the SAME base URL and model id. This spec never depends on it: it creates
 * its own uniquely named connection and finds it by diffing connection ids.
 *
 * KNOWN GAP: the chat UI (AiChatInput / AiChatMessages / AiToolCallCard) has no
 * data-testid for the input, send button, assistant message or tool result, so
 * the final chat step drives the SAME API the sidebar calls
 * (POST /ai/sessions, POST /ai/sessions/:id/messages SSE) with the page's own
 * bearer token instead of the UI. Add testids to switch it to the UI.
 */
test.describe.configure({ mode: 'serial', timeout: 240_000 });
test.beforeEach(clearRefreshState);

const mockUrl = mockLlmUrl();
test.skip(!mockUrl, 'needs the mock-llm overlay (docker-compose.override.yml.topology-ai-e2e) — see topology-ai.spec.ts');

/** Where the API (inside the stack network) reaches the mock. */
const MOCK_BASE_URL_FOR_API = 'http://mock-llm:8080/v1';
const MOCK_MODEL_ID = process.env.MOCK_LLM_MODEL ?? 'e2e-mock-model';
const CONNECTION_NAME = `E2E BYO mock ${Date.now().toString(36)}`;

/** The app's own bearer token, lifted off one of its API calls (never minted: a refresh would rotate the cookie). */
async function readAccessToken(page: Page): Promise<string> {
  let token: string | null = null;
  const onRequest = (req: Request) => {
    const header = req.headers()['authorization'];
    if (!token && header?.startsWith('Bearer ') && req.url().includes('/api/v1/')) token = header.slice(7);
  };
  page.on('request', onRequest);
  try {
    await page.goto('/');
    await expect.poll(() => token, { message: 'an authenticated /api/v1 request', timeout: 30_000 }).toBeTruthy();
  } finally {
    page.off('request', onRequest);
  }
  return token!;
}

const isPost = (r: { request(): { method(): string }; url(): string }, re: RegExp) =>
  r.request().method() === 'POST' && re.test(new URL(r.url()).pathname);

test.describe('BYO OpenAI-compatible connection', () => {
  let ctx: BrowserContext;
  let page: Page;
  let models: PartnerAiModelsPage;
  let mock: MockLlm;
  let offeringId = '';
  let connectionId = '';
  let previousChatDefault = '';

  test.beforeAll(async ({ browser, workerStorageState }) => {
    ctx = await browser.newContext({ storageState: workerStorageState });
    page = await ctx.newPage();
    models = new PartnerAiModelsPage(page);
    mock = new MockLlm(mockUrl!);
    await mock.reset();
  });
  test.afterAll(async ({ workerStorageState }) => {
    try {
      // Put the chat default back so later specs see the seeded model.
      if (previousChatDefault && page) {
        await models.goto();
        if ((await models.defaultsSelect('chat').inputValue()) !== previousChatDefault) {
          await models.defaultsSelect('chat').selectOption(previousChatDefault);
          await models.defaultsSave().click();
        }
      }
    } catch { /* best effort */ }
    if (ctx) await persistStorageState(ctx, workerStorageState);
    await ctx?.close();
  });

  test('1. add the connection: the mock model is discovered', async () => {
    await models.goto();
    previousChatDefault = await models.defaultsSelect('chat').inputValue();
    const before = new Set(await models.connectionIds());

    await models.openAddOpenAiConnection();
    await models.openAiName().fill(CONNECTION_NAME);
    await models.openAiBaseUrl().fill(MOCK_BASE_URL_FOR_API);
    await models.openAiApiKey().fill('e2e-mock-key');
    await expect(models.connectionSave()).toBeEnabled();
    await models.connectionSave().click();
    await expect(models.connectionDrawer()).toBeHidden({ timeout: 30_000 });

    // Our row = the one id that was not there before (tolerates an env-managed row).
    await expect.poll(async () => (await models.connectionIds()).filter((id) => !before.has(id)).length, { timeout: 30_000 }).toBe(1);
    connectionId = (await models.connectionIds()).find((id) => !before.has(id))!;
    await expect(models.connectionStatus(connectionId)).toBeVisible();

    // Discovery runs after commit (a queued job): reload until the model lists.
    await expect.poll(async () => {
      await page.reload();
      await models.root().waitFor();
      return models.offeringRows(connectionId).count();
    }, { timeout: 90_000, intervals: [2_000, 3_000, 5_000] }).toBeGreaterThan(0);

    const row = models.offeringRows(connectionId).first();
    offeringId = ((await row.getAttribute('data-testid')) ?? '').replace('ai-offering-row-', '');
    expect(offeringId).toMatch(/^[0-9a-f-]{36}$/);
    // A discovered model starts off.
    await expect(models.offeringEnable(offeringId)).not.toBeChecked();
  });

  test('2. set a price (0 is valid for a local model) and verify against the mock', async () => {
    expect(offeringId, 'test 1 must have discovered the model').not.toBe('');
    await models.goto();
    await models.offeringEdit(offeringId).click();
    await expect(models.offeringDrawer()).toBeVisible();
    for (const field of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) {
      await models.offeringPrice(field).fill('0');
    }
    await models.offeringSave().click();
    await expect(models.offeringDrawer()).toBeHidden({ timeout: 30_000 });

    // Verify: queued; the mock answers the capability harness (incl. a tool call).
    await models.offeringEdit(offeringId).click();
    await expect(models.offeringDrawer()).toBeVisible();
    const verifyPost = page.waitForResponse((r) => isPost(r, /\/ai\/models\/offerings\/[^/]+\/verify$/));
    await models.offeringVerify().click();
    expect((await verifyPost).ok()).toBeTruthy();
    await models.offeringCancel().click();

    await expect.poll(async () => {
      await page.reload();
      await models.root().waitFor();
      return (await models.offeringVerification(offeringId).textContent()) ?? '';
    }, { timeout: 120_000, intervals: [3_000, 5_000] }).toContain('Verified');
    expect(await mock.count(), 'the harness reached the mock').toBeGreaterThan(0);
  });

  test('3. enable the model and make it the chat default', async () => {
    await models.goto();
    const enabled = page.waitForResponse((r) => isPost(r, /\/ai\/models\/offerings\/[^/]+\/enabled$/));
    await models.offeringEnable(offeringId).click();
    expect((await enabled).status()).toBe(200);
    await page.reload();
    await models.root().waitFor();
    await expect(models.offeringEnable(offeringId)).toBeChecked();

    await models.defaultsSelect('chat').selectOption(offeringId);
    await models.defaultsSave().click();
    await page.reload();
    await models.root().waitFor();
    await expect(models.defaultsSelect('chat')).toHaveValue(offeringId);
  });

  test('4. a chat turn calls a tool through the connection and gets its result back', async () => {
    const token = await readAccessToken(page);
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    await mock.reset();

    const created = await page.request.post('/api/v1/ai/sessions', { headers, data: { title: 'E2E BYO OpenAI-compatible' } });
    expect(created.status(), `create session → ${created.status()}`).toBe(201);
    const { id: sessionId } = (await created.json()) as { id: string };

    // The reply is an SSE stream that ends at `done`.
    const sent = await page.request.post(`/api/v1/ai/sessions/${sessionId}/messages`, {
      headers, data: { content: 'List my devices.' }, timeout: 150_000,
    });
    expect(sent.status(), `send message → ${sent.status()}`).toBe(200);
    const stream = await sent.text();
    expect(stream).toContain('tool_use_start');
    expect(stream).toContain('tool_result');
    expect(stream).not.toContain('"type":"error"');

    // Round trip proven at the provider boundary: the first request carried
    // tools, a later one carried the tool's result back (`role: 'tool'`).
    const requests = (await mock.requests()).map((r) => r.body as { model?: string; tools?: unknown[]; messages?: Array<{ role?: string }> });
    expect(requests.some((b) => (b.tools?.length ?? 0) > 0)).toBe(true);
    expect(requests.some((b) => b.messages?.some((m) => m.role === 'tool'))).toBe(true);
    expect(requests.every((b) => b.model === MOCK_MODEL_ID)).toBe(true);
  });
});
