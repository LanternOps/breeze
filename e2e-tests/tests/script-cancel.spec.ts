import { test, expect } from '../fixtures';
import type { APIRequestContext, Page, Request } from '@playwright/test';
import { ScriptsPage } from '../pages/ScriptsPage';

// Seeded by e2e-tests/seed-fixtures.sql — see v_macos_device_id there.
const SEEDED_DEVICE_ID = '42fc7de0-48f5-48f2-846b-6dd95924baf9';

/**
 * Recover the access token the app itself is using, by watching one of its
 * own authenticated API calls (same technique as multi-currency.spec.ts).
 *
 * The auth store persists only the user profile to localStorage — the access
 * token lives in memory, so it's lifted off an outgoing request header
 * instead of minted fresh (a fresh POST /auth/refresh would rotate the
 * session's refresh cookie out from under the rest of the test).
 */
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
  expect(res.ok(), `${method.toUpperCase()} ${path} → ${res.status()} ${await res.text()}`).toBeTruthy();
  return (await res.json()) as T;
}

// Mirrors packages/shared/src/types/scriptAdmission.ts (not imported directly:
// e2e-tests is a standalone npm package outside the pnpm workspace, so
// @breeze/shared does not resolve here).
type ScriptAdmissionResult = {
  targets: Array<{ requestedDeviceId: string; admission: string; executionId?: string }>;
};

test.describe('Stop a running script execution (#4767)', () => {
  // There is no fake/live agent in the e2e stack (only postgres + redis are
  // driven by docker compose here — see global-setup.ts), so the command
  // this creates is never delivered and its device_commands row stays
  // `pending` forever. That is exactly the case scriptCancellation.ts's
  // retraction branch (3a) proves synchronously, server-side, with no device
  // involved: it atomically cancels the still-pending command and marks the
  // execution `cancelled`/`confirmed` in the same request. This is real,
  // fully provable behavior, not a fake wait for something this stack can't
  // do — but it means this spec cannot exercise the `cancelling` → device-ack
  // path (W03/W04, the agent's own Cancel handler), which needs a live or
  // simulated agent.
  test('a pending script execution can be stopped, and the row shows Cancelled', async ({ authedPage: page }) => {
    const scripts = new ScriptsPage(page);
    const token = await readAccessToken(page);

    const script = await apiJson<{ id: string }>(page.request, token, 'post', '/api/v1/scripts', {
      name: `e2e-cancel-fixture-${Date.now()}`,
      osTypes: ['macos'],
      language: 'bash',
      content: 'sleep 120',
      timeoutSeconds: 300,
      runAs: 'system',
    });

    const admission = await apiJson<ScriptAdmissionResult>(
      page.request, token, 'post', `/api/v1/scripts/${script.id}/execute`,
      { deviceIds: [SEEDED_DEVICE_ID], parameters: {}, runAs: 'system' },
    );
    const target = admission.targets.find((t) => t.requestedDeviceId === SEEDED_DEVICE_ID);
    expect(target?.admission, JSON.stringify(admission)).toBe('admitted');
    const executionId = target!.executionId!;
    expect(executionId).toBeTruthy();

    await scripts.gotoScript(script.id);
    await expect(scripts.executionStatus(executionId)).toHaveText(/pending|queued/i);

    await scripts.cancelExecution(executionId);

    // No live agent ever picks the command up, so the server's own retraction
    // branch fires: it never leaves `pending`, and the row goes straight to a
    // confirmed Cancelled without ever passing through "Stopping…" here.
    await expect(scripts.executionStatus(executionId)).toHaveText(/cancelled/i, { timeout: 10_000 });
  });
});
