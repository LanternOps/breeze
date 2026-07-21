# CSP script-hash drift guard (#1232) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the two dead hand-pinned CSP `script-src` hashes and replace them with a real-browser drift guard so the hash-drift class can never ship silently again.

**Architecture:** Astro 6.4.7 auto-hashes every build-time inline script; a spike proved the two hand-pinned hashes are dead (removing them and driving real `<ClientRouter>` view-transition swaps produced zero CSP violations). We delete the pins, add a standalone web-only Playwright guard (boots the prod build, navigates + swaps, fails on any `securitypolicyviolation`) as the primary CI gate, and add a CSP-violation assertion to the authenticated e2e flow for dashboard coverage.

**Tech Stack:** Astro 6.4.7 (`@astrojs/node` standalone), Playwright, Node (TypeScript via `--experimental-strip-types`), Vitest, GitHub Actions.

## Global Constraints

- Repo: `LanternOps/breeze`. Work in an **isolated git worktree off fresh `main`** (per `issue-to-pr`); never edit the shared main working copy in place.
- Node: prefix all `pnpm`/`node`/`playwright` commands with `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH` (default node breaks pnpm engine-strict). Fresh worktrees need `pnpm install`.
- **The worker never merges and never closes the issue** — stop after the PR + review-summary comment.
- Astro version is `^6.4.7`; the dead-pin conclusion is version-specific — the guard is the safety net for future bumps.
- Real agent code is irrelevant here; all work is in `apps/web/` and `e2e-tests/`.
- The `#1342` fetch-based guard files (`apps/web/scripts/check-csp-hash-drift.ts`, `apps/web/src/__tests__/check-csp-hash-drift.test.ts`) are **not on `main`** — they live only on the unmerged draft PR #1342. Do not recreate them; close #1342 as superseded (Task 4).

---

### Task 1: Standalone web-only CSP drift guard (primary CI gate)

**Files:**
- Modify: `apps/web/package.json` (add `playwright` devDep + `csp:guard` script)
- Create: `apps/web/scripts/check-csp-violations.ts`
- Modify: `.github/workflows/ci.yml` (run the guard in the `build-web` job)

