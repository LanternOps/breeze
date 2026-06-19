---
name: feature-testing
description: Post-implementation end-to-end feature verification. Use after implementing a feature to verify it works across UI, API, and agent layers using Playwright MCP tools, make dev-push, diagnostic logs API, and structured test logging.
---

# Feature Testing

## Overview

Use this skill after implementing a feature to verify it actually works end-to-end. It guides you through phased verification across UI, API, and agent layers — using Playwright MCP for browser testing, `make dev-push` for agent deploys, the diagnostic logs API for agent verification, and a markdown log for tracking results.

**When to invoke:** After completing implementation of any feature, bugfix, or behavior change. Before claiming "done" or creating a PR.

**Credentials:** NEVER hardcode credentials. Always read from root `.env` using the `E2E_*` variables (`E2E_BASE_URL`, `E2E_API_URL`, `E2E_ADMIN_EMAIL`, `E2E_ADMIN_PASSWORD`, `E2E_MACOS_DEVICE_ID`, `E2E_WINDOWS_DEVICE_ID`). For agent deploys, use `BREEZE_API_KEY` and `BREEZE_DEV_DEVICE` from `.env.dev`. Source these files before running any commands that need auth.

## Phase 1: Classify Feature

Determine which phases to run based on what was implemented:

| Feature Type | Example | Phases |
|---|---|---|
| UI-only | New dashboard widget, form validation | 2, 4, 7 |
| API-only | New endpoint, query change | 2, 5, 7 |
| Agent-side | New command handler, collector | 2, 3, 5, 6, 7 |
| Full-stack | New feature spanning UI + API + agent | 2, 3, 4, 5, 6, 7 |

## Phase 2: Environment Check

### Required .env Variables

Read the root `.env` file and confirm these are set:

| Variable | Purpose | Example |
|---|---|---|
| `E2E_BASE_URL` | Web app URL | `https://2breeze.app` |
| `E2E_API_URL` | API URL | `https://2breeze.app` |
| `E2E_ADMIN_EMAIL` | Login email | `admin@breeze.local` |
| `E2E_ADMIN_PASSWORD` | Login password | (set in .env) |
| `E2E_MACOS_DEVICE_ID` | macOS test device | UUID |
| `E2E_WINDOWS_DEVICE_ID` | Windows test device | UUID |

### Docker Services

Check that required services are running:

```bash
docker compose ps --format "table {{.Name}}\t{{.Status}}" | grep -E "api|web|postgres|redis"
```

All four services (api, web, postgres, redis) must show "Up".

### Device Online Check (agent tests only)

```bash
curl -sf "${E2E_API_URL}/api/v1/devices/${E2E_MACOS_DEVICE_ID}" \
  -H "X-API-Key: ${BREEZE_API_KEY}" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'{d[\"hostname\"]} — {d[\"status\"]}')"
```

### Clear Rate Limits

Prevent login failures during testing:

```bash
docker exec breeze-redis redis-cli -a "$(grep '^REDIS_PASSWORD=' .env | cut -d= -f2)" --no-auth-warning EVAL "local k=redis.call('KEYS','login:*'); for _,v in ipairs(k) do redis.call('DEL',v) end; return #k" 0
```

## Phase 3: Build & Deploy (Agent Only)

Use `make dev-push` to build and deploy agent code to the test device. The Makefile target at `agent/Makefile:116-144` handles: detect platform, cross-compile, upload binary, trigger restart.

### Deploy

```bash
cd agent
make dev-push
```

Reads defaults from `../.env.dev` (gitignored):
- `BREEZE_DEV_DEVICE` — target device UUID
- `BREEZE_API_KEY` — API key (`brz_...`) or JWT
- `BREEZE_API_URL` — API base URL

Override any default: `make dev-push DEVICE=<id> AUTH_TOKEN=<key> API_URL=<url>`

### Verify Deploy Landed

Poll the device API to confirm the new version is running:

