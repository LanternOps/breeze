import { test, expect } from '../fixtures';
import type { APIRequestContext, Page, Request } from '@playwright/test';
import { FlowEditorPage } from '../pages/FlowEditorPage';

// Requires a stack with Flows enabled (FLOWS_ENABLED) and a seeded script the
// logged-in admin can see (seed-fixtures.sql).

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

/** Build and save a scheduled single-script flow through the UI; returns the new flow id. */
async function createSavedFlow(page: Page, editor: FlowEditorPage): Promise<string> {
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

    const preApprove = editor.preApprove('a0_run_script');
    if (await preApprove.isEnabled()) {
      await preApprove.check();
    } else {
      test.info().annotations.push({
        type: 'pre-approve-disabled',
        description: 'pre-approve checkbox is disabled on this stack (eligibility); enabling without it',
      });
    }
    // The max-targets input may stay disabled until pre-approve is ticked.
    const maxTargets = editor.maxTargets('a0_run_script');
    if (await maxTargets.isEnabled()) {
      await maxTargets.fill('25');
    } else {
      test.info().annotations.push({
        type: 'maxtargets-disabled',
        description: 'max targets input is disabled without pre-approval; enabling without it',
      });
    }
    await editor.enableConfirm().click();

    await page.waitForURL(new RegExp(`/flows/${id}(?:$|\\?|#)`, 'i'));
    await expect(editor.detail()).toBeVisible();
    await expect(editor.status()).toContainText(/enabled/i);
  });

  test('opens a non-form document on the Document tab, and the form tab shows the not-form-shaped notice', async ({ authedPage: page }) => {
    const editor = new FlowEditorPage(page);
    const token = await readAccessToken(page);

    const scripts = await apiJson<{ data: Array<{ id: string; orgId?: string | null }> }>(
      page.request, token, 'get', '/api/v1/scripts?limit=1',
    );
    test.skip(!scripts.data?.length, 'no seeded script reachable through GET /api/v1/scripts');
    const script = scripts.data[0];

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

    await page.goto('/automations/new');
    await page.waitForURL(/\/jobs\/new(?:$|\?|#)/);

    const token = await readAccessToken(page);
    const list = await apiJson<{ data?: Array<{ id: string }> }>(
      page.request, token, 'get', '/api/v1/automations?limit=1',
    );
    const jobId = list.data?.[0]?.id;
    if (!jobId) {
      test.info().annotations.push({
        type: 'no-seeded-job',
        description: 'no Job returned by GET /api/v1/automations?limit=1; skipped the /automations/<id> redirect',
      });
      return;
    }
    await page.goto(`/automations/${jobId}`);
    await page.waitForURL(new RegExp(`/jobs/${jobId}(?:$|\\?|#)`));
  });
});
