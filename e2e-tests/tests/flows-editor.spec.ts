import { test, expect } from '../fixtures';
import type { APIRequestContext, Page, Request } from '@playwright/test';
import { FlowEditorPage } from '../pages/FlowEditorPage';

// Requires a stack with Flows enabled (FLOWS_ENABLED). The seed carries only
// system (library) scripts, which the editor's picker does not list (it reads
// `GET /scripts`, as the Job form does), so each test creates its own script.

const UUID_RE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** Lift the app's own access token off an outgoing API request (same technique as script-cancel.spec.ts). */
async function readAccessToken(page: Page): Promise<string> {
  let token: string | null = null;
  const onRequest = (req: Request) => {
    if (token) return;
    const header = req.headers()['authorization'];
    if (header?.startsWith('Bearer ') && req.url().includes('/api/v1/')) token = header.slice(7);
  };
  page.on('request', onRequest);
  try {
    await page.goto('/');
    await expect.poll(() => token, {
      message: 'an authenticated /api/v1 request from the app',
      timeout: 30_000,
    }).toBeTruthy();
  } finally {
    page.off('request', onRequest);
  }
  return token!;
}

/**
 * Let the page we just landed on finish its start-up work (the /auth/refresh
 * every full load makes, which rotates the refresh cookie) before the next
 * `goto`. Navigating away mid-refresh can drop the rotated cookie, and the next
 * page then lands on the login page (#9476). Also asserts we are still signed in.
 */
