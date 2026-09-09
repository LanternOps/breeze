# Breeze E2E Tests

Playwright Test (TypeScript) end-to-end suite. **`data-testid`-based selectors only** — no text, role, label, or CSS selectors. This is a hard rule, not a guideline.

## Quick Start

```bash
cd e2e-tests
pnpm install
pnpm exec playwright install chromium

pnpm test          # run all specs (parallel, headless)
pnpm test:ui       # interactive Playwright UI
pnpm test:headed   # see the browser
pnpm test:debug    # PWDEBUG=1, single worker, opens devtools
pnpm test:report   # show last HTML report
```

## Layout

```
e2e-tests/
├── playwright.config.ts   # standard @playwright/test config
├── global-setup.ts        # seeds DB + logs in once + saves storageState
├── fixtures.ts            # authedPage (storageState load) + cleanPage (no auth)
├── seed-fixtures.sql      # required test data
├── pages/                 # Page Object Models — one per surface
│   └── BasePage.ts
└── tests/                 # one .spec.ts per domain
```

## The `data-testid` Convention

**Why this and only this:** copy can change ("Welcome" → "Good afternoon"), styles can change, ARIA roles can change. Test IDs only change when the test author renames them. That's the contract.

### Naming

`<domain>-<element>[-<modifier>]`, all lowercase, kebab-case.

| Element type | Pattern | Example |
|---|---|---|
| Page heading (h1) | `<page>-heading` | `data-testid="dashboard-heading"` |
| Section / card | `<page>-<section>-card` | `data-testid="dashboard-total-devices-card"` |
| Primary action button | `<page>-<action>-button` | `data-testid="alert-ack-button"` |
| Form input | `<form>-<field>-input` | `data-testid="login-email-input"` |
| Form submit | `<form>-submit` | `data-testid="login-submit"` |
| Table | `<entity>-table` | `data-testid="device-table"` |
| Table row (indexed) | `<entity>-row-<id>` | `` data-testid={`device-row-${device.id}`} `` |
| Table column header | `<entity>-col-<name>` | `data-testid="device-col-status"` |
| Modal | `<purpose>-modal` | `data-testid="invite-user-modal"` |
| Empty state | `<page>-empty` | `data-testid="alerts-empty"` |
| Tab button | `<page>-tab-<name>` | `data-testid="security-tab-recommendations"` |

### Apply to

- ✅ All h1 page headings
- ✅ Stat / summary cards
- ✅ Primary CTAs (buttons, links acting as buttons)
- ✅ All form fields + submit buttons
- ✅ Table containers + rows (with indexed id)
- ✅ Modal containers + their primary actions
- ✅ Tab buttons
- ✅ Empty / error / loading states
- ✅ Anything a test wants to assert visibility of

### Don't apply to

- ❌ Decorative elements (icons used purely for visual flair)
- ❌ Layout containers with no testable assertion
- ❌ Navigation icons that already have stable `aria-label` *and* are never asserted on

## Writing a New Test

1. **Open the live page in your browser.** Identify what assertions matter (e.g. "the page loads with a heading and a primary CTA").

2. **Add `data-testid` to the relevant components** in `apps/web/src/components/<domain>/` (or `apps/web/src/pages/<domain>/`). Follow the naming above. If a testid already exists for what you need, reuse it.

3. **Create or extend a Page Object** in `e2e-tests/pages/`. Example:

   ```ts
   // e2e-tests/pages/DevicesPage.ts
   import { BasePage } from './BasePage';

   export class DevicesPage extends BasePage {
     url = '/devices';
     heading = () => this.page.getByTestId('devices-heading');
     searchInput = () => this.page.getByTestId('devices-search-input');
     deviceTable = () => this.page.getByTestId('device-table');
     deviceRow = (id: string) => this.page.getByTestId(`device-row-${id}`);

     async goto() {
       await this.page.goto(this.url);
       await this.heading().waitFor();
     }
   }
   ```

4. **Write the spec** under `e2e-tests/tests/`:

   ```ts
   import { test, expect } from '../fixtures';
   import { DevicesPage } from '../pages/DevicesPage';

   test.describe('Devices', () => {
     test('list page loads', async ({ authedPage }) => {
       const devices = new DevicesPage(authedPage);
       await devices.goto();
       await expect(devices.deviceTable()).toBeVisible();
     });
   });
   ```

5. **Run it live** against the local stack:
   ```bash
   pnpm test tests/devices.spec.ts
   ```
   Iterate until green. Don't merge a spec that hasn't been verified against a running stack.

## Fixtures

```ts
import { test, expect } from '../fixtures';

// Logged in (storageState loaded from globalSetup) — for 99% of tests.
test('something authed', async ({ authedPage }) => { ... });

// Fresh browser context, no auth — for testing real login/logout/redirect flows.
test('login round-trip', async ({ cleanPage }) => { ... });
```

## Configuration

Set in the parent `.env` file. Playwright reads via `process.env`:

