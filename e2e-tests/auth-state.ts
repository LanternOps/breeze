import type { Browser, BrowserContext } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Directory that holds every persisted storageState for a run. */
export const AUTH_DIR = path.resolve(__dirname, '.auth');

/** Mirrors `REFRESH_COOKIE_NAME` in `apps/api/src/routes/auth/schemas.ts`. */
export const REFRESH_COOKIE_NAME = 'breeze_refresh_token';

/**
 * One storageState file per Playwright worker.
 *
 * Why per worker and not one for the run: each login mints its own
 * refresh-token FAMILY, and `/auth/refresh` rotates the token on every
 * full-page navigation (Astro MPA). A context that replays a cookie the
 * family has already rotated past — outside the API's 15 s
 * `REFRESH_ROTATION_GRACE_SECONDS` window — is treated as token reuse: the
 * whole family is revoked and every context on it lands on "Your session
 * expired". Four workers sharing one family do exactly that within seconds
 * (#6447). A family per worker keeps rotations linear, since a worker runs
 * its tests one at a time.
 */
export function workerStoragePath(parallelIndex: number): string {
  return path.join(AUTH_DIR, `worker-${parallelIndex}.json`);
}

export type StorageStateLike = { cookies?: Array<{ name: string; value: string }> };

/** True when the snapshot still carries a live API refresh cookie. */
export function hasRefreshCookie(state: StorageStateLike): boolean {
  return (state.cookies ?? []).some((c) => c.name === REFRESH_COOKIE_NAME && c.value !== '');
}

export function adminCredentials(): { email: string; password: string } {
  const email = process.env.E2E_ADMIN_EMAIL;
  const password = process.env.E2E_ADMIN_PASSWORD;
  if (!email || !password) {
    throw new Error('[auth-state] E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD must be set');
  }
  return { email, password };
}

/**
 * Log in through the real form in a throwaway context and persist the result.
 *
 * #5266 — read the login RESPONSE rather than inferring from the URL. Several
 * stack-level conditions leave this login unusable, and every one of them
 * previously surfaced only as `Timeout 30000ms exceeded` from `waitForURL('/')`
 * — two fixer sessions lost a stack to exactly that. The URL is also racy: the
 * app can touch `/` a moment before it bounces to /auth/mfa/setup, so a URL
 * check can capture a storage state that then 428s inside every spec.
 */
export async function loginAndSaveState(browser: Browser, baseURL: string, statePath: string): Promise<void> {
  const { email, password } = adminCredentials();
  mkdirSync(path.dirname(statePath), { recursive: true });
  const ctx = await browser.newContext({ baseURL });
  const page = await ctx.newPage();
  try {
    // The collector is attached BEFORE the click (and before the goto): an
    // `await page.waitForResponse(...)` registered afterwards cannot see a
    // response that already arrived — on loopback that race is real — and the
    // app's own 428 re-POST would be just as easy to miss between iterations.
    type LoginResponse = { status: number; text: string };
    const loginResponses: Promise<LoginResponse>[] = [];
    page.on('response', (res) => {
      if (res.request().method() !== 'POST') return;
      if (!new URL(res.url()).pathname.endsWith('/auth/login')) return;
      loginResponses.push(
        res.text().then(
          (text) => ({ status: res.status(), text }),
          () => ({ status: res.status(), text: '' })
        )
      );
    });

    await page.goto('/login');
    await page.locator('[data-testid="login-email-input"]').fill(email);
    await page.locator('[data-testid="login-password-input"]').fill(password);
    await page.locator('[data-testid="login-submit"]').click();

    // 428 auth_binding_rotation_required is not terminal: the app rotates its
    // binding and re-POSTs. Anything else is the answer we act on.
    const deadline = Date.now() + 30_000;
    let consumed = 0;
    let settled: LoginResponse | undefined;
    while (!settled && Date.now() < deadline) {
      while (consumed < loginResponses.length) {
        const res = await loginResponses[consumed++];
        if (res.status !== 428) {
          settled = res;
          break;
        }
      }
      if (!settled) await page.waitForTimeout(200);
    }

    const remedy =
      'Set MFA_FORCE_FOR_PARTNER_ADMIN=false in the stack env and restart the api container ' +
      '(`pnpm wt-stack up` pins this for you — a stack brought up any other way does not), ' +
      'or enrol TOTP for that account once. ' +
      'See e2e-tests/README.md ("Seeded admin and forced MFA").';

    if (!settled) {
      throw new Error(
        `[auth-state] no usable POST /auth/login response for ${email} within 30s ` +
          `(${loginResponses.length} seen; any that arrived were 428 auth_binding_rotation_required, ` +
          'i.e. the client and server auth epochs never converged). The login never completed, so ' +
          'no storage state can be written.'
      );
    }
    if (settled.status === 429) {
      throw new Error(
        `[auth-state] login as ${email} was rate limited (429). A stale per-email window ` +
          'survived: the limiter clear before this login needs REDIS_PASSWORD to reach an ' +
          'authenticated redis (`pnpm wt-stack test` passes it for you). Wait for the window to ' +
          'expire or clear `login:*` in redis by hand, then re-run.'
      );
    }
    if (settled.status >= 400) {
      throw new Error(
        `[auth-state] login as ${email} failed with HTTP ${settled.status}: ` +
          `${settled.text.slice(0, 300) || '<empty body>'}`
      );
    }
    let body: { mfaEnrollmentRequired?: boolean };
    try {
      body = JSON.parse(settled.text) as { mfaEnrollmentRequired?: boolean };
    } catch {
      // Never silently treat an unreadable body as "no MFA required" — that
      // lands back on the generic navigation timeout this block replaces.
      throw new Error(
        `[auth-state] login as ${email} returned an unparseable body (HTTP ${settled.status}): ` +
          `${settled.text.slice(0, 300) || '<empty body>'}`
      );
    }
    if (body.mfaEnrollmentRequired === true) {
      // The seeded admin holds the system Partner Admin role, which stores
      // `force_mfa = true` (#4491). With enforcement on it is minted
      // `mfa: false`, every protected request answers 428
      // `mfa_enrollment_required`, and the app parks on /auth/mfa/setup.
      throw new Error(
        `[auth-state] login as ${email} came back \`mfaEnrollmentRequired: true\`: this stack ` +
          `enforces the Partner Admin force_mfa flag, so no spec can run. ${remedy}`
      );
    }

    await page.waitForURL('/', { timeout: 30_000 });
    await ctx.storageState({ path: statePath });
  } finally {
    await ctx.close();
  }
}

/**
 * Write a context's current cookies back to its worker's state file so the
 * NEXT context on this worker starts from the latest rotation instead of the
 * one the login produced. Skipped (with a warning) when the context has lost
 * its refresh cookie — persisting a logged-out state would poison every later
 * test on the worker.
 */
export async function persistStorageState(ctx: BrowserContext, statePath: string): Promise<boolean> {
  const state = await ctx.storageState();
  if (!hasRefreshCookie(state)) {
    console.warn(`[auth-state] not persisting ${path.basename(statePath)}: context has no refresh cookie`);
    return false;
  }
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  return true;
}
