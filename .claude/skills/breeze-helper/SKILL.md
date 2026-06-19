---
name: breeze-helper
description: Quick reference for the Breeze Helper Tauri desktop app — architecture, Rust backend commands, React frontend, config files, IPC with the Go agent, helper chat API routes, tool approval flow, and tray integration. Use when working on helper code, debugging helper issues, adding helper features, or understanding how the Helper communicates with the API and agent.
---

# Breeze Helper Reference

Lightweight Tauri v2 desktop app providing an AI chat assistant, device info, and tool approval interface. Runs in the system tray, spawned by the Go agent on Windows as a SYSTEM process in the user's session.

## Architecture Overview

```
apps/helper/
  src/
    App.tsx                    # Main UI (chat, device info, history, approval popup)
    main.tsx                   # React entry point
    stores/chatStore.ts        # Zustand state (auth, messages, SSE streaming, approvals)
    styles.css                 # Dark-theme styling
  src-tauri/
    src/lib.rs                 # Rust backend (~776 lines): config, HTTP client, tray, streaming
    tauri.conf.json            # App config (380×600 frameless, tray icon, CSP)
    Cargo.toml                 # Rust deps (tauri v2, reqwest, tokio, serde_yaml)
    build.rs                   # Tauri build script
  vite.config.ts               # Frontend build
  package.json                 # React + Zustand + react-markdown
```

## Tauri Commands (Rust → Frontend)

Registered in `lib.rs` via `generate_handler![]`:

| Command | Returns | Purpose |
|---------|---------|---------|
| `read_agent_config` | `AgentConfig` | Load agent.yaml + secrets.yaml, init HTTP client |
| `helper_fetch` | `HelperFetchResponse` | Authenticated HTTP proxy with mTLS + SSRF protection |
| `hide_window` | — | Hide window to tray |
| `minimize_window` | — | Minimize window |
| `get_os_username` | `String` | OS username (falls back to `USERNAME` env for SYSTEM context) |
| `get_helper_config` | `HelperConfig` | Load helper_config.yaml (tray menu toggles) |
| `update_chat_active` | — | Write helper_status.yaml (agent reads for idle detection) |

### `helper_fetch` — Key Design

The central HTTP proxy command. All frontend API calls go through this.

- **SSRF protection**: Validates request URL starts with configured `api_url`
- **Auth injection**: Always sets `Authorization: Bearer <token>`, prevents frontend override
- **mTLS**: Builds `reqwest::Client` with `Identity::from_pem` if cert+key present in secrets.yaml
- **Streaming**: When `stream: true`, spawns tokio task that emits `helper-fetch-stream` Tauri events as `StreamChunkEvent { stream_id, chunk, done, error }`
- **Non-stream**: Returns full body inline in `HelperFetchResponse`

## Config Files

All in the agent config directory (same as `agent.yaml`):

| File | Writer | Reader | Purpose |
|------|--------|--------|---------|
| `agent.yaml` | Go agent | Helper | `server_url`, `agent_id` |
| `secrets.yaml` | Go agent | Helper | `auth_token`, `mtls_cert_pem`, `mtls_key_pem` (0640) |
| `helper_config.yaml` | Go agent | Helper | Tray menu toggles, portal URL, device name/status |
| `helper_status.yaml` | Helper | Go agent | `version`, `chat_active`, `last_activity`, `pid` |

### Config Paths

