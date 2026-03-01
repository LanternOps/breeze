# E2E Test Known Issues

Tracking file for test failures, production bugs found during testing, and infrastructure gaps.

## Production Bugs Found

### 1. AccessReviewPage uses raw `fetch('/api/...')` instead of `fetchWithAuth` (FIXED)

**File:** `apps/web/src/components/settings/AccessReviewPage.tsx`
**Status:** Fixed — all 9 `fetch('/api/...')` calls replaced with `fetchWithAuth`.

### 2. Other components with the same raw `fetch('/api/...')` bug (FIXED)

**Status:** Fixed — all raw `fetch('/api/...')` calls replaced with `fetchWithAuth` in:
- QuarantinedDevices (3 calls)
- DeviceCompare (2 calls)
- DashboardCustomizer (1 call)
- DeviceGroupsPage (10 calls)
- ScheduledReports (8 calls)

### 3. BackupDashboard `resolveProviderColor` was undefined (FIXED)

**File:** `apps/web/src/components/backup/BackupDashboard.tsx`
**Status:** Fixed — moved function to module scope.

---

## Test Runner Bugs

### 1. Sub-action `optional: true` is silently ignored

**File:** `e2e-tests/run.ts`, `runUiPlaywrightAction` (~line 706)

The runner only reads `optional` at the **step** level (line 1523). When `optional: true` appears on individual Playwright sub-actions inside the `playwright:` array, it's parsed as YAML but never checked — the entire step fails if that sub-action fails.

**Affected tests:**
- `alert_lifecycle.yaml` lines 246, 249 (acknowledge button waitFor/click)
- `alert_lifecycle.yaml` line 407 (email card click in notification channel creation)

**Fix:** Either move `optional: true` to the step level, or add sub-action optional handling in `runUiPlaywrightAction`.

---

## Skipped Tests (No MCP Remote Nodes)

These 7 tests contain `action: remote` steps and are auto-skipped when MCP node hosts aren't configured. They require actual remote agent access via Claude Code MCP server on each node.

| Test | File | Node |
|------|------|------|
| `agent_install_windows` | `agent_install.yaml` | windows |
| `agent_install_linux` | `agent_install.yaml` | linux |
| `agent_install_macos` | `agent_install.yaml` | macos |
| `agent_offline_alert` | `alert_lifecycle.yaml` | linux |
| `remote_session_linux` | `remote_session.yaml` | linux |
| `remote_session_windows` | `remote_session.yaml` | windows |
| `remote_session_macos` | `remote_session.yaml` | macos |

---

## Optional Steps (Expected Failures)

Steps marked `optional: true` don't fail the test — they log the error and continue.

### Cleanup steps (test data may not exist)
- `script_execution.yaml` — `cleanup_delete_script`
- `agent_install.yaml` — `cleanup` (windows, linux, macos)
- `automations.yaml` — automation delete/cleanup
- `backup_lifecycle.yaml` — remote cleanup
- `remote_session.yaml` — test file cleanup
- `cis_hardening.yaml` — baseline cleanup

### Modal cancel steps (modal may not have opened)
- `settings_admin.yaml` — cancel_invite_modal, cancel_create_role_modal, cancel_create_key_modal, cancel_add_provider
- `integrations.yaml` — cancel_webhook_form, cancel_add_connection
- `configuration_policies.yaml` — cancel_to_policies_list, cancel_delete_modal

### Data-dependent steps (API may fail)
- `settings_admin.yaml` — Access Reviews page verification steps (4 steps, lines 540-571) — API route returns 404 in production
- `snmp_and_admin.yaml` — Quarantined devices table interactions (table may be empty)
- `cis_hardening.yaml` — baseline edit button (table may be empty)

---

## Selector Workarounds

### Device detail tab buttons scoped to `nav`

All tab clicks in `device_detail_tabs.yaml` use `nav button:has-text('...')` instead of `button:has-text('...')` to avoid matching non-tab buttons on the page (e.g., "Security overview" button matching "Security" tab).

### Performance tab uses exact text match

`nav button:text-is('Performance')` — because `has-text('Performance')` also matches the "Boot Performance" tab (substring match).

---

## Environment Requirements

These env vars must be set in `.env` for live tests to work:

| Variable | Required For | Default |
|----------|-------------|---------|
| `E2E_BASE_URL` | All tests | `http://localhost:4321/` |
| `E2E_API_URL` | API action steps | `http://localhost:3001` |
| `E2E_ADMIN_EMAIL` | Login | `admin@breeze.local` |
| `E2E_ADMIN_PASSWORD` | Login | none |
| `E2E_MACOS_DEVICE_ID` | Device detail tests | none |
| `E2E_WINDOWS_DEVICE_ID` | Windows-specific tests | none |
| `E2E_LINUX_DEVICE_ID` | Linux device tests | none |
| `E2E_MODE` | Disable rate limiting + extend JWT | `0` |
| `E2E_HEADLESS` | Show/hide browser | `true` |

Missing device IDs produce `__MISSING_devices.xxx__` in URLs and trigger 500s.