```bash
curl -sf "${E2E_API_URL}/api/v1/devices/${DEVICE_ID}" \
  -H "X-API-Key: ${BREEZE_API_KEY}" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'version={d.get(\"agentVersion\",\"?\")} status={d[\"status\"]}')"
```

The version should show `dev-<unix-timestamp>`. Agent typically restarts within 5-10 seconds.

## Phase 4: UI Verification (Playwright MCP)

Use Playwright MCP tools for browser-based verification. Load tools via `ToolSearch` first.

### Login Pattern

```
1. browser_navigate → ${E2E_BASE_URL}/login
2. browser_snapshot → confirm login form rendered
3. browser_fill_form → email + password fields
4. browser_click → submit button
5. browser_wait_for → URL changes away from /login (timeout 10s)
6. browser_snapshot → confirm dashboard loaded
```

### Navigation URLs

| Page | URL |
|---|---|
| Dashboard | `/` |
| Devices | `/devices` |
| Device Detail | `/devices/{id}` |
| Alerts | `/alerts` |
| Scripts | `/scripts` |
| Automations | `/automations` |
| Reports | `/reports` |
| Settings | `/settings` |
| Monitoring | `/monitoring` |
| Discovery | `/network/discovery` |
| CIS Benchmarks | `/compliance/cis` |
| Policies | `/policies` |

### Verification Steps

1. **Snapshot** — `browser_snapshot` to get accessibility tree, confirm elements render
2. **Interact** — `browser_click`, `browser_fill_form`, `browser_select_option` to exercise the feature
3. **Screenshot** — `browser_take_screenshot` for visual confirmation if snapshot isn't enough
4. **Console check** — `browser_console_messages` to catch JS errors
5. **Network check** — `browser_network_requests` to verify API calls succeed (no 4xx/5xx)

### Astro Hydration Note

Astro React islands hydrate after initial page load. After `browser_navigate`, wait for network idle before interacting with React components. If clicks don't register, the island hasn't hydrated yet — add a short wait or re-snapshot to confirm interactive elements are present.

### Common Selectors

Use `browser_snapshot` output (accessibility tree) to find elements. Common patterns:
- Buttons: look for `button` role with name text
- Links: look for `link` role with name text
- Forms: look for `textbox` role with name matching label
- Tables: look for `table`, `row`, `cell` roles

## Phase 5: API Verification

### Authentication Methods

| Method | Header | When to use |
|---|---|---|
| API Key | `X-API-Key: brz_...` | Automated testing, scripts |
| JWT | `Authorization: Bearer <token>` | After login, browser-initiated |

To get a JWT for API testing:

```bash
curl -sf -X POST "${E2E_API_URL}/api/v1/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"${E2E_ADMIN_EMAIL}\",\"password\":\"${E2E_ADMIN_PASSWORD}\"}" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['tokens']['accessToken'])"
```

### Common Endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/v1/devices` | GET | List devices |
| `/api/v1/devices/:id` | GET | Device detail |
| `/api/v1/devices/:id/diagnostic-logs` | GET | Agent logs |
| `/api/v1/alerts` | GET | List alerts |
| `/api/v1/scripts` | GET | List scripts |
| `/api/v1/automations` | GET | List automations |
| `/api/v1/auth/login` | POST | Login |
| `/api/v1/auth/refresh` | POST | Refresh token |
| `/api/v1/dev/push` | POST | Dev push binary |

### Verification Pattern

```bash
# Example: verify a new endpoint returns expected data
TOKEN=$(curl -sf -X POST "${E2E_API_URL}/api/v1/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"${E2E_ADMIN_EMAIL}\",\"password\":\"${E2E_ADMIN_PASSWORD}\"}" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['tokens']['accessToken'])")

curl -sf "${E2E_API_URL}/api/v1/<endpoint>" \
  -H "Authorization: Bearer ${TOKEN}" | python3 -m json.tool
```

Check for:
- Correct HTTP status code
- Expected response shape (fields present, correct types)
- No error messages in response body
- Correct data values

