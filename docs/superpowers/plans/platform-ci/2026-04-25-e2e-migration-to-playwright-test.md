# E2E Suite Migration: YAML Runner → Playwright Test

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the custom YAML-driven e2e runner (`e2e-tests/run.ts` + 33 YAML files, ~233 tests) with native `@playwright/test` (TypeScript) using Page Object Model + shared fixtures. Cut suite runtime from ~30 min to ~5 min and eliminate the per-page selector-drift maintenance burden.

**Why:** During the v0.63 fresh-DB validation cycle (PRs #517 / #520) we discovered the current runner reinvents what Playwright Test gives you free (session reuse, retries, parallelism), spreads selectors across 211+ YAML occurrences (one heading rename = 60 line changes), and lacks debug tooling (no trace viewer, no `--ui` mode). End state pass rate plateaued at 26% with most remaining failures being mechanical per-test selector drift across files that share no abstraction.

**Tech Stack:** `@playwright/test` (already a transitive dep), TypeScript, Page Object Model, fixture-based auth.

**Constraint:** YAML and TypeScript suites coexist during migration. CI must stay green throughout. The custom runner stays until the last YAML file is converted.

**Reference background:**
- `e2e-tests/run.ts` — current runner (504 lines)
- `e2e-tests/src/browser.ts` — current Playwright wrapper
- `e2e-tests/src/steps.ts` — step executor
- `e2e-tests/seed-fixtures.sql` — fixture data the new tests must keep using
- `apps/web/src/components/` — page sources, source of truth for current selectors
- `e2e-tests/playwright.config.ts` — already exists for the inline `*.spec.ts` files; reuse + extend

---

### Task 1: Stand up the parallel `playwright/` directory

**Files:**
- Create: `e2e-tests/playwright/playwright.config.ts`
- Create: `e2e-tests/playwright/.gitignore` (ignore `test-results/`, `playwright-report/`)
- Modify: `e2e-tests/package.json` (add `test:pw`, `test:pw:ui`, `test:pw:debug` scripts)

- [ ] **Step 1: Write playwright config**

```ts
// e2e-tests/playwright/playwright.config.ts
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 4 : 6,
  reporter: process.env.CI ? [['github'], ['html']] : 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'https://2breeze.app',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
```

- [ ] **Step 2: Add npm scripts**

```jsonc
// e2e-tests/package.json — scripts block
{
  "test:pw": "playwright test --config playwright/playwright.config.ts",
  "test:pw:ui": "playwright test --config playwright/playwright.config.ts --ui",
  "test:pw:debug": "PWDEBUG=1 playwright test --config playwright/playwright.config.ts",
  "test:pw:report": "playwright show-report e2e-tests/playwright-report"
}
```

- [ ] **Step 3: Verify it runs an empty suite**

```bash
cd e2e-tests && pnpm test:pw --list
# Should print: "Listed 0 tests in 0 files."
```

**Acceptance:** `pnpm test:pw` exits 0 against an empty `tests/` dir; `--ui` opens the Playwright UI.

---

### Task 2: Build the auth fixture (login once per worker)

**Files:**
- Create: `e2e-tests/playwright/fixtures/auth.ts`
- Create: `e2e-tests/playwright/fixtures/index.ts`

The current YAML runner re-logs in per test. `@playwright/test` solves this via worker-scoped fixtures: log in once, save `storageState` to a file, reuse across the worker's tests.

- [ ] **Step 1: Write the auth fixture**

```ts
// e2e-tests/playwright/fixtures/auth.ts
import { test as base, expect, type Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs/promises';

const STORAGE_DIR = path.resolve(__dirname, '../.auth');

type AuthFixtures = {
  authedPage: Page;
};

export const test = base.extend<{}, AuthFixtures>({
  authedPage: [
    async ({ browser }, use, workerInfo) => {
      const storagePath = path.join(STORAGE_DIR, `worker-${workerInfo.workerIndex}.json`);
      await fs.mkdir(STORAGE_DIR, { recursive: true });

      // First test in this worker: log in via API + save state.
      let storage;
      try {
        storage = JSON.parse(await fs.readFile(storagePath, 'utf8'));
      } catch {
        const ctx = await browser.newContext();
        const page = await ctx.newPage();
        await page.goto('/login');
        await page.fill('[name=email]', process.env.E2E_ADMIN_EMAIL!);
        await page.fill('[name=password]', process.env.E2E_ADMIN_PASSWORD!);
        await page.click('button[type=submit]');
        await page.waitForURL('**/');
        storage = await ctx.storageState();
        await fs.writeFile(storagePath, JSON.stringify(storage));
        await ctx.close();
      }

      const ctx = await browser.newContext({ storageState: storage });
      const page = await ctx.newPage();
      await use(page);
      await ctx.close();
    },
    { scope: 'worker' },
  ],
});

export { expect };
```

- [ ] **Step 2: Re-export from index**

```ts
// e2e-tests/playwright/fixtures/index.ts
export { test, expect } from './auth';
```

**Acceptance:** A throwaway `tests/smoke.spec.ts` that uses `authedPage` to navigate to `/` and assert `h1:has-text('Welcome')` passes; the second test in the same file does NOT trigger a fresh login (verify by asserting `.auth/worker-0.json` exists after first test).

---

### Task 3: Build the first Page Object (Dashboard) as the template

**Files:**
- Create: `e2e-tests/playwright/pages/BasePage.ts`
- Create: `e2e-tests/playwright/pages/DashboardPage.ts`
- Create: `e2e-tests/playwright/tests/dashboard.spec.ts`

POM centralizes selectors. When the UI renames a heading, fix one line in `pages/X.ts`, every test that uses it recovers automatically.

- [ ] **Step 1: BasePage with shared sidebar/nav helpers**

```ts
// e2e-tests/playwright/pages/BasePage.ts
import type { Page } from '@playwright/test';

export class BasePage {
  constructor(protected page: Page) {}

  // Use Playwright's user-facing locators, NOT raw CSS. Bare `p`/`h2`
  // selectors get hijacked by SSR shells (e.g. AiChatSidebar) — see
  // PR #520 for the trail of pain.
  sidebarLink(label: string) {
    return this.page.getByRole('navigation').getByRole('link', { name: label });
  }

  accountMenuButton() {
    return this.page.getByRole('button', { name: 'Account menu' });
  }

  async signOut() {
    await this.accountMenuButton().click();
    await this.page.getByRole('button', { name: 'Sign out' }).click();
    await this.page.waitForURL('**/login**');
  }
}
```

- [ ] **Step 2: DashboardPage**

```ts
// e2e-tests/playwright/pages/DashboardPage.ts
import { BasePage } from './BasePage';

export class DashboardPage extends BasePage {
  url = '/';
  heading = () => this.page.getByRole('heading', { level: 1 });
  totalDevicesCard = () => this.page.getByText('Total Devices');
  onlineCard = () => this.page.getByText('Online', { exact: true });
  recentAlertsPanel = () => this.page.getByText('Recent Alerts');
  recentActivityPanel = () => this.page.getByText('Recent Activity');

  async goto() {
    await this.page.goto(this.url);
    await this.heading().waitFor();
  }
}
```

- [ ] **Step 3: Convert `dashboard.yaml`'s critical tests**

```ts
// e2e-tests/playwright/tests/dashboard.spec.ts
import { test, expect } from '../fixtures';
import { DashboardPage } from '../pages/DashboardPage';

test.describe('Dashboard', () => {
  test('loads with welcome heading and stat cards', async ({ authedPage }) => {
    const dashboard = new DashboardPage(authedPage);
    await dashboard.goto();
    await expect(dashboard.heading()).toContainText('Welcome');
    await expect(dashboard.totalDevicesCard()).toBeVisible();
    await expect(dashboard.onlineCard()).toBeVisible();
  });

  test('shows recent alerts and activity panels', async ({ authedPage }) => {
    const dashboard = new DashboardPage(authedPage);
    await dashboard.goto();
    await expect(dashboard.recentAlertsPanel()).toBeVisible();
    await expect(dashboard.recentActivityPanel()).toBeVisible();
  });
});
```

- [ ] **Step 4: Run + verify**

```bash
cd e2e-tests && pnpm test:pw tests/dashboard.spec.ts
# Both tests pass; second one reuses worker auth state
```

**Acceptance:** `dashboard.spec.ts` runs in <10s end-to-end (vs the YAML version's ~30s). Trace viewer (`pnpm test:pw:report`) shows screenshots for any failure.

---

### Task 4: Convert critical-tagged tests, file by file

This is the bulk of the work. Process in priority order so the most valuable tests land first. Each YAML file in the table below has a target POM + spec file.

| YAML file | Target POM | Target spec | Test count |
|---|---|---|---|
| `dashboard.yaml` | `DashboardPage` (Task 3) | `dashboard.spec.ts` (Task 3) | 5 |
| `authentication.yaml` | `LoginPage` | `auth.spec.ts` | 7 |
| `device_management.yaml` | `DevicesPage`, `DeviceDetailPage` | `devices.spec.ts` | 16 |
| `alert_lifecycle.yaml` | `AlertsPage`, `AlertDetailPage` | `alerts.spec.ts` | 12 |
| `audit_and_logs.yaml` | `AuditPage`, `EventLogsPage` | `audit.spec.ts` | 10 |
| `cis_hardening.yaml` | `CisHardeningPage` | `cis.spec.ts` | 9 |
| `backup_lifecycle.yaml` | `BackupDashboardPage` | `backup.spec.ts` | 10 |
| `automations.yaml` | `AutomationsPage` | `automations.spec.ts` | 7 |
| `policies.yaml` | `PoliciesPage` | `policies.spec.ts` | 6 |
| `script_execution.yaml` | `ScriptsPage` | `scripts.spec.ts` | 6 |
| ... (rest in priority order) | ... | ... | ... |

Per file:
- [ ] **Step a: Read the YAML file end-to-end. Note every selector + the page route it touches.**
- [ ] **Step b: Create a POM under `pages/` exposing locators (use `getByRole`, `getByText`, `getByLabel` — avoid CSS).**
- [ ] **Step c: Translate each YAML test into a `test('...', async ({ authedPage }) => { ... })` block.**
- [ ] **Step d: For tests that need data (alerts, devices, audit events): consume the existing `seed-fixtures.sql` rows. Do NOT create fixtures inside individual tests — extend `seed-fixtures.sql` if more rows are needed.**
- [ ] **Step e: Run the spec, fix any selector drift against the live page.**
- [ ] **Step f: Delete the corresponding YAML file and remove its entry from any `tags` filtering docs.**

**Acceptance per file:** All tests in the new spec pass against fresh DB + seed-fixtures; the YAML file is deleted.

---

### Task 5: Migrate the auth/logout flow specially

`auth_login_logout` and `auth_invalid_login` MUST do real login UI flows (not reuse storage). Use a separate fixture or override.

- [ ] **Step 1: Add a `cleanPage` fixture (no storage reuse)**

```ts
// e2e-tests/playwright/fixtures/auth.ts — extend the existing test
export const test = base.extend<{ cleanPage: Page }, ...>({
  // ... authedPage from earlier ...
  cleanPage: async ({ browser }, use) => {
    const ctx = await browser.newContext();
    await use(await ctx.newPage());
    await ctx.close();
  },
});
```

- [ ] **Step 2: Write `auth.spec.ts` using `cleanPage`**

```ts
test('login + logout round-trip', async ({ cleanPage }) => {
  const page = cleanPage;
  await page.goto('/login');
  await page.fill('[name=email]', process.env.E2E_ADMIN_EMAIL!);
  await page.fill('[name=password]', process.env.E2E_ADMIN_PASSWORD!);
  await page.click('button[type=submit]');
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();

  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.waitForURL('**/login**');
});
```

**Acceptance:** Login and logout flows run end-to-end against a clean browser context, do NOT poison the worker-scoped `authedPage` fixture.

---

### Task 6: Wire seed-fixtures into the Playwright global setup

Move the manual `docker exec ... psql < seed-fixtures.sql` invocation into Playwright's `globalSetup` so anyone running `pnpm test:pw` against a fresh DB gets fixtures automatically.

**Files:**
- Create: `e2e-tests/playwright/global-setup.ts`
- Modify: `e2e-tests/playwright/playwright.config.ts` (add `globalSetup`)

- [ ] **Step 1: Write global setup**

```ts
// e2e-tests/playwright/global-setup.ts
import { execFileSync } from 'node:child_process';
import path from 'node:path';

export default async function globalSetup() {
  const sqlPath = path.resolve(__dirname, '../seed-fixtures.sql');
  try {
    execFileSync('docker', [
      'exec', '-i', 'breeze-postgres',
      'psql', '-U', 'breeze', '-d', 'breeze',
    ], { input: require('node:fs').readFileSync(sqlPath, 'utf8'), stdio: ['pipe', 'inherit', 'inherit'] });
  } catch (err) {
    console.error('[globalSetup] seed-fixtures.sql failed:', err);
    throw err;
  }
}
```

- [ ] **Step 2: Reference it from config**

```ts
// playwright.config.ts
export default defineConfig({
  globalSetup: require.resolve('./global-setup'),
  // ...
});
```

**Acceptance:** `rm -rf .auth && pnpm test:pw` against a freshly-wiped DB runs the seed once at the start, then proceeds with tests.

---

### Task 7: CI integration

**Files:**
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Add an `e2e-pw` job that:**
  - Spins up the docker stack (compose up with the same `.env` the smoke-test job uses)
  - Runs `pnpm --filter e2e-tests test:pw` with `CI=true`
  - Uploads `playwright-report/` and `test-results/` as artifacts on failure

- [ ] **Step 2: Mark `e2e-pw` as **non-blocking** (`continue-on-error: true`) until the suite is fully migrated.** Once all YAML files are gone, flip to blocking.

- [ ] **Step 3: Mark the legacy `e2e` YAML runner job (if one exists) as deprecated; remove it once Task 4 is done.**

**Acceptance:** PR CI runs both legacy YAML and new Playwright e2e during transition; new e2e is non-blocking.

---

### Task 8: Demolish the YAML runner

Only do this after Task 4 is complete (all YAML files migrated and deleted).

**Files to delete:**
- `e2e-tests/run.ts`
- `e2e-tests/src/` (entire directory — runner internals)
- `e2e-tests/tests/*.yaml`
- `e2e-tests/config.yaml`
- `e2e-tests/helpers/api.ts`, `helpers/auth.ts`

**Files to keep:**
- `e2e-tests/seed-fixtures.sql`
- `e2e-tests/playwright/` (the new world)
- `e2e-tests/package.json` (drop `test:run`, keep `test:pw*`)

- [ ] **Step 1: Verify no other tooling depends on `run.ts`** (`grep -r "tsx run.ts" .github/ docs/ apps/`)
- [ ] **Step 2: Delete files in one PR with a clear "RIP YAML runner" commit message**
- [ ] **Step 3: Update `e2e-tests/README.md` to point exclusively at the Playwright workflow**

**Acceptance:** `find e2e-tests -name "*.yaml"` returns nothing; `pnpm test:pw` is the only entry point.

---

## Out of scope (do not include in this migration)

- **Visual regression** (Percy/Chromatic) — separate decision, do later
- **Component tests** for AiChatSidebar etc. — belongs in `apps/web/src/components/**.test.tsx`, not e2e
- **Production synthetic monitoring** — different tool entirely
- **Test data fixture management beyond the existing SQL** — keep `seed-fixtures.sql` as the source of truth; if a test needs more rows, extend that file, do NOT create fixtures inside test bodies

---

## Success metrics

| Metric | Before | Target |
|---|---|---|
| Suite runtime | ~30 min (sequential) | <5 min (4-worker parallel) |
| Pass rate on fresh DB | 26% | >85% |
| Lines per test (median) | ~25 (YAML boilerplate) | ~5 (POM + assertion) |
| Selectors per heading | 1 per file (~30 places) | 1 in POM (1 place) |
| Debug experience | Screenshot + stack trace | Trace viewer + UI mode + codegen |
| Onboarding time for new test | ~30 min (learn YAML schema) | ~5 min (TypeScript + IDE autocomplete) |

## Rollback

If the migration stalls partway through, the YAML runner stays functional — both can coexist indefinitely. There's no point of no return until Task 8.