| Variable | Purpose |
|---|---|
| `E2E_BASE_URL` | Web app URL (default `http://localhost:4321`) |
| `E2E_API_URL` | API base URL |
| `E2E_ADMIN_EMAIL` | Login email (required) |
| `E2E_ADMIN_PASSWORD` | Login password (required) |
| `E2E_MACOS_DEVICE_ID` | Enrolled macOS device UUID (tests that need it skip when unset) |
| `E2E_WINDOWS_DEVICE_ID` | Enrolled Windows device UUID |
| `E2E_LINUX_DEVICE_ID` | Enrolled Linux device UUID |
| `REDIS_PASSWORD` | Used by globalSetup to clear login rate-limit |

### Seeded admin and forced MFA (RMM-QA-164 / #5266)

A fresh stack seeds the system Partner Admin role with `force_mfa = true`
(#4491), and the seeded `admin@breeze.local` (or your
`BREEZE_BOOTSTRAP_ADMIN_EMAIL`) holds that role. When enforcement is on, that
admin is minted `mfa: false` and receives `428 mfa_enrollment_required` on the
first protected request — `globalSetup`'s login lands on
`/auth/mfa/setup?forced=1` instead of the dashboard, the shared storage state is
never written, and every spec fails before it starts.

Enforcement is gated by the API's `MFA_FORCE_FOR_PARTNER_ADMIN` flag. **Do not
rely on its shipping default**: it was `true` until #5307, is `false` for this
release only, and returns to `true` once #5306 (the grace-window feature) lands.
The stack must pin it explicitly.

- **`pnpm wt-stack up` pins it for you.** `scripts/dev/wt-stack/env.ts` writes
  `MFA_FORCE_FOR_PARTNER_ADMIN=false` into the generated `.env.stack`, which
  compose loads *after* your root `.env`, so it wins even if your `.env` sets the
  var. Nothing to do. (The `portal-dev-e2e` CI job writes the same value into its
  own `.env`.)
- **Any other stack** (a hand-rolled `docker compose -f docker-compose.yml -f
  docker-compose.override.yml.dev up`) is governed by your root `.env` and the
  shipping default. Set `MFA_FORCE_FOR_PARTNER_ADMIN=false` there and restart
  `api`, or enrol TOTP for that admin once (Settings → Security → Two-factor).

The flag suppresses **only** the role-force component; an org's or partner's
`security.requireMfa` setting is still enforced, so MFA-policy specs keep
working. Nothing here changes the stored `force_mfa` flag — the Partner Admin
posture is intact, and `globalSetup` fails fast with the remedy above rather
than timing out if it ever lands on `/auth/mfa/setup`.

### WebAuthn specs need `PUBLIC_APP_URL` to match the browser origin

`intent-self-approve.spec.ts` and `ai-operator-approve-after-browser-close.spec.ts`
run real WebAuthn ceremonies against Chrome's virtual authenticator. The server
derives its Relying Party ID from `PUBLIC_APP_URL`, and the browser refuses any
ceremony whose RP ID is not a suffix of the page's own origin
(`SecurityError: The relying party ID is not a registrable domain suffix ...`).
A stack whose `.env` still carries the production `PUBLIC_APP_URL` will fail
these two specs and only these two. Point it at the stack's own base URL (e.g.
`PUBLIC_APP_URL=http://localhost:<webPort>` from `.breeze-stack.json`) and
restart `api`.

Note also that the register-and-refresh ceremony ROTATES the refresh token,
which revokes the JTI the page's session store is holding — the browser session
that performs it is unusable afterwards ("Your session expired"). Enrol the key
in a session that has no in-app work left, and carry it to the next context with
`exportCredentials` / `importCredentials` (`e2e-tests/webauthn.ts`).

## Troubleshooting

### `globalSetup` fails on docker exec

Bring the local stack up:
```bash
docker compose -f docker-compose.yml -f docker-compose.override.yml.dev up --build -d
```

### Login 429 (rate limited)

`globalSetup` clears the per-email rate-limit window before it logs in, and now
reports a 429 as a 429 instead of letting it look like a login hang.

That clear talks to redis as `redis-cli -a $REDIS_PASSWORD`, so it **silently
no-ops when `REDIS_PASSWORD` is absent from the environment** and a stack whose
redis requires auth rejects the `DEL` (#5266). `pnpm wt-stack test` now passes
the value through from the stack's own env files; if you invoke `playwright
test` directly, export `REDIS_PASSWORD` yourself. If it still fires, your
stack's redis isn't reachable from the host — confirm the redis container is
running.

### Selector not found

Open the trace viewer:
```bash
pnpm test:report
```
Verify the `data-testid` exists on the live page (DevTools → search for `data-testid`). If the test ID was renamed in the component but the POM wasn't updated, fix the POM.

### Adding a feature → adding test IDs

Adding `data-testid` to a component **does not** require an immediate test. It's enough to add the attribute now so future tests can find the element. Apply test IDs as part of building or modifying components, not as a separate task.