## Phase 6: Agent Log Verification (Agent Only)

### Diagnostic Logs API

`GET /api/v1/devices/:deviceId/diagnostic-logs`

Query parameters:

| Param | Type | Description |
|---|---|---|
| `level` | string | Comma-separated: `debug`, `info`, `warn`, `error` |
| `component` | string | Filter by component: `heartbeat`, `websocket`, `updater`, `main`, etc. |
| `since` | ISO string | Start of time range |
| `until` | ISO string | End of time range |
| `search` | string | Text search in message + fields |
| `page` | number | Page number (default 1) |
| `limit` | number | Results per page (default/max 1000) |

Example:

```bash
curl -sf "${E2E_API_URL}/api/v1/devices/${DEVICE_ID}/diagnostic-logs?level=error,warn&since=$(date -u -v-5M +%Y-%m-%dT%H:%M:%SZ)" \
  -H "Authorization: Bearer ${TOKEN}" | python3 -m json.tool
```

### Direct SQL Fallback

If the API is unreachable or for richer queries:

```bash
docker exec breeze-postgres-dev psql -U breeze -d breeze -c "
  SELECT timestamp, level, component, message, agent_version
  FROM agent_logs
  WHERE device_id = '${DEVICE_ID}'
    AND timestamp > now() - interval '5 minutes'
  ORDER BY timestamp DESC LIMIT 30;"
```

### What to Look For

- **No new errors/warnings** after deploy — the feature shouldn't introduce regressions
- **Expected log messages** — if the feature includes logging, confirm those messages appear
- **Correct agent_version** — should show `dev-<timestamp>` matching the deploy
- **Component tagging** — logs should use the correct component name

### Enable Debug Shipping

Default shipping level is `warn`. To get full detail during testing:

```json
{
  "type": "set_log_level",
  "payload": { "level": "debug", "durationMinutes": 30 }
}
```

Send via device commands endpoint or WebSocket. Auto-reverts after duration.

## Phase 7: Record Results

Log test results in `docs/testing/FEATURE_TEST_LOG.md` for traceability.

### Entry Format

```markdown
## [Feature Name] — YYYY-MM-DD

**Branch:** `branch-name`
**Commit:** `abc1234`
**Tested by:** Claude / Human
**Result:** PASS / PARTIAL / FAIL

### What was tested
- [ ] UI: description of UI verification
- [ ] API: description of API verification
- [ ] Agent: description of agent verification

### Evidence
- Screenshot: (path or description)
- API response: (summary)
- Agent logs: (relevant excerpt)

### Issues Found
- (none, or describe issues)

### Notes
- (any additional context)
```

### TaskCreate Checklist

After recording results, create tasks for any follow-up:
- Failing tests that need investigation
- Edge cases discovered during verification
- Performance concerns observed
- Documentation gaps

## Quick Reference

### Playwright MCP Cheat Sheet

Load tools first: `ToolSearch("playwright")`

| Action | Tool |
|---|---|
| Open URL | `browser_navigate` |
| Get page structure | `browser_snapshot` |
| Click element | `browser_click` |
| Fill form fields | `browser_fill_form` |
| Take screenshot | `browser_take_screenshot` |
| Check JS errors | `browser_console_messages` |
| Check network | `browser_network_requests` |
| Press key | `browser_press_key` |
| Wait for element | `browser_wait_for` |
| Select dropdown | `browser_select_option` |

### Dev-Push Commands

```bash
cd agent && make dev-push                    # Use .env.dev defaults
cd agent && make dev-push DEVICE=<uuid>      # Override device
cd agent && make dev-push API_URL=<url>      # Override API URL
```

### Rate Limit Clear

```bash
docker exec breeze-redis redis-cli -a "$(grep '^REDIS_PASSWORD=' .env | cut -d= -f2)" --no-auth-warning EVAL "local k=redis.call('KEYS','login:*'); for _,v in ipairs(k) do redis.call('DEL',v) end; return #k" 0
```