async function settleSession(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: 30_000 });
  expect(page.url(), 'still signed in after the page settled').not.toMatch(/\/(login|logout)(?:$|\?|#)/);
}

async function apiJson<T>(
  request: APIRequestContext,
  token: string,
  method: 'get' | 'post',
  path: string,
  data?: unknown,
): Promise<T> {
  const res = await request[method](path, {
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(data === undefined ? {} : { data }),
  });
  expect(res.ok(), `${method.toUpperCase()} ${path} -> ${res.status()} ${await res.text()}`).toBeTruthy();
  return (await res.json()) as T;
}

/** Create an org script through the API so the editor's script picker has an option. */
async function createScript(page: Page): Promise<{ id: string; orgId?: string | null }> {
  const token = await readAccessToken(page);
  return apiJson<{ id: string; orgId?: string | null }>(page.request, token, 'post', '/api/v1/scripts', {
    name: `e2e-flow-fixture-${Date.now()}`,
    osTypes: ['windows', 'macos', 'linux'],
    language: 'bash',
    content: 'echo flow',
    timeoutSeconds: 300,
    runAs: 'system',
  });
}

/** Build and save a scheduled single-script flow through the UI; returns the new flow id. */
async function createSavedFlow(page: Page, editor: FlowEditorPage): Promise<string> {
  await createScript(page);
  await editor.gotoNew();
  await editor.fillName(`E2E flow ${Date.now()}`);
  await editor.setCron('0 3 * * *');
  if ((await editor.actionField(0, 'script').count()) === 0) {
    await editor.addAction('run_script').click();
  }
  await editor.pickFirstScript(0);
  await editor.save();
  await page.waitForURL(new RegExp(`/flows/${UUID_RE}/edit`, 'i'));
  const id = editor.currentFlowIdFromUrl();
  expect(id).toBeTruthy();
  return id!;
}

test.describe('Flows editor', () => {
  test('builds and saves a scheduled script automation', async ({ authedPage: page }) => {
    const editor = new FlowEditorPage(page);
    await createScript(page);
    await editor.gotoList();
    await expect(editor.previewTag()).toBeVisible();
    await editor.newButton().click();
    await page.waitForURL('**/flows/new');
    await expect(editor.root()).toBeVisible();

    await editor.fillName(`E2E flow ${Date.now()}`);
    await editor.setCron('0 3 * * *');
    // A blank form may or may not start with an action; add one only if absent.
    if ((await editor.actionField(0, 'script').count()) === 0) {
      await editor.addAction('run_script').click();
    }
    await editor.pickFirstScript(0);
    await editor.save();

    await page.waitForURL(new RegExp(`/flows/${UUID_RE}/edit`, 'i'));
    expect(editor.currentFlowIdFromUrl()).toBeTruthy();

    // A second Save of the unchanged draft succeeds: no conflict banner.
    await expect(editor.saveButton()).toBeEnabled();
    await editor.save();
    await expect(editor.savedNotice()).toBeVisible();
    await expect(editor.conflict()).toHaveCount(0);
  });

  test('enables a saved flow with a max-targets cap', async ({ authedPage: page }) => {
    const editor = new FlowEditorPage(page);
    const id = await createSavedFlow(page, editor);

    await editor.saveAndEnable();
    await expect(editor.enableDialog()).toBeVisible();
    await expect(editor.enableStep('a0_run_script')).toBeVisible();

    // Live check 8 (spec §3.5): a hand-built scheduled script is pre-approved
    // with a device cap. Both controls must be usable; a disabled one is a failure.
    const preApprove = editor.preApprove('a0_run_script');
    await expect(preApprove).toBeEnabled();
    await preApprove.check();
    const maxTargets = editor.maxTargets('a0_run_script');
    await expect(maxTargets).toBeEnabled();
    await maxTargets.fill('25');

    const enableRequest = page.waitForRequest((req) => req.method() === 'POST' && req.url().includes(`/flows/${id}/enable`));
    await editor.enableConfirm().click();
    const body = (await enableRequest).postDataJSON() as { preApprovedStepIds?: string[]; fleetMaxTargets?: Record<string, number> };
    expect(body.preApprovedStepIds).toEqual(['a0_run_script']);
    expect(body.fleetMaxTargets).toEqual({ a0_run_script: 25 });

    await page.waitForURL(new RegExp(`/flows/${id}(?:$|\\?|#)`, 'i'));
    await expect(editor.detail()).toBeVisible();
    await expect(editor.status()).toContainText(/enabled/i);

    // Edit on an enabled flow opens the editor read-only; it never disables.
    await page.getByTestId('flow-edit').click();
    await page.waitForURL(new RegExp(`/flows/${id}/edit`, 'i'));
    await expect(page.getByTestId('flow-editor-enabled-readonly')).toBeVisible();
    await expect(page.getByTestId('flow-editor-disable-and-edit')).toBeVisible();
    await expect(editor.saveButton()).toHaveCount(0);
    await editor.gotoDetail(id);
    await expect(editor.status()).toContainText(/enabled/i);
  });

  test('opens a non-form document on the Document tab, and the form tab shows the not-form-shaped notice', async ({ authedPage: page }) => {
    const editor = new FlowEditorPage(page);
    const script = await createScript(page);
    const token = await readAccessToken(page);

    const document = {
      version: 1,
      name: `E2E non-form flow ${Date.now()}`,
      trigger: { type: 'manual' },
      inputs: [],
      steps: [
        {
          id: 'a0_run_script',
          tool: 'run_script_on_targets',
          input: { scriptId: script.id, whenOffline: 'queue', target: { type: 'all' } },
          // A step timeout is outside the guided form, so the document is not form-shaped.
          timeoutSec: 600,
        },
      ],
    };
    const created = await apiJson<{ flow: { id: string } }>(page.request, token, 'post', '/api/v1/flows', {
      document,
      ...(script.orgId ? { orgId: script.orgId } : {}),
    });

    await editor.gotoEdit(created.flow.id);
    await expect(editor.tab('document')).toHaveAttribute('aria-selected', 'true');
    await editor.openTab('form');
    await expect(editor.notFormShaped()).toBeVisible();
  });

  test('the path tabs link Flows and Jobs', async ({ authedPage: page }) => {
    const editor = new FlowEditorPage(page);
    await editor.gotoList();
    await expect(editor.tabFlows()).toBeVisible();
    await expect(editor.tabFlows()).toHaveAttribute('aria-current', /page|true/);
    await expect(editor.tabPreview()).toBeVisible();
    await expect(editor.tabJobs()).toHaveAttribute('href', /\/jobs$/);

    await editor.tabJobs().click();
    await page.waitForURL('**/jobs');
    await expect(editor.tabJobs()).toBeVisible();
    await expect(editor.tabFlows()).toBeVisible();
  });

  test('legacy /automations URLs redirect to Flows and Jobs', async ({ authedPage: page }) => {
    await page.goto('/automations');
    await page.waitForURL(/\/flows(?:$|\?|#)/);
    await settleSession(page);

    await page.goto('/automations/new');
    await page.waitForURL(/\/jobs\/new(?:$|\?|#)/);
    await settleSession(page);

    const token = await readAccessToken(page);
    const list = await apiJson<{ data?: Array<{ id: string }> }>(
      page.request, token, 'get', '/api/v1/automations?limit=1',
    );
    const jobId = list.data?.[0]?.id;
    expect(jobId, 'a seeded Job from GET /api/v1/automations?limit=1').toBeTruthy();
    await page.goto(`/automations/${jobId}`);
    await page.waitForURL(new RegExp(`/jobs/${jobId}(?:$|\\?|#)`));
    await settleSession(page);
  });
});
