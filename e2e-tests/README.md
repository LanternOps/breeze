# Breeze E2E Tests

YAML-driven end-to-end test suite for Breeze RMM. Tests drive the UI via Playwright and verify agent behavior through API log queries — no remote MCP servers required.

## Quick Start

```bash
cd e2e-tests
npm install
npx playwright install chromium

# Simulate all tests (no browser, validates YAML structure)
npx tsx run.ts --mode simulate

# Run all tests live (headless Chromium)
npx tsx run.ts --mode live

# Run a single test
npx tsx run.ts --mode live --test dashboard_comprehensive

# Run tests by tag
npx tsx run.ts --mode live --tags critical
npx tsx run.ts --mode live --tags dashboard,smoke
```

## Configuration

### Environment Variables

Set in the parent `.env` file (`../breeze/.env`). The runner loads it automatically via dotenv.

| Variable | Purpose | Default |
|----------|---------|---------|
| `E2E_BASE_URL` | Breeze UI URL | `http://localhost:4321/` |
| `E2E_API_URL` | Breeze API URL | `http://localhost:3001` |
| `E2E_ADMIN_EMAIL` | Login email (aliased to `TEST_USER_EMAIL`) | `admin@breeze.local` |
| `E2E_ADMIN_PASSWORD` | Login password (aliased to `TEST_USER_PASSWORD`) | `BreezeAdmin123!` |
| `E2E_MACOS_DEVICE_ID` | Enrolled macOS device UUID | — |
| `E2E_WINDOWS_DEVICE_ID` | Enrolled Windows device UUID | — |
| `E2E_LINUX_DEVICE_ID` | Enrolled Linux device UUID | — |
| `E2E_HEADLESS` | Override headless mode (`true`/`false`) | `true` |
| `E2E_SLOWMO` | Playwright slowMo in ms | `0` |
| `E2E_API_TIMEOUT_MS` | Max time for API steps | `5000` |

### config.yaml

```yaml
environment:
  baseUrl: "${E2E_BASE_URL:-http://localhost:4321/}"
  apiUrl: "${E2E_API_URL:-http://localhost:3001}"
  defaultTimeout: 10000     # per-step timeout (ms)
  testTimeout: 300000       # per-test timeout (ms)

api:
  apiKey: "${E2E_API_KEY}"
  email: "${E2E_ADMIN_EMAIL:-admin@breeze.local}"
  password: "${E2E_ADMIN_PASSWORD:-BreezeAdmin123!}"

devices:
  windows: "${E2E_WINDOWS_DEVICE_ID}"
  linux: "${E2E_LINUX_DEVICE_ID}"
  macos: "${E2E_MACOS_DEVICE_ID}"

playwright:
  browser: chromium
  headless: true
  slowMo: 0
```

## How It Works

### Architecture

```
┌──────────────────────────────────────────────────────────┐
│  Test Runner (run.ts)                                     │
│                                                           │
│  1. Parses YAML test files from tests/                    │
│  2. Launches shared Chromium browser (one instance)       │
│  3. For each test:                                        │
│     ├─ Creates fresh browser context (isolated cookies)   │
│     ├─ Executes steps sequentially:                       │
│     │   ├─ ui:     Playwright actions (goto, fill, click) │
│     │   ├─ api:    REST calls to Breeze API               │
│     │   └─ remote: MCP calls to test nodes (deprecated)   │
│     └─ Captures browser errors, screenshots on failure    │
│                                                           │
│  Key optimizations:                                       │
│  - Token reuse: UI login response intercepted → API steps │
│    reuse the same JWT (no extra login = no rate limiting)  │
│  - Cookie caching: storage state persisted across tests   │
│  - Rate limit clearing: auto-clears Redis keys every 4    │
│    tests via docker exec (local dev only)                  │
└──────────────────────────────────────────────────────────┘
```

### Three Action Types

**`ui`** — Playwright browser automation

```yaml
- id: login
  action: ui
  playwright:
    - goto: "/login"
    - waitFor: "text=Sign in"
    - fill:
        "[name='email']": "${TEST_USER_EMAIL}"
        "[name='password']": "${TEST_USER_PASSWORD}"
    - click: "button[type='submit']"
    - waitFor:
        url: "**/"
        timeout: 15000
```

**`api`** — Authenticated REST calls to Breeze API (verifies agent behavior via shipped logs)

```yaml
- id: verify_logs
  action: api
  description: "Verify agent shipped diagnostic logs"
  request:
    method: GET
    path: "/api/v1/devices/{{devices.macos}}/diagnostic-logs"
    query:
      component: heartbeat
      since: "{{twoHoursAgo}}"
  expect:
    total: "> 0"
```

**`remote`** — MCP calls to test nodes (deprecated, auto-skipped if no nodes configured)

### Supported UI Actions