**Interfaces:**
- Consumes: the production build output `apps/web/dist/server/entry.mjs` (the `@astrojs/node` standalone server), served with CSP enforced by `apps/web/src/middleware.ts` (production is strict by default).
- Produces: a runnable guard `pnpm --filter @breeze/web run csp:guard` that exits `0` when no inline script is CSP-blocked across initial loads + view-transition swaps, and exits `1` (printing each violation's `blockedURI`/`violatedDirective`/`scriptSample`) otherwise.

- [ ] **Step 1: Add the Playwright dependency and script to `apps/web/package.json`**

Add to `devDependencies` (match the version already used in `e2e-tests/package.json` — check with `node -e "console.log(require('./e2e-tests/package.json').devDependencies.playwright)"` and use that exact string):

```json
"playwright": "<same version as e2e-tests>"
```

Add to `scripts`:

```json
"csp:guard": "node --experimental-strip-types scripts/check-csp-violations.ts"
```

Then install + fetch the browser:

```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm install
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/web exec playwright install chromium
```

- [ ] **Step 2: Write the guard script**

Create `apps/web/scripts/check-csp-violations.ts`:

```ts
// Boots the production web build and drives a real browser through initial
// loads AND <ClientRouter> view-transition swaps, failing if any inline script
// is blocked by CSP. This is the runtime drift guard for #1232 — it sees the
// swap path a fetch-based guard cannot. No API/DB required (API calls 404,
// which is fine; we only assert on CSP violations).
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';

const HOST = '127.0.0.1';
const PORT = 14333;
const BASE = `http://${HOST}:${PORT}`;
// Public routes that render via ClientRouter layouts (no auth needed).
const ROUTES = ['/', '/login', '/forgot-password', '/setup'];

type Violation = { blockedURI: string; violatedDirective: string; scriptSample: string; route: string };

async function waitForServer(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${BASE}/login`, { redirect: 'manual' });
      if (res.status > 0) return;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error('web server did not start within 30s');
}

async function main(): Promise<void> {
  const server = spawn('node', ['dist/server/entry.mjs'], {
    env: { ...process.env, HOST, PORT: String(PORT) },
    stdio: 'inherit',
  });
  const violations: Violation[] = [];
  try {
    await waitForServer();
    const browser = await chromium.launch();
    const context = await browser.newContext();
    const page = await context.newPage();

    // Register the listener before any page script runs; collect into a global.
    await page.addInitScript(() => {
      // @ts-expect-error injected global
      window.__cspViolations = window.__cspViolations || [];
      document.addEventListener('securitypolicyviolation', (e) => {
        // @ts-expect-error injected global
        window.__cspViolations.push({
          blockedURI: e.blockedURI,
          violatedDirective: e.violatedDirective,
          scriptSample: e.sample,
        });
      });
    });

    const collect = async (route: string) => {
      const found = await page.evaluate(() => {
        // @ts-expect-error injected global
        const v = window.__cspViolations || [];
        // @ts-expect-error injected global
        window.__cspViolations = [];
        return v;
      });
      for (const v of found) violations.push({ ...v, route });
    };

    // Initial loads.
    for (const route of ROUTES) {
      await page.goto(BASE + route, { waitUntil: 'networkidle' });
      await collect(`load ${route}`);
    }
    // View-transition swaps: click in-app links so <ClientRouter> performs a
    // real swap (the path a fetch-based guard cannot observe).
    await page.goto(BASE + '/login', { waitUntil: 'networkidle' });
    await page.getByRole('link', { name: 'Forgot password?' }).click();
    await page.waitForURL('**/forgot-password');
    await collect('swap /login -> /forgot-password');
    await page.getByRole('link', { name: 'Sign in' }).click();
    await page.waitForURL('**/login');
    await collect('swap /forgot-password -> /login');

    await browser.close();
  } finally {
    server.kill('SIGTERM');
  }

  if (violations.length > 0) {
    console.error(`[csp-guard] FAIL — ${violations.length} CSP violation(s):`);
    for (const v of violations) {
      console.error(`  [${v.route}] ${v.violatedDirective} blocked ${v.blockedURI} sample="${v.scriptSample}"`);
    }
    process.exit(1);
  }
  console.log(`[csp-guard] OK — no CSP violations across ${ROUTES.length} loads + 2 swaps`);
}

main().catch((err) => {
  console.error('[csp-guard] ERROR', err);
  process.exit(1);
});
```

- [ ] **Step 3: Build, then run the guard against the current build (with pins still present) — expect GREEN**

```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/web build
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/web run csp:guard
```
Expected: `[csp-guard] OK — no CSP violations across 4 loads + 2 swaps` and exit 0.

- [ ] **Step 4: Prove the guard is load-bearing — inject a violation, expect RED**

Temporarily add an unhashed inline script to `apps/web/src/layouts/AuthLayout.astro` (just inside `<body>`), e.g.:

```html
<script>console.log('csp-guard self-test');</script>
```

Then rebuild and run:

```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/web build
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/web run csp:guard; echo "exit=$?"
```
Expected: `[csp-guard] FAIL — 1 CSP violation(s)` naming `script-src-elem` (or `script-src`) on a `/login` or swap step, exit=1.

**Revert the self-test edit** (`git checkout apps/web/src/layouts/AuthLayout.astro`) and rebuild to confirm GREEN again (Step 3 command).

- [ ] **Step 5: Wire the guard into the `build-web` CI job**

In `.github/workflows/ci.yml`, inside the `build-web` job, **after** the web build step, add steps to install Chromium and run the guard. Match the job's existing pnpm/node setup; add:

```yaml
      - name: Install Chromium for CSP guard
        run: pnpm --filter @breeze/web exec playwright install --with-deps chromium
      - name: CSP drift guard (real-browser)
        run: pnpm --filter @breeze/web run csp:guard
```
(Place these after the step that produces `apps/web/dist`. If `build-web` builds via a turbo/root command, ensure the guard step runs in the same job after that.)

- [ ] **Step 6: Commit**

```bash
git add apps/web/package.json apps/web/scripts/check-csp-violations.ts .github/workflows/ci.yml pnpm-lock.yaml
git commit -m "test(web): real-browser CSP drift guard for #1232 (loads + ClientRouter swaps)"
```

---

### Task 2: Authenticated e2e CSP-violation assertion (dashboard coverage)

**Files:**
- Modify: `e2e-tests/fixtures.ts` (collect `securitypolicyviolation` on both fixtures, assert empty after each test)
- Create: `e2e-tests/tests/csp-no-violations.spec.ts` (authenticated in-app swap navigation under the listener)

**Interfaces:**
- Consumes: the existing `authedPage`/`cleanPage` fixtures and `STORAGE_STATE` from `e2e-tests/global-setup.ts`; the running full stack the e2e job already provides.
- Produces: every e2e test now fails if a CSP violation fires during it; a dedicated spec exercises an authenticated dashboard view-transition swap.

- [ ] **Step 1: Add the violation collector to the fixtures**

Replace `e2e-tests/fixtures.ts` with (keeps existing behavior, adds collection + assertion):

```ts
import { test as base, expect, type Page, type BrowserContext } from '@playwright/test';
import { STORAGE_STATE } from './global-setup';

type Fixtures = {
  authedPage: Page;
  cleanPage: Page;
};

type CspViolation = { blockedURI: string; violatedDirective: string; scriptSample: string };

// Register a securitypolicyviolation collector before any page script runs.
async function withCspCollection(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    // @ts-expect-error injected global
    window.__cspViolations = window.__cspViolations || [];
    document.addEventListener('securitypolicyviolation', (e) => {
      // @ts-expect-error injected global
      window.__cspViolations.push({
        blockedURI: e.blockedURI,
        violatedDirective: e.violatedDirective,
        scriptSample: e.sample,
      });
    });
  });
}

async function assertNoCspViolations(page: Page): Promise<void> {
  const violations = (await page.evaluate(() => {
    // @ts-expect-error injected global
    return window.__cspViolations || [];
  })) as CspViolation[];
  expect(
    violations,
    `CSP violations during test:\n${violations
      .map((v) => `  ${v.violatedDirective} blocked ${v.blockedURI} sample="${v.scriptSample}"`)
      .join('\n')}`,
  ).toEqual([]);
}

export const test = base.extend<Fixtures>({
  authedPage: async ({ browser }, use) => {
    const ctx = await browser.newContext({ storageState: STORAGE_STATE });
    await withCspCollection(ctx);
    const page = await ctx.newPage();
    await use(page);
    await assertNoCspViolations(page);
    await ctx.close();
  },

  cleanPage: async ({ browser }, use) => {
    const ctx = await browser.newContext();
    await withCspCollection(ctx);
    const page = await ctx.newPage();
    await use(page);
    await assertNoCspViolations(page);
    await ctx.close();
  },
});

export { expect };
```

- [ ] **Step 2: Add the authenticated swap spec**

Create `e2e-tests/tests/csp-no-violations.spec.ts`. Inspect the sidebar Page Object / `data-testid`s first (`e2e-tests/pages/`) and use real testids for the two links; the structure is:

```ts
import { test, expect } from '../fixtures';

test.describe('CSP — no violations on authenticated navigation', () => {
  test('dashboard load + in-app (ClientRouter) navigation emits no CSP violation', async ({ authedPage }) => {
    await authedPage.goto('/dashboard', { waitUntil: 'networkidle' });
    // In-app navigation via the sidebar triggers a <ClientRouter> swap (not a
    // full reload). Use the real data-testid for a sidebar link (e.g. Devices).
    await authedPage.getByTestId('sidebar-link-devices').click();
    await authedPage.waitForURL('**/devices');
    await expect(authedPage).toHaveURL(/\/devices/);
    // The fixture asserts window.__cspViolations is empty after this test.
  });
});
```
If no `data-testid` exists on sidebar links, add one in `apps/web/src/components/...Sidebar.tsx` (follow the existing testid convention) as part of this task, since the e2e convention is testid-only.

- [ ] **Step 3: Run the e2e suite (or just this spec) against the stack — expect GREEN**

```bash
cd e2e-tests
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH PUBLIC_API_URL=http://localhost pnpm exec playwright test csp-no-violations.spec.ts
```
Expected: 1 passed. (Requires the local stack up per `e2e-tests/README.md`.)

- [ ] **Step 4: Commit**

```bash
git add e2e-tests/fixtures.ts e2e-tests/tests/csp-no-violations.spec.ts
# include the Sidebar testid file if you added one
git commit -m "test(e2e): fail on CSP violations; assert authenticated ClientRouter swap is clean (#1232)"
```

---

### Task 3: Delete the dead pins (the #1232 fix)

**Files:**
- Modify: `apps/web/astro.config.mjs` (remove the two hand-pinned hashes + update comment)

**Interfaces:**
- Consumes: the green guards from Tasks 1 & 2 (they authorize this deletion).
- Produces: a `scriptDirective.resources` array carrying no hand-pinned hashes.

- [ ] **Step 1: Remove the two pins and rewrite the comment**

In `apps/web/astro.config.mjs`, change `security.csp.scriptDirective` to:

```js
      scriptDirective: {
        // Astro auto-hashes every build-time inline script it emits (client
        // islands, hydration bootstrap, is:inline). We carry NO hand-pinned
        // sha256 hashes here: a 2026-06-19 spike (#1232) proved the previous
        // two pins were dead on Astro 6.4.7 — removing them and driving real
        // <ClientRouter> view-transition swaps produced zero CSP violations.
        // The real-browser CSP drift guard (apps/web/scripts/check-csp-violations.ts,
        // run in CI) is the safety net: if a future Astro version introduces a
        // runtime-only inline script needing a hash, the guard fails loudly
        // instead of breaking silently in production.
        resources: [
          "'self'",
          'https://static.cloudflareinsights.com',
        ]
      },
```

- [ ] **Step 2: Rebuild and run the standalone guard — expect GREEN (authorized deletion, part 1)**

```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/web build
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/web run csp:guard
```
Expected: `[csp-guard] OK` and exit 0. Also confirm the served header no longer contains the pins:
```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH HOST=127.0.0.1 PORT=14334 node apps/web/dist/server/entry.mjs & sleep 3
curl -sI http://127.0.0.1:14334/login | grep -io "dr7co1Yq\|6wgjuQN8" || echo "pins absent (good)"
pkill -f "dist/server/entry.mjs"
```
Expected: `pins absent (good)`.

- [ ] **Step 3: Run the authenticated e2e CSP spec — expect GREEN (authorized deletion, part 2 — the dashboard re-verification)**

```bash
cd e2e-tests
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH PUBLIC_API_URL=http://localhost pnpm exec playwright test csp-no-violations.spec.ts
```
Expected: 1 passed. This confirms authenticated dashboard navigation emits no CSP violation without the pins — the gate that authorizes the deletion.

- [ ] **Step 4: Run web unit tests (no regressions)**

```bash
PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/web exec vitest run src/middleware.test.ts src/lib/csp.test.ts
```
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/web/astro.config.mjs
git commit -m "fix(web): remove dead CSP script-src hash pins (#1232)

Spike proved both pins were dead on Astro 6.4.7. Astro auto-hashing covers
all emitted inline scripts; the real-browser drift guard is the safety net."
```

---

### Task 4: Retire #1342's fetch-based guard + open the PR

**Files:**
- (Conditional) Delete: `apps/web/scripts/check-csp-hash-drift.ts`, `apps/web/src/__tests__/check-csp-hash-drift.test.ts`, and their `package.json`/CI wiring — **only if they exist on your base** (they do not on current `main`).

**Interfaces:**
- Consumes: the merged-or-unmerged state of PR #1342.
- Produces: a single open PR that `Closes #1232`, with #1342 closed as superseded.

- [ ] **Step 1: Check whether the fetch-guard files exist on your base**

```bash
ls apps/web/scripts/check-csp-hash-drift.ts apps/web/src/__tests__/check-csp-hash-drift.test.ts 2>/dev/null && echo "EXIST — delete them" || echo "absent — nothing to delete (expected on main)"
```

- [ ] **Step 2: If they exist, delete them and their wiring; commit**

```bash
git rm apps/web/scripts/check-csp-hash-drift.ts apps/web/src/__tests__/check-csp-hash-drift.test.ts
# remove any "check-csp-hash-drift" script from apps/web/package.json and any
# CI step invoking it in .github/workflows/ci.yml (build-web job)
git commit -m "chore(web): remove superseded fetch-based CSP drift guard (#1232, supersedes #1342)"
```
If Step 1 printed "absent", skip this step.

- [ ] **Step 3: Push, open the PR, and verify (per issue-to-pr)**

```bash
git push -u origin HEAD
gh pr create --repo LanternOps/breeze --title "fix(web): remove dead CSP script-src hash pins + real-browser drift guard" \
  --body "Closes #1232. Supersedes #1342 (close it). Spike (docs/superpowers/specs/web-ui/2026-06-19-csp-script-hash-drift-guard-design.md) proved both hand-pinned hashes are dead on Astro 6.4.7. Adds a standalone real-browser CSP drift guard (CI build-web) + an authenticated e2e CSP-violation assertion."
```
Then run `/pr-review-toolkit:review-pr`, address findings, and post the review-summary comment. Close #1342 as superseded with a one-line reason.

- [ ] **Step 4: Verification checklist before handing off**

- Standalone guard GREEN on the final build; proven RED under an injected inline script (Task 1 Step 4).
- Authenticated e2e CSP spec GREEN with pins deleted (Task 3 Step 3).
- Web unit tests GREEN (Task 3 Step 4); `tsc`/`astro check` clean.
- PR body `Closes #1232`; #1342 closed as superseded.
- **Do not merge. Do not close #1232.** Hand off with the review summary.

---

## Self-Review

**Spec coverage:** Part 1 (delete pins) → Task 3. Part 2 (standalone web-only guard) → Task 1. Part 3 (authenticated e2e assertion) → Task 2. Part 4 (retire fetch guard) → Task 4. Non-goals (nonce, ClientRouter removal, generator) require no task. Residual caveat (authenticated dashboard re-verification) → Task 3 Step 3, gated explicitly. Covered.

**Placeholder scan:** Two intentional lookups remain because their exact values are environment-specific and must be read at implementation time, not guessed: the `playwright` version string (Task 1 Step 1 — copy verbatim from `e2e-tests/package.json`) and the sidebar link `data-testid` (Task 2 Step 2 — read from `e2e-tests/pages/`). Both include the exact command/file to read and a fallback. No vague "add error handling"-style placeholders.

**Type consistency:** `window.__cspViolations` shape `{ blockedURI, violatedDirective, scriptSample }` is identical in Task 1 and Task 2. The guard script entrypoint `csp:guard` is referenced consistently across Tasks 1, 3. `check-csp-violations.ts` path is consistent throughout.
