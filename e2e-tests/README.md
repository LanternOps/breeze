# Breeze E2E Tests

Playwright Test (TypeScript) end-to-end suite for Breeze RMM. Page Object Model + worker-scoped auth fixture for parallel execution.

## Quick Start

```bash
cd e2e-tests
pnpm install
pnpm exec playwright install chromium

# Run the full suite (headless Chromium, parallel workers)
pnpm test:pw

# Open Playwright's interactive UI mode
pnpm test:pw:ui

# Run a single spec
pnpm test:pw tests/dashboard.spec.ts

# Debug mode (auto-opens DevTools, single worker)
pnpm test:pw:debug

# Show the last HTML report
pnpm test:pw:report
```

## Layout

```
e2e-tests/
├── seed-fixtures.sql          # Test data inserted by globalSetup
├── playwright/
│   ├── playwright.config.ts   # Test runner config
│   ├── global-setup.ts        # Runs seed-fixtures.sql on first start
│   ├── fixtures/
│   │   ├── auth.ts            # `authedPage` (worker-scoped) + `cleanPage` (test-scoped)
│   │   └── index.ts           # Re-exports
│   ├── pages/                 # Page Object Models — one per surface
│   │   ├── BasePage.ts        # Shared sidebar/account-menu helpers
│   │   ├── DashboardPage.ts
│   │   ├── DevicesPage.ts
│   │   └── …
│   └── tests/                 # Spec files (one per domain)
│       ├── dashboard.spec.ts
│       ├── auth.spec.ts
│       └── …
└── doc-verify/                # Doc snippet validator (separate tool)
```

## Configuration

Set in the parent `.env` file (`../.env`); Playwright reads it via process.env.

| Variable | Purpose | Default |
|---|---|---|
| `E2E_BASE_URL` | Web app URL | `https://2breeze.app` |
| `E2E_API_URL` | API base URL | (unset; tests that hit API directly need this) |
| `E2E_ADMIN_EMAIL` | Login email | — (required) |
| `E2E_ADMIN_PASSWORD` | Login password | — (required) |
| `E2E_MACOS_DEVICE_ID` | Enrolled macOS device UUID | — (tests that need it skip when unset) |
| `E2E_WINDOWS_DEVICE_ID` | Enrolled Windows device UUID | — |
| `E2E_LINUX_DEVICE_ID` | Enrolled Linux device UUID | — |
| `CI` | Set by CI runners; enables retries + GitHub reporter | — |

## Fixtures

```ts
import { test, expect } from '../fixtures';

// Worker-scoped: logs in once per worker, reuses storageState across tests
test('something authenticated', async ({ authedPage }) => {
  await authedPage.goto('/devices');
  // ...
});

// Test-scoped: fresh browser context, no storage state — for login/logout flows
test('login round-trip', async ({ cleanPage }) => {
  await cleanPage.goto('/login');
  // ...
});
```

## Writing a New Test

1. **Find or create a Page Object** in `playwright/pages/`. Locators are method properties using `getByRole`, `getByText`, `getByLabel`. Avoid raw CSS selectors like `p`, `h2`, or class names — SSR shells (e.g. `AiChatSidebar`) will hijack bare-tag selectors. See PR #520 for the trail of pain.

   ```ts
   // playwright/pages/MyPage.ts
   import { BasePage } from './BasePage';

   export class MyPage extends BasePage {
     url = '/my-page';
     heading = () => this.page.getByRole('heading', { level: 1 });
     submitButton = () => this.page.getByRole('button', { name: 'Save' });

     async goto() {
       await this.page.goto(this.url);
       await this.heading().waitFor();
     }
   }
   ```

2. **Write the spec** in `playwright/tests/`. Import the fixture and POM:

   ```ts
   import { test, expect } from '../fixtures';
   import { MyPage } from '../pages/MyPage';

   test.describe('My Feature', () => {
     test('renders correctly', async ({ authedPage }) => {
       const page = new MyPage(authedPage);
       await page.goto();
       await expect(page.heading()).toContainText('My Page');
     });
   });
   ```

3. **Need test data?** Extend `seed-fixtures.sql`. Don't create fixtures inside test bodies — keep the SQL file as the single source of truth.

## Troubleshooting

### `pnpm test:pw` fails immediately with "docker exec ... breeze-postgres not found"

`globalSetup` tries to run `seed-fixtures.sql` against a local Docker stack. Bring it up first:

```bash
docker compose -f docker-compose.yml -f docker-compose.override.yml.dev up --build -d
```

### Login fails with 429 (rate limited)

Local dev rate limit is 5 logins per 5 minutes per IP+email. Clear Redis:

```bash
docker exec breeze-redis redis-cli EVAL \
  "local k=redis.call('KEYS','login:*'); for _,v in ipairs(k) do redis.call('DEL',v) end; return #k" 0
```

The worker-scoped `authedPage` fixture only logs in once per worker, so this rarely triggers in normal runs.

### "Storage state not found" on first run

The fixture writes per-worker storage state to `playwright/.auth/worker-N.json`. If you delete that directory mid-run, tests will re-login automatically.

### Selector drift after a UI change

Open trace viewer: `pnpm test:pw:report`. Update the offending POM in `playwright/pages/` — every spec that uses it recovers automatically.