| Platform | Path |
|----------|------|
| macOS | `/Library/Application Support/Breeze/` |
| Windows | `%ProgramData%\Breeze\` |
| Linux | `/etc/breeze/` |

### HelperConfig Fields

```yaml
show_open_portal: true       # Show "Open Breeze Portal" in tray menu
show_device_info: true       # Show "Device Info" in tray menu
show_request_support: true   # Show "Request Support" in tray menu
portal_url: ""               # URL for portal (falls back to api_url)
device_name: ""              # Display name
device_status: ""            # Current status
last_checkin: ""             # Last check-in timestamp
```

Config reloads every 60s; tray menu rebuilds on change.

## Frontend (React + Zustand)

### Views (in App.tsx)

1. **Connection states** — connecting, error, disconnected (with retry)
2. **UsernamePrompt** — one-time name entry (persists to localStorage, falls back to OS username)
3. **SessionHistory** — list past conversations, load by ID
4. **DeviceInfoView** — hostname, OS, status, agent version (from `GET /devices/by-agent/:agentId`)
5. **Chat** — messages, markdown rendering, tool indicators, thinking dots, approval popup

### Chat Store (chatStore.ts)

State: `connectionState`, `agentConfig`, `sessionId`, `messages`, `isStreaming`, `pendingApproval`, `sessions`, `username`

Key methods:
- `initialize()` — loads agent config via Tauri invoke (or VITE_* env vars for dev)
- `sendMessage(content)` — creates session if needed, POSTs via SSE stream
- `loadSessions()` / `loadSession(id)` — session history
- `approveExecution(executionId, approved)` — tool approval
- `clearMessages()` — closes session, resets state

### HTTP Layer (Tauri vs Dev)

Two helper functions abstract Tauri invoke vs native fetch:

- `helperRequest(config, url, options)` — non-streaming requests
- `helperStreamRequest(config, url, options, onChunk, onDone)` — SSE streaming

In Tauri: calls `helper_fetch` (Rust mTLS client). In browser dev: uses native `fetch()` with `VITE_API_URL` / `VITE_AGENT_TOKEN` / `VITE_AGENT_ID`.

**Stream listener race fix**: Event listener registered BEFORE `helper_fetch` invoke to avoid missing chunks when proxy buffers the full response.

### SSE Event Processing

`processSSELines()` handles: `message_start`, `content_delta`, `tool_use_start`, `tool_result`, `message_end`, `approval_required`, `error`, `done`. Plan events (`plan_approval_required`, etc.) are received but not yet rendered.

## Helper Chat API Routes

`apps/api/src/routes/helper/index.ts` — mounted at `/api/v1/helper/*`

Auth: Agent bearer token (`brz_` prefix) via `helperAuth` middleware (SHA-256 hash lookup against `devices.agentTokenHash`). Creates synthetic `AuthContext` scoped to device's org.

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/chat/sessions` | Create session (optional `helperUser`, `permissionLevel`) |
| POST | `/chat/sessions/:id/messages` | Send message + SSE response stream |
| GET | `/chat/sessions` | List device sessions (filterable by `?helperUser=`) |
| GET | `/chat/sessions/:id/messages` | Load message history |
| DELETE | `/chat/sessions/:id` | Close session |
| POST | `/chat/sessions/:id/approve/:executionId` | Approve/reject tool execution |
| GET | `/config` | Return helper config (permission level, screen capture) |
| POST | `/screenshots` | Upload screenshot (base64, 24h retention) |

### Pre-flight Checks (per message)

1. Session exists and belongs to device
2. Session not expired (24h max age)
3. Turn limit not exceeded
4. Rate limit: 30 msg/60s per device (Redis)
5. Org budget check (fail-closed)
6. Input sanitization

### Permission Levels

| Level | Description |
|-------|-------------|
| `basic` | Read-only tools |
| `standard` | Default — read + some write tools |
| `extended` | All tools including destructive operations |

Configured via `helperToolFilter.ts` → `getHelperAllowedMcpToolNames(level)`.

## Tool Approval Flow

1. AI invokes a restricted tool → `approval_required` SSE event
2. `ToolApprovalPopup` renders with description, device badge, parameters
3. 5-minute auto-deny countdown timer
4. User clicks Allow/Deny → `POST /chat/sessions/:id/approve/:executionId`
5. Hidden input keys filtered from display: `deviceId`, `orgId`, `siteId`, `sessionId`

## Agent IPC Integration

The Go agent spawns Helper in user sessions. Key IPC types from `agent/internal/ipc/message.go`:

| Type | Direction | Purpose |
|------|-----------|---------|
| `auth_request/response` | Helper → Agent | Authentication on connect |
| `capabilities` | Helper → Agent | Report features (notify, tray, capture, clipboard) |
| `desktop_start/stop` | Agent → Helper | WebRTC session lifecycle |
| `desktop_input` | Agent → Helper | Keyboard/mouse relay |
| `clipboard_get/set/data` | Bidirectional | Clipboard sync |
| `sas_request/response` | Helper → Agent | Ctrl+Alt+Del (Windows) |
| `launch_process` | Agent → Helper | Execute as logged-in user |

Helper roles: `system` (SYSTEM token, desktop capture) or `user` (logged-in user, script execution).

### Windows SYSTEM Context

- Agent service (Session 0) spawns Helper via `CreateProcessAsUser` with SYSTEM token + session ID override
- Helper detects SYSTEM context in `lib.rs` setup: checks `LOCALAPPDATA` for "systemprofile"
- Redirects WebView2 data dir to `%ProgramData%\Breeze\helper-webview\` to avoid access issues
- `get_os_username()` falls back to `USERNAME` env var when `whoami` returns "SYSTEM"

## Tray Menu

Built dynamically from `HelperConfig` flags:

| Menu Item | Action |
|-----------|--------|
| Request Support | Show chat window |
| Open Breeze Portal | Open portal URL in browser |
| Device Info | Emit `show-device-info` event, show device info view |
| Exit | `app.exit(0)` |

Left-click on tray icon → show chat window. Right-click → context menu.

## Security

- **SSRF prevention**: `helper_fetch` validates URL starts with configured API URL
- **Auth header protection**: Authorization always set by Rust, frontend can't override
- **mTLS**: Client certificate from secrets.yaml (optional, for Cloudflare mTLS)
- **Token hashing**: Agent token validated via SHA-256 hash comparison
- **Device scoping**: All session queries include `deviceId` filter
- **Input sanitization**: `sanitizeUserMessage()` applied to all chat input
- **Rate limiting**: 30 msg/min per device via Redis sliding window
- **Budget enforcement**: Org budget checked before every message (fail-closed)

## Build & Development

```bash
# Dev mode (Vite hot-reload + Tauri)
cd apps/helper && pnpm tauri dev

# Build distributable
cd apps/helper && pnpm tauri build

# Frontend-only dev (without Tauri, needs VITE_* env vars)
cd apps/helper && pnpm dev
```

**Dev env vars** (for browser-only development without Tauri):
```
VITE_API_URL=http://localhost:3001
VITE_AGENT_TOKEN=brz_<token>
VITE_AGENT_ID=<device-uuid>
```

### Bundle Targets

| Platform | Format |
|----------|--------|
| macOS | DMG (`/Applications/Breeze Helper.app`) |
| Windows | MSI via WiX (`C:\Program Files\Breeze Helper\breeze-helper.exe`) |
| Linux | AppImage (`/usr/local/bin/breeze-helper`) |

## Key Dependencies

**Rust**: tauri v2, reqwest (mTLS), tokio, serde/serde_yaml, chrono, whoami
**TypeScript**: React 18.3, Zustand 4.5, react-markdown 10, @tauri-apps/api 2.0

## Data Flow: Chat Message

```
1. User types in chat input (App.tsx)
2. chatStore.sendMessage(content)
   → Creates session via POST /helper/chat/sessions (if needed)
   → Adds optimistic user message
   → helperStreamRequest() to POST /helper/chat/sessions/:id/messages
3. In Tauri: helper_fetch (Rust) → mTLS HTTP request → SSE response
   → Rust spawns tokio task → emits helper-fetch-stream events
   → Frontend listener → processSSELines() → Zustand state updates
4. API: helperAuth → runHelperPreFlight → streamingSessionManager
   → Claude API call with org-scoped tools
   → SSE events: message_start → content_delta → tool_use_start → tool_result → done
5. Tool approval (if Tier 3): approval_required event → ToolApprovalPopup
   → User Allow/Deny → POST /approve/:executionId → tool executes or rejects
```

## Logging

Helper logs to `helper.log` in the config directory (alongside agent.yaml). In SYSTEM service context, stderr isn't connected to anything visible, so `log_helper_error()` appends timestamped lines to this file.

## Gotchas

- **WebView2 data dir**: On Windows SYSTEM, must redirect to `%ProgramData%\Breeze\helper-webview\` or WebView2 init fails
- **Stream listener race**: Must register Tauri event listener BEFORE invoking `helper_fetch` — reverse proxies (Caddy) can buffer entire SSE response and deliver at once
- **Tray click events**: Only match `Left` + `Up` — matching all click variants steals focus from context menu on Windows
- **409 on concurrent messages**: `streamingSessionManager.tryTransitionToProcessing` prevents parallel processing; frontend removes optimistic message on 409
- **Plan events**: `plan_approval_required`, `plan_step_start`, etc. received but not rendered yet