| Action | Example | Notes |
|--------|---------|-------|
| `goto` | `goto: "/devices"` | Waits for domcontentloaded + 5s networkidle for hydration |
| `fill` | `fill: { "[name='email']": "user@example.com" }` | Selector → value map |
| `click` | `click: "button[type='submit']"` | CSS selector |
| `waitFor` | `waitFor: "text=Dashboard"` | Selector, text, or `{ url, state, timeout }` |
| `assert` | `assert: { selector: "h1", contains: "Dashboard" }` | `exists`, `text`, `contains` (case-insensitive) |
| `assertNotExists` | `assertNotExists: ".error-banner"` | Element should not be in DOM |
| `type` | `type: "search text"` | Types into focused element |
| `press` / `press_key` | `press_key: "Escape"` | Keyboard key press |
| `selectOption` | `selectOption: { "select.filter": "active" }` | Native `<select>` dropdown |
| `hover` | `hover: ".menu-trigger"` | Mouse hover |
| `check` / `uncheck` | `check: "#agree-checkbox"` | Checkbox toggle |
| `scrollTo` | `scrollTo: ".footer"` | Scroll element into view |
| `extract` | `extract: { selector: "h1", as: "pageTitle" }` | Extract text into variable |
| `uploadFile` | `uploadFile: { selector: "input[type=file]", path: "./test.csv" }` | File upload |

### Template Variables

Available in `api` paths and `ui` text via `{{variable}}` syntax:

| Variable | Value |
|----------|-------|
| `{{baseUrl}}` | Resolved `E2E_BASE_URL` |
| `{{apiUrl}}` | Resolved `E2E_API_URL` |
| `{{testId}}` | Current test ID |
| `{{testStartTime}}` | ISO timestamp when test started |
| `{{twoHoursAgo}}` | ISO timestamp 2 hours before test start |
| `{{oneHourAgo}}` | ISO timestamp 1 hour before test start |
| `{{devices.macos}}` | macOS device UUID |
| `{{devices.windows}}` | Windows device UUID |
| `{{devices.linux}}` | Linux device UUID |

Environment variables are resolved with `${VAR_NAME}` or `${VAR:-default}` syntax.

### API Expect Operators

The `expect` block supports comparison operators for numeric fields:

```yaml
expect:
  total: "> 0"        # greater than
  count: ">= 5"       # greater than or equal
  errors: "< 10"      # less than
  status: online       # exact match (string)
```

## Writing Tests

### Example: Comprehensive UI + API Test

See `tests/agent_log_shipping.yaml` for a complete example that:
1. Logs in via UI
2. Queries diagnostic logs via API (verifies agent is shipping)
3. Filters by component and time range
4. Navigates to device detail page via UI
5. Verifies device status via API

### Example: Pure UI Smoke Test

See `tests/dashboard_comprehensive.yaml` for a single 11-step test covering:
login, stat cards, panels, sidebar nav, command palette, user menu, dark mode, API check, logout.

### Tips

- **One login per test**: The first test logs in via UI; the runner intercepts the login response and caches the JWT. Subsequent API steps reuse it automatically.
- **Cookie caching**: After a test closes, its browser cookies are saved. The next test starts with those cookies, so the login step often succeeds immediately (session still valid).
- **Rate limiting**: The runner auto-clears Redis rate limit keys every 4 tests. If running against a remote deployment without Docker access, space tests apart or increase the rate limit.
- **Hydration**: The `goto` action waits for `domcontentloaded` then up to 5s for `networkidle`. This gives Astro's React islands time to hydrate before form interactions.
- **Case-insensitive contains**: `assert: { contains: "Dashboard" }` matches "DASHBOARD", "dashboard", etc.

## Troubleshooting

### Rate limiting (429 on login)

Each login counts against a 5-per-5-minute limit. The runner clears Redis keys automatically, but if you hit this:

```bash
# Clear manually
docker exec breeze-redis redis-cli EVAL \
  "local k=redis.call('KEYS','login:*'); for _,v in ipairs(k) do redis.call('DEL',v) end; return #k" 0

# Or restart Redis
docker restart breeze-redis
```

### Redis "max clients reached"

Too many rapid connections. Restart Redis:

```bash
docker restart breeze-redis
```

### Login form submits as GET (credentials in URL)

React hasn't hydrated yet. The `goto` action's 5s networkidle wait should handle this. If it persists, add a `waitFor` step for a React-rendered element before filling the form.

### Selectors not matching

Run with `--verbose` to see full Playwright logs. Use browser DevTools to inspect the actual DOM. Common issues:
- Table headers render uppercase ("DEVICE") but test expects title case ("Device") — `contains` is case-insensitive, but `text` is exact
- Astro renders different HTML than expected — check the actual component source

### Tests with `remote` steps skip automatically

Tests using `action: remote` are auto-skipped when no MCP nodes are configured (host contains `${`). This is expected — `remote` is only needed for `agent_install` and `remote_session` tests.
