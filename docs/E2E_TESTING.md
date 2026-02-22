# Breeze RMM End-to-End Testing

This document covers both E2E test systems used by Breeze: the **Playwright browser tests** that run in GitHub Actions CI, and the **AI-agent-driven YAML test runner** designed for cross-platform testing against real infrastructure.

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [Overview](#overview)
3. [System 1: Playwright Browser Tests (CI)](#system-1-playwright-browser-tests-ci)
4. [System 2: AI-Agent YAML Test Runner](#system-2-ai-agent-yaml-test-runner)
5. [Writing New Tests](#writing-new-tests)
6. [Environment Variables](#environment-variables)
7. [Troubleshooting](#troubleshooting)

---

## Quick Start

### Step 1: Install dependencies (one-time)

```bash
cd e2e-tests
npm install
npx playwright install chromium
```

### Step 2: Try the YAML runner in simulate mode (no servers needed)

This validates your test definitions and walks through every step with fake results. Zero infrastructure required.

```bash
npx tsx run.ts --mode simulate --verbose
```

You should see a banner, a test plan, and each step printing `[UI] Simulated` or `[REMOTE] Simulated` with a checkmark.

### Step 3: Run Playwright browser tests (needs local servers)

This runs the `.spec.ts` tests against your actual UI.

```bash
# Terminal 1: start the database, API, and web server
cd /path/to/breeze
pnpm db:push && pnpm db:seed   # first time only -- creates tables + admin account
pnpm dev

# Terminal 2: run the tests
cd e2e-tests
npm test
```

The admin account created by `db:seed` is `admin@breeze.local` / `BreezeAdmin123!`. The tests use this automatically.

Useful variations:

```bash
npm run test:headed    # watch the browser as tests run
npm run test:ui        # Playwright's interactive UI for picking/debugging tests
npx playwright test tests/auth.spec.ts   # run a single spec file
```

### Step 4: Run YAML tests in live mode (needs local servers + remote nodes)

This is the full AI-agent-driven flow. You need:
- Local API + web running (same as Step 3)
- Remote MCP servers running on test machines (Windows/Linux/macOS) over Tailscale on port 3100
- Environment variables for node hosts and tokens:

```bash
export TEST_USER_EMAIL="admin@breeze.local"
export TEST_USER_PASSWORD="BreezeAdmin123!"
export LINUX_NODE_HOST="your-linux-host.tailnet"
export LINUX_NODE_TOKEN="your-token"
# ... same for WINDOWS_NODE_HOST/TOKEN and MACOS_NODE_HOST/TOKEN
```

Then run:

```bash
# Live remote commands, but simulate UI steps (no Playwright needed on remote)
npx tsx run.ts --mode live --allow-ui-simulate --nodes linux

# Full live mode -- real Playwright + real remote MCP calls
npx tsx run.ts --mode live
```

Or just ask Claude Code conversationally:
> "Run the Linux agent installation test in simulate mode"

---

## Overview

```
e2e-tests/
  config.yaml              # Node and environment configuration (YAML runner)
  playwright.config.ts     # Playwright configuration (CI runner)
  package.json             # Dependencies and npm scripts
  run.ts                   # YAML test runner CLI
  helpers/
    api.ts                 # Direct API client for test setup/teardown
    auth.ts                # Login/logout helpers for Playwright
  tests/
    global-setup.ts        # Playwright: authenticates admin, saves session
    global-teardown.ts     # Playwright: cleans up E2E-prefixed test data
    helpers.ts             # waitForApp() and shared utilities
    *.spec.ts              # Playwright browser test specs (run in CI)
    *.yaml                 # YAML test definitions (run by AI agent)
```

There are two distinct test systems:

| | Playwright Specs (`.spec.ts`) | YAML Runner (`.yaml` + `run.ts`) |
|---|---|---|
| **Purpose** | Automated UI regression tests | Cross-platform infra testing |
| **Runs in** | GitHub Actions CI | Locally, driven by Claude Code |
| **Executor** | Playwright Test framework | Custom `run.ts` CLI |
| **Targets** | Browser against localhost | Browser + remote machines via MCP |
| **Auth** | Shared session via `global-setup.ts` | Per-test login steps |

---

## System 1: Playwright Browser Tests (CI)

These are standard Playwright specs that run automatically on every push to `main` and every PR targeting `main`.

### What runs in CI

The `e2e` job in `.github/workflows/ci.yml`:

1. Spins up **Postgres 16** and **Redis 7** as service containers
2. Downloads the API build artifact from the `build-api` job
3. Rebuilds the web app with `PUBLIC_API_URL=http://localhost:3001` (baked into Vite at compile time since there's no reverse proxy in test)
4. Pushes the DB schema (`pnpm db:push`) and seeds test data (`pnpm db:seed`)
5. Starts the API on `:3001` and the web server on `:4321`
6. Waits for both services to respond to health checks
7. Runs `npx playwright test --reporter=list`
8. Uploads the Playwright HTML report and test results as artifacts (14-day retention)

The E2E job runs on a **self-hosted runner** with a 20-minute timeout. It depends on `build-api` completing first.

### Test specs

| Spec | What it tests |
|------|---------------|
| `auth.spec.ts` | Login, invalid credentials, MFA prompt, logout, password reset |
| `dashboard.spec.ts` | Dashboard loads, sidebar navigation works |
| `devices.spec.ts` | Device list, device details |
| `alerts.spec.ts` | Alert views |
| `scripts-crud.spec.ts` | Script CRUD operations |
| `automations-crud.spec.ts` | Automation CRUD |
| `sites-crud.spec.ts` | Site management |
| `patches.spec.ts` | Patch management |
| `policies.spec.ts` | Policy views |
| `reports.spec.ts` | Reports |
| `software.spec.ts` | Software inventory |
| `settings.spec.ts` | Settings pages |
| `security.spec.ts` | Security-related UI tests |
| `audit.spec.ts` | Audit log views |

### Authentication flow

`global-setup.ts` runs first as a Playwright "setup" project:
- Logs in as the admin user (`admin@breeze.local` / `BreezeAdmin123!`)
- Waits for Zustand to persist the auth state (access token in localStorage)
- Saves the browser storage state to `.auth/user.json`
- All `chromium` project tests reuse this saved state (already logged in)

Auth tests (`auth.spec.ts`) explicitly clear storage state so they can exercise the login flow from scratch.

`global-teardown.ts` runs after all tests:
- Logs in via the API client
- Deletes any devices, scripts, or alert rules whose names start with `E2E` or `e2e-test-`

### Running locally

```bash
cd e2e-tests
npm install
npx playwright install chromium

# You need the API + web running locally first:
#   Terminal 1: pnpm dev (or start API on :3001 and web on :4321)

# Run all specs
npm test

# Run with browser visible
npm run test:headed

# Run with Playwright's interactive UI
npm run test:ui

# Run a single spec file
npx playwright test tests/auth.spec.ts

# Run a single test by name
npx playwright test -g "login with valid credentials"
```

### Playwright configuration

Key settings from `playwright.config.ts`:

- **Test directory**: `./tests` (only `.spec.ts` files)
- **Parallel**: fully parallel
- **Retries**: 1 in CI, 0 locally
- **Workers**: 1 in CI, auto locally
- **Timeouts**: 30s per test, 10s for expect, 60s for navigation, 15s for actions
- **Browsers**: Chromium always; Firefox added locally (skipped in CI)
- **Artifacts**: traces on first retry, screenshots on failure, video retained on failure in CI

---

## System 2: AI-Agent YAML Test Runner

This is a custom test runner designed to be orchestrated by an AI agent (Claude Code). It combines **Playwright browser actions** with **remote MCP calls** to test the full Breeze stack across real Windows, Linux, and macOS machines.

### Architecture

```
Your Machine (Coordinator)
  Claude Code
    |-- run.ts (YAML test runner)
    |     |-- Playwright --> Browser --> Breeze UI (localhost)
    |     |-- JSON-RPC --> windows-node:3100/mcp --> Claude Code on Windows
    |     |-- JSON-RPC --> linux-node:3100/mcp --> Claude Code on Linux
    |     \-- JSON-RPC --> macos-node:3100/mcp --> Claude Code on macOS
    |
    \-- Conversational mode (ask Claude to run/debug tests)
```

Each remote node runs an MCP server on port 3100. The runner sends JSON-RPC `tools/call` requests to invoke `claude_code` (or other tools) on the remote machine. The remote Claude Code instance executes shell commands, checks service status, reads logs, and returns structured JSON results.

### How to run

```bash
cd e2e-tests
npm install
npx playwright install chromium
```

**Three execution modes:**

```bash
# 1. Dry run -- shows what would run, executes nothing
npx tsx run.ts --dry-run

# 2. Simulate -- walks through all steps with fake results (100ms delay each)
npx tsx run.ts --mode simulate

# 3. Live -- real Playwright actions + real MCP calls to remote nodes
npx tsx run.ts --mode live
```

**Filtering:**

```bash
# Run a specific test by ID (or partial match)
npx tsx run.ts --mode simulate --test agent_install_linux

# Filter by tags
npx tsx run.ts --mode simulate --tags critical
npx tsx run.ts --mode simulate --tags scripts,alerts

# Filter by platform/node
npx tsx run.ts --mode live --nodes linux
npx tsx run.ts --mode live --nodes windows,macos

# Live remote execution, but skip Playwright UI steps
npx tsx run.ts --mode live --allow-ui-simulate

# Verbose output (shows action details and results)
npx tsx run.ts --mode live --verbose
```

**npm script shortcuts:**

```bash
npm run test:yaml              # live mode
npm run test:yaml:simulate     # simulate mode
npm run test:yaml:dry          # dry run
npm run test:yaml:critical     # live, critical tag only
npm run test:yaml:linux        # live, linux node only
npm run test:yaml:windows:simulate  # simulate, windows only
```

### Conversational mode

Instead of using the CLI, you can ask Claude Code directly:

```
You: Run the Linux agent installation test in simulate mode

Claude: [Reads YAML, executes steps, shows progress]

You: The script execution test failed at step verify_on_remote -- investigate

Claude: [Connects to Linux node via MCP, checks logs, reports findings]

You: Show me the agent logs from the Windows node

Claude: [Calls remote MCP, reads C:\ProgramData\Breeze\logs, returns output]
```

### YAML test definitions

Tests live in `e2e-tests/tests/*.yaml`. Each file contains one or more tests:

```yaml
tests:
  - id: unique_test_id           # Used for --test filtering
    name: "Human-readable name"
    description: "What this test does"
    tags: [tag1, tag2, critical]  # Used for --tags filtering
    nodes: [linux, windows]       # Which platforms this test needs
    timeout: 300000               # Overall test timeout (ms)
    steps:
      - id: step_id
        action: ui | remote
        description: "What this step does"
        # ... action-specific config
```

### Available YAML tests

| File | Test ID | Description | Nodes |
|------|---------|-------------|-------|
| `agent_install.yaml` | `agent_install_windows` | Install agent on Windows, verify enrollment | windows |
| | `agent_install_linux` | Install agent on Linux, verify enrollment | linux |
| | `agent_install_macos` | Install agent on macOS, verify enrollment | macos |
| `script_execution.yaml` | `script_execution_single` | Create and run a script on one device | linux |
| | `script_execution_cross_platform` | Run platform-specific scripts on all devices | all |
| | `script_execution_failure_handling` | Verify failed scripts are reported correctly | linux |
| `alert_lifecycle.yaml` | `alert_cpu_threshold` | Trigger CPU alert, verify lifecycle | linux |
| | `alert_disk_space` | Disk space monitoring alert | linux |
| | `alert_agent_offline` | Stop agent, verify offline alert | linux |
| `remote_session.yaml` | `remote_terminal_session` | Remote terminal session and command execution | linux |
| | `remote_file_transfer` | Upload/download files to remote device | linux |
| | `remote_session_windows` | Windows remote desktop session | windows |

### Step types

#### UI steps (`action: ui`)

Execute Playwright browser actions against the Breeze web UI:

```yaml
- id: login
  action: ui
  description: "Login to dashboard"
  playwright:
    # Navigate
    - goto: "/login"

    # Fill form fields (selector: value)
    - fill:
        "[name='email']": "${TEST_USER_EMAIL}"
        "[name='password']": "${TEST_USER_PASSWORD}"

    # Click an element
    - click: "button[type='submit']"

    # Wait for element to be visible
    - waitFor: "h1:has-text('Dashboard')"

    # Wait with options
    - waitFor:
        url: "**/dashboard"
        timeout: 60000

    # Assert text content
    - assert:
        selector: "[data-testid='device-status']"
        text: "Online"           # Exact match
        contains: "line"         # Partial match

    # Assert element does NOT exist
    - assertNotExists: "tr:has-text('E2E Disk Alert')"

    # Extract values into variables for later steps
    - extract:
        enrollmentKey: "div.fixed code"

    # Type text (character by character, triggers key events)
    - type:
        selector: "[data-testid='terminal-input']"
        text: "echo hello"

    # Press a key
    - press: "Enter"
    - press:
        key: "Enter"
        selector: "#search"

    # Upload a file
    - uploadFile:
        selector: "[data-testid='file-input']"
        content: "file contents here"
        filename: "test.txt"
```

#### Remote steps (`action: remote`)

Execute commands on remote machines via MCP JSON-RPC:

```yaml
- id: check_agent
  action: remote
  node: linux                    # Which node from config.yaml
  description: "Check agent status"
  tool: claude_code              # MCP tool to invoke (default: claude_code)
  timeout: 60000
  args:
    prompt: |
      Check Breeze agent status:
      1. Run: systemctl status breeze-agent
      2. Return JSON: {running: boolean, status: string}
  expect:                        # Assert against returned JSON
    running: true
```

The `expect` block does deep equality checking. Keys in `expect` must exist in the response with matching values. Extra keys in the response are ignored.

### Variable system

**Environment variables** use `${VAR_NAME}` or `${VAR_NAME:-default}`:
```yaml
fill:
  "[name='email']": "${TEST_USER_EMAIL}"
  "[name='password']": "${TEST_USER_PASSWORD:-changeme}"
```

**Template variables** use `{{varName}}` and reference values extracted by earlier steps or built-in context:
```yaml
# Step 1 extracts enrollmentKey from UI
- extract:
    enrollmentKey: "div.fixed code"

# Step 2 uses it in a remote command
args:
  prompt: "Enroll using key: {{enrollmentKey}}"
```

Built-in variables: `{{baseUrl}}`, `{{apiUrl}}`, `{{testId}}`.

Each step's output is stored as `{{stepId}}` and its individual keys are merged into the variable context.

### Node configuration

Remote nodes are defined in `config.yaml`:

```yaml
nodes:
  linux:
    name: "Linux Test Node"
    host: "${LINUX_NODE_HOST:-linux.tailnet}"  # Tailscale hostname or IP
    port: 3100                                  # MCP server port
    auth:
      type: bearer
      token: "${LINUX_NODE_TOKEN}"              # Auth token for MCP
    platform: linux
```

Each node needs:
- A running MCP server on the specified port
- Network connectivity (typically Tailscale)
- A bearer token for authentication

---

## Writing New Tests

### Adding a Playwright spec

1. Create `e2e-tests/tests/my-feature.spec.ts`
2. Tests automatically get the admin session from `global-setup.ts`
3. Use `waitForApp(page)` after navigation to handle hydration
4. Prefix test fixture names with `E2E` so `global-teardown.ts` cleans them up

```typescript
import { test, expect } from '@playwright/test';
import { waitForApp } from './helpers';

test.describe('My Feature', () => {
  test('does the thing', async ({ page }) => {
    await page.goto('/my-page');
    await waitForApp(page, '/my-page');

    await expect(page.locator('h1')).toContainText('My Page');
  });
});
```

### Adding a YAML test

1. Create `e2e-tests/tests/my-feature.yaml` (or add to an existing file)
2. Give each test a unique `id` and descriptive `tags`
3. Set `nodes` to the platforms required
4. Use `optional: true` on cleanup steps so failures don't fail the test
5. Remote steps should ask for structured JSON responses with an `expect` block

```yaml
tests:
  - id: my_feature_test
    name: "My Feature Test"
    tags: [my-feature, basic]
    nodes: [linux]
    timeout: 120000
    steps:
      - id: login
        action: ui
        playwright:
          - goto: "/login"
          - fill:
              "[name='email']": "${TEST_USER_EMAIL}"
              "[name='password']": "${TEST_USER_PASSWORD}"
          - click: "button[type='submit']"
          - waitFor: "[data-testid='dashboard']"

      - id: check_something
        action: remote
        node: linux
        tool: claude_code
        args:
          prompt: |
            Check something on the machine:
            1. Run the command
            2. Return JSON: {result: boolean, details: string}
        expect:
          result: true

      - id: cleanup
        action: remote
        node: linux
        tool: claude_code
        args:
          prompt: "Clean up test artifacts. Return JSON: {cleaned: boolean}"
        optional: true
```

---

## Environment Variables

### Required for CI (set in workflow)

| Variable | Value | Description |
|----------|-------|-------------|
| `DATABASE_URL` | `postgresql://breeze:breeze_test@localhost:5432/breeze_test` | Test database |
| `REDIS_URL` | `redis://localhost:6379` | Redis for BullMQ / rate limiting |
| `JWT_SECRET` | (test value) | JWT signing secret |
| `APP_ENCRYPTION_KEY` | (test value) | App-level encryption |
| `MFA_ENCRYPTION_KEY` | (test value) | MFA secret encryption |
| `PUBLIC_API_URL` | `http://localhost:3001` | Baked into web build for browser API calls |
| `E2E_BASE_URL` | `http://localhost:4321` | Web app URL |
| `E2E_API_URL` | `http://localhost:3001` | API URL |
| `E2E_ADMIN_EMAIL` | `admin@breeze.local` | Must match `db:seed` admin |
| `E2E_ADMIN_PASSWORD` | `BreezeAdmin123!` | Must match `db:seed` admin |

### Required for YAML runner (set locally)

| Variable | Description |
|----------|-------------|
| `TEST_USER_EMAIL` | Login email for UI steps |
| `TEST_USER_PASSWORD` | Login password for UI steps |
| `WINDOWS_NODE_HOST` | Windows node hostname (default: `windows.tailnet`) |
| `WINDOWS_NODE_TOKEN` | Bearer token for Windows MCP server |
| `LINUX_NODE_HOST` | Linux node hostname (default: `linux.tailnet`) |
| `LINUX_NODE_TOKEN` | Bearer token for Linux MCP server |
| `MACOS_NODE_HOST` | macOS node hostname (default: `macos.tailnet`) |
| `MACOS_NODE_TOKEN` | Bearer token for macOS MCP server |

### Optional

| Variable | Description |
|----------|-------------|
| `E2E_MFA_EMAIL` / `E2E_MFA_PASSWORD` | MFA-enabled account for MFA tests |
| `E2E_BROWSER` | Override browser (default: `chromium`) |
| `E2E_HEADLESS` | `true`/`false` (default: `false` for YAML runner) |
| `E2E_SLOWMO` | Milliseconds of delay between Playwright actions |
| `E2E_ALLOW_UI_SIMULATION_IN_LIVE` | `true` to simulate UI steps in live mode |

---

## Troubleshooting

### Playwright specs

**Tests fail with "Login did not redirect to dashboard"**
- The API or web server isn't running. Start with `pnpm dev` or run API on `:3001` and web on `:4321`
- The seed data hasn't been loaded. Run `pnpm db:push && pnpm db:seed`
- Check that `E2E_ADMIN_EMAIL` / `E2E_ADMIN_PASSWORD` match what `db:seed` creates

**Tests pass locally but fail in CI**
- CI uses 1 worker (sequential). Local runs use auto (parallel). A test may have an unintended dependency on another test's state
- CI only runs Chromium. Firefox is only tested locally
- Check the uploaded Playwright report artifact for screenshots and traces

**`waitForApp()` times out**
- The page may have redirected to `/login` (session expired). `waitForApp` will attempt re-authentication
- Check that the storage state in `.auth/user.json` has valid tokens

### YAML runner

**"Unknown node" error**
- The node isn't defined in `config.yaml`. Check spelling matches: `windows`, `linux`, `macos`

**"Node not reachable" / connection refused**
- Verify Tailscale connectivity: `tailscale status`
- Confirm the MCP server is running on the remote node at the configured port (default 3100)
- Check firewall allows the port

**"Playwright is required for live UI steps"**
- Run `npm install && npx playwright install chromium` in the `e2e-tests` directory
- Or use `--allow-ui-simulate` to skip Playwright in live mode

**Remote step returns unexpected results**
- Use `--verbose` to see the full JSON response from the remote node
- The runner tries to extract structured JSON from the MCP response (checks `structuredContent`, then `content[].text`, then `text`)
- Ensure the remote Claude Code prompt asks for explicit JSON output

**Simulated variables are empty**
- In simulate mode, `extract` actions create placeholder values like `simulated-enrollmentKey`. Downstream steps will use these placeholders
- This is expected; simulation only validates the test structure, not real data
