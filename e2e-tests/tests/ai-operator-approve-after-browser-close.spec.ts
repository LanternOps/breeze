import { test, expect } from '../fixtures';
import { clearRefreshState } from '../test-helpers';
import {
  ApprovalsInboxPage,
  DelegateToOperatorAction,
  OperatorTaskPage,
} from '../pages/OperatorTaskPage';
import {
  addVirtualAuthenticator,
  exportCredentials,
  importCredentials,
  registerApproverDevice,
  removeVirtualAuthenticator,
} from '../webauthn';
import type { BrowserContext, Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * AI Operator — delegate here, approve there (#5205 W08, #5246).
 *
 * Acceptance scenario 3, and the property spec §7.1 calls "authority across
 * time": a technician delegates a service-recovery task from a device page,
 * CLOSES THE BROWSER, and the work the operator is waiting on is still there
 * to be approved from a different browser session later. Nothing in the unit
 * or integration suites can show that — they have no browser and no session
 * boundary to cross.
 *
 * WHAT IS REAL HERE
 *  - the delegate button, its dialog, and the `POST /ai/operator/tasks`
 *    admission it fires (202 + the server's own task id),
 *  - the navigation to /operator/tasks/<id> and that page's render,
 *  - client-idempotency: the same key replayed answers the same task id and
 *    leaves exactly one row,
 *  - the destruction of the creating browser context,
 *  - a second, independent login, and a real WebAuthn approve ceremony driven
 *    by clicking Approve in the approvals inbox.
 *
 * WHAT IS SEEDED, AND WHY
 *  - the pending intent/approval the task waits on
 *    (`seed-operator-task-approval.sql`). Producing it for real needs a live
 *    LLM run and a coordinator tick; the e2e stack has neither. Its own
 *    transition is covered against real Postgres by
 *    `aiOperatorServiceRecoveryE2E.integration.test.ts`.
 *
 * WHAT THIS SPEC CANNOT REACH, DELIBERATELY
 *  - `completed` + `verified_resolved`. That needs a connected agent to
 *    execute the restart and an independent device read to verify it, and the
 *    e2e stack runs no agent — `tests/script-cancel.spec.ts` records the same
 *    limit ("the command this creates is never delivered"). Asserting it here
 *    would mean faking the device, which would prove nothing about W08. The
 *    execute→verify→document tail is covered by the W06 integration suite.
 */

function stackDescriptor(): { pgContainer?: string; redisContainer?: string } | null {
  const p = process.env.E2E_STACK_FILE ?? path.resolve(__dirname, '../..', '.breeze-stack.json');
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as { pgContainer?: string; redisContainer?: string }) : null;
}

/**
 * Clears the per-email login rate limiter.
 *
 * globalSetup clears it once, for its own single login. This spec logs in
 * TWICE more (that is the point — two independent sessions), and on a rerun
 * those add up until the limiter answers 429 and the login form simply never
 * navigates. Clearing before each login keeps the spec rerunnable.
 */
function clearLoginRateLimit(): void {
  const container = process.env.E2E_REDIS_CONTAINER ?? stackDescriptor()?.redisContainer ?? 'breeze-redis';
  const args = ['exec', container, 'redis-cli'];
  if (process.env.REDIS_PASSWORD) args.push('-a', process.env.REDIS_PASSWORD, '--no-auth-warning');
  args.push('EVAL', "local k=redis.call('KEYS','login:*'); for _,v in ipairs(k) do redis.call('DEL',v) end; return #k", '0');
  try {
    execFileSync('docker', args, { stdio: 'ignore' });
  } catch {
    // Non-fatal: the login below surfaces a clearer failure if it really is limited.
  }
}

function pgContainer(): string {
  return process.env.E2E_PG_CONTAINER ?? stackDescriptor()?.pgContainer ?? 'breeze-postgres';
}

function psql(sql: string): string {
  return execFileSync(
    'docker',
    ['exec', '-i', pgContainer(), 'psql', '-U', 'breeze', '-d', 'breeze', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-c', sql],
    { encoding: 'utf8' },
  ).trim();
}

function psqlFile(file: string, vars: Record<string, string> = {}): string {
  const args = ['exec', '-i', pgContainer(), 'psql', '-U', 'breeze', '-d', 'breeze', '-t', '-A', '-v', 'ON_ERROR_STOP=1'];
  for (const [k, v] of Object.entries(vars)) args.push('-v', `${k}=${v}`);
  args.push('-f', '-');
  return execFileSync('docker', args, {
    encoding: 'utf8',
    input: readFileSync(path.resolve(__dirname, '..', file), 'utf8'),
  });
}

/** Seeds the one enabled AI agent the admission route resolves for the org. */
function seedOperatorAgent(): void {
  psqlFile('seed-operator-agent.sql');
}

/** Seeds the pending approval the delegated task waits on; returns its id. */
function seedTaskApproval(taskId: string): string {
  const out = psqlFile('seed-operator-task-approval.sql', { task_id: taskId });
  const id = /APPROVAL_ID=([0-9a-f-]{36})/.exec(out)?.[1];
  if (!id) throw new Error(`seed did not report an APPROVAL_ID:\n${out}`);
  return id;
}

async function login(page: Page): Promise<void> {
  clearLoginRateLimit();
  // Mirrors global-setup.ts exactly: the /login route (not /auth) is the one
  // that lands on `/` for the seeded admin, and it is the login path the whole
  // suite already relies on.
  await page.goto('/login');
  await page.getByTestId('login-email-input').waitFor({ timeout: 30_000 });
  // A fill that lands before the Astro island hydrates is silently dropped
  // (see pages/hydration.ts), so wait for React to attach to the form first.
  await page.waitForFunction(() => {
    const form = document.querySelector('form');
    return !!form && Object.keys(form).some((k) => k.startsWith('__reactFiber$'));
  }, undefined, { timeout: 30_000 });
  await page.getByTestId('login-email-input').fill(process.env.E2E_ADMIN_EMAIL!);
  await page.getByTestId('login-password-input').fill(process.env.E2E_ADMIN_PASSWORD!);
  await page.getByTestId('login-submit').click();
  await page.waitForURL('/', { timeout: 30_000 });
}

const DEVICE_ID = process.env.E2E_MACOS_DEVICE_ID ?? process.env.E2E_WINDOWS_DEVICE_ID;
const SERVICE_NAME = 'e2e-operator-svc';

test.describe.configure({ mode: 'serial' });
test.beforeEach(clearRefreshState);

test.describe('AI Operator: delegate, close the browser, approve from a new session', () => {
  test.skip(!DEVICE_ID, 'needs E2E_MACOS_DEVICE_ID (or E2E_WINDOWS_DEVICE_ID) for a seeded device');

  test('a delegated task outlives its creating browser session and is approvable from another', async ({ browser }) => {
    test.setTimeout(240_000);

    seedOperatorAgent();

    // ---- Session A: delegate from the device page.
    const ctxA: BrowserContext = await browser.newContext();
    const pageA = await ctxA.newPage();
    let taskId: string;
    let approverCredentials: unknown[] = [];
    try {
      await login(pageA);

      const delegate = new DelegateToOperatorAction(pageA);
      await delegate.gotoDevice(DEVICE_ID!);
      await delegate.openDialog();

      const admitted = await delegate.confirm(SERVICE_NAME);
      expect(admitted.status, 'admission must answer 202 Accepted').toBe(202);
      taskId = admitted.taskId;

      // The action must land on the task the SERVER created, not one the
      // client invented.
      await pageA.waitForURL(new RegExp(`/operator/tasks/${taskId}`), { timeout: 30_000 });
      const detailA = new OperatorTaskPage(pageA);
      await detailA.waitForLoaded();
      await expect(detailA.state()).toBeVisible();
      await expect(detailA.target()).toBeVisible();
      // Nothing has run yet: admission creates a task, never an operation.
      await expect(detailA.operationsEmpty()).toBeVisible();

      // The row is real, is this org's, and carries the client key the button
      // minted — that key is the whole basis of the replay guarantee below.
      const [rowCount, state, hasKey, requesterMatches] = psql(
        `SELECT count(*)::text, max(t.state), (max(t.client_idempotency_key) IS NOT NULL)::text,
                (max(u.email) = '${process.env.E2E_ADMIN_EMAIL}')::text
           FROM ai_operator_tasks t
           LEFT JOIN users u ON u.id = t.requester_user_id
          WHERE t.id = '${taskId}'`,
      ).split('|');
      expect(rowCount, 'exactly one task row').toBe('1');
      expect(state, 'a freshly admitted task is queued').toBe('queued');
      expect(hasKey, 'the client idempotency key must be persisted').toBe('true');
      expect(requesterMatches, 'the task must be attributed to the delegating user').toBe('true');

      // ---- Idempotent replay: the identical request (same client key) must
      // answer the same task id and must NOT create a second task. Replayed
      // through the context's request client with the captured headers so it
      // is byte-for-byte the request the button sent.
      const replay = await ctxA.request.post(admitted.request.url, {
        headers: {
          'content-type': 'application/json',
          authorization: admitted.request.headers['authorization'] ?? '',
        },
        data: admitted.request.body,
      });
      expect(replay.status(), 'a replayed admission is still accepted').toBe(202);
      expect((await replay.json()).taskId, 'a replay must resolve to the SAME task').toBe(taskId);

      const key = psql(`SELECT client_idempotency_key FROM ai_operator_tasks WHERE id = '${taskId}'`);
      expect(
        psql(`SELECT count(*)::text FROM ai_operator_tasks WHERE client_idempotency_key = '${key}'`),
        'the replay must not have created a second task',
      ).toBe('1');

      // Register the approver device HERE, at the very end of session A, not
      // in session B: the ceremony mints its own access token through
      // /auth/refresh, and that rotation revokes the JTI the page's session
      // store is holding — the session it runs in is unusable afterwards
      // ("Your session expired"). Session A has no in-app work left; session B
      // must have a clean session to click Approve with. The user's registered
      // key persists in the DB across both, which is the real-world shape
      // anyway (you enrol a key once, then approve from wherever).
      const authenticatorA = await addVirtualAuthenticator(pageA);
      const registered = await registerApproverDevice(
        pageA,
        process.env.E2E_ADMIN_PASSWORD!,
        `E2E Operator Approver ${Date.now()}`,
      );
      expect(registered, `approver-device registration failed: ${JSON.stringify(registered)}`).toMatchObject({ ok: true });
      approverCredentials = await exportCredentials(authenticatorA);
      expect(approverCredentials.length, 'the enrolled key must be exportable to the next session').toBeGreaterThan(0);
      await removeVirtualAuthenticator(authenticatorA);
    } finally {
      // The point of the scenario: the session that created the work is GONE —
      // context, cookies, in-memory access token and all.
      await ctxA.close();
    }

    // ---- The operator reaches the approval gate while nobody is watching.
    const approvalId = seedTaskApproval(taskId!);
    expect(psql(`SELECT status FROM approval_requests WHERE id = '${approvalId}'`)).toBe('pending');

    // ---- Session B: a brand-new browser session approves it.
    const ctxB: BrowserContext = await browser.newContext();
    const pageB = await ctxB.newPage();
    try {
      // Installed before any navigator.credentials call: the inbox always
      // requires a WebAuthn proof to approve (lib/intentApprovals.ts). The
      // credential it signs with was enrolled in session A — the virtual
      // authenticator is per-context, but so is a real laptop's, and CDP's
      // resident key is what makes the same key usable here.
      const authenticator = await addVirtualAuthenticator(pageB);
      await importCredentials(authenticator, approverCredentials);
      await login(pageB);

      const inbox = new ApprovalsInboxPage(pageB);
      await inbox.goto();
      expect(await inbox.approve(approvalId), 'the approve ceremony must be accepted').toBe(200);

      // The HTTP 200 only says "not rejected". What matters is that the
      // decision released the intent the TASK is waiting on.
      await expect
        .poll(
          () =>
            psql(
              `SELECT ar.status || '|' || ai.status || '|' || (ai.task_id = '${taskId}')::text
                 FROM approval_requests ar
                 JOIN action_intents ai ON ai.id = ar.intent_id
                WHERE ar.id = '${approvalId}'`,
            ),
          { timeout: 30_000, message: 'approval and its task-linked intent must both settle approved' },
        )
        .toBe('approved|approved|true');

      // And the task itself is still addressable from this new session.
      const detailB = new OperatorTaskPage(pageB);
      await detailB.goto(taskId!);
      await expect(detailB.state()).toBeVisible();
      await expect(detailB.error()).toHaveCount(0);

      await removeVirtualAuthenticator(authenticator);
    } finally {
      await ctxB.close();
    }
  });
});
