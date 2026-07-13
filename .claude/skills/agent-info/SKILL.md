---
name: agent-info
description: Quick reference for the Breeze RMM Go agent architecture, commands, configuration, build process, and data flows. Use when working on agent code, debugging agent issues, or understanding how the agent communicates with the API.
---

# Breeze RMM Agent Reference

The Go agent runs on managed devices (Windows, macOS, Linux) and communicates with the Hono API server.

## Architecture Overview

```
agent/
  cmd/breeze-agent/main.go    # Entry point (cobra CLI)
  agent.yaml                   # Config file (auto-generated on enroll)
  internal/
    config/config.go           # Config loading/saving (viper)
    heartbeat/heartbeat.go     # Main run loop, command dispatch, inventory
    websocket/client.go        # Real-time WebSocket connection
    collectors/                # System data collectors (per-platform)
    remote/
      tools/                   # Command handlers (processes, services, files, etc.)
      desktop/                 # WebRTC remote desktop
    terminal/                  # PTY management (per-platform)
    updater/                   # Self-update mechanism
    scripts/                   # Script execution runner
  pkg/api/client.go            # HTTP client for enrollment
```

## CLI Commands

```bash
breeze-agent run                        # Start the agent
breeze-agent enroll <key> --server URL  # Enroll with server
breeze-agent version                    # Print version
breeze-agent status                     # Check enrollment status
breeze-agent --config /path/to/file     # Use custom config
```

## Config File (`agent.yaml`)

```yaml
agent_id: <sha256-hash>
auth_token: brz_<hex-token>
org_id: <uuid>
site_id: <uuid>
server_url: http://localhost:3001
heartbeat_interval_seconds: 60
metrics_interval_seconds: 30
enabled_collectors:
  - hardware
  - software
  - metrics
  - network
```

- **Location**: `/etc/breeze/agent.yaml` (Linux), `/Library/Application Support/Breeze/agent.yaml` (macOS), `%ProgramData%\Breeze\agent.yaml` (Windows)
- **Permissions**: Directory 0700, file 0600 (contains auth token)
- **Auth token**: `brz_` prefix, stored as SHA-256 hash in DB (`agentTokenHash` column)

## Communication Channels

### 1. Heartbeat (HTTP Polling)
- `POST /api/v1/agents/:id/heartbeat` every 60s
- Sends: CPU, RAM, disk metrics + status + agent version
- Receives: pending commands, config updates, upgrade instructions
- Auth: `Authorization: Bearer brz_<token>`

### 2. WebSocket (Real-time)
- `ws(s)://server/api/v1/agent-ws/:agentId/ws?token=brz_<token>`
- Receives commands instantly (no polling delay)
- Sends command results + terminal output
- Auto-reconnect with exponential backoff (1s initial, 60s max, 0.3 jitter)
- Ping/pong keepalive: ping every 54s, pong timeout 60s
- Max message size: 512KB

### 3. Inventory (HTTP Push)
- Sent on startup + every 15 minutes
- `PUT /api/v1/agents/:id/software` - software inventory
- `PUT /api/v1/agents/:id/disks` - disk inventory
- `PUT /api/v1/agents/:id/network` - network adapters
- `PUT /api/v1/agents/:id/connections` - active connections
- `PUT /api/v1/agents/:id/patches` - pending + installed patches
- `PUT /api/v1/agents/:id/eventlogs` - event logs (every 5 min)

## Command Types

All commands use: `{id: string, type: string, payload: map[string]any}`
Results use: `{type: "command_result", commandId: string, status: string, result: any}`

### Process Management
| Type | Handler | Payload |
|------|---------|---------|
| `list_processes` | `ListProcesses` | `{search, sortBy, sortDir, page, limit}` |
| `get_process` | `GetProcess` | `{pid}` |
| `kill_process` | `KillProcess` | `{pid}` |

### Service Management
| Type | Handler | Payload |
|------|---------|---------|
| `list_services` | `ListServices` | `{search, page, limit}` |
| `get_service` | `GetService` | `{name}` |
| `start_service` | `StartService` | `{name}` |
| `stop_service` | `StopService` | `{name}` |
| `restart_service` | `RestartService` | `{name}` |

### File Operations
| Type | Handler | Payload |
|------|---------|---------|
| `file_list` | `ListFiles` | `{path}` |
| `file_read` | `ReadFile` | `{path}` (max 1MB) |
| `file_write` | `WriteFile` | `{path, content, encoding}` (text or base64) |
| `file_delete` | `DeleteFile` | `{path, recursive}` |
| `file_mkdir` | `MakeDirectory` | `{path}` |
| `file_rename` | `RenameFile` | `{oldPath, newPath}` |

### Terminal (PTY)
| Type | Handler | Payload |
|------|---------|---------|
| `terminal_start` | `StartTerminal` | `{sessionId, cols, rows}` |
| `terminal_data` | `WriteTerminal` | `{sessionId, data}` |
| `terminal_resize` | `ResizeTerminal` | `{sessionId, cols, rows}` |
| `terminal_stop` | `StopTerminal` | `{sessionId}` |

Terminal output streams via WebSocket: `{type: "terminal_output", sessionId, data}`
Terminal commands use `term-` prefix IDs and skip DB persistence.

### Windows-Specific
| Type | Handler | Payload |
|------|---------|---------|
| `event_logs_list` | `ListEventLogs` | `{}` |
| `event_logs_query` | `QueryEventLogs` | `{logName, level, source, page, limit}` |
| `event_log_get` | `GetEventLogEntry` | `{logName, recordId}` |
| `tasks_list` | `ListTasks` | `{folder, page, limit}` |
| `task_get` | `GetTask` | `{name, path}` |
| `task_run` | `RunTask` | `{name, path}` |
| `task_enable` | `EnableTask` | `{name, path}` |
| `task_disable` | `DisableTask` | `{name, path}` |
| `registry_keys` | `ListRegistryKeys` | `{hive, path}` |
| `registry_values` | `ListRegistryValues` | `{hive, path}` |
| `registry_get` | `GetRegistryValue` | `{hive, path, name}` |
| `registry_set` | `SetRegistryValue` | `{hive, path, name, type, data}` |
| `registry_delete` | `DeleteRegistryValue` | `{hive, path, name}` |

### System Commands
| Type | Handler | Payload |
|------|---------|---------|
| `reboot` | `Reboot` | `{delay}` |
| `shutdown` | `Shutdown` | `{delay}` |
| `lock` | `Lock` | `{}` |
| `collect_software` | inline | `{}` |
| `start_desktop` | `desktop.SessionManager` | `{sessionId, offer}` |
| `stop_desktop` | `desktop.SessionManager` | `{sessionId}` |

## Enrollment Flow

1. User runs: `breeze-agent enroll <key> --server <url>`
2. Agent collects hardware info via `collectors.HardwareCollector`
3. `POST /api/v1/agents/enroll` with enrollment key + device info
4. Server returns: `{agentId, authToken, orgId, siteId, config}`
5. Agent saves config to `agent.yaml` with 0600 permissions
6. Auth token stored as SHA-256 hash in `devices.agentTokenHash`

## Command Execution Flow

```
API creates command (DB) → dispatches via WebSocket (or heartbeat response)
  → Agent receives {id, type, payload}
  → heartbeat.executeCommand() dispatches to handler
  → Handler returns tools.CommandResult {status, stdout, stderr, error}
  → Result sent via WebSocket AND HTTP POST to /agents/:id/commands/:cmdId/result
```

## Build & Development

```bash
cd agent
make run              # Build and run locally
make build-all        # Cross-compile (windows/linux/darwin, amd64/arm64)
go build -o /tmp/breeze-agent-bin ./cmd/breeze-agent/  # Quick build
/tmp/breeze-agent-bin run  # Run built binary (needs 'run' subcommand!)
```

## Key Dependencies

- `github.com/gorilla/websocket` - WebSocket client
- `github.com/spf13/cobra` - CLI framework
- `github.com/spf13/viper` - Configuration management
- `github.com/shirou/gopsutil` - System metrics collection
- `github.com/pion/webrtc` - Remote desktop (WebRTC)

## Platform-Specific Files

Many packages have platform-specific implementations:
- `*_darwin.go` - macOS
- `*_linux.go` - Linux
- `*_windows.go` - Windows
- `*_other.go` - Stub for unsupported platforms

Notable: Terminal PTY uses cgo on macOS (`pty_darwin.go`) for `posix_openpt/grantpt/unlockpt/ptsname`.

## Dev Push (Fast Binary Update)

Bypasses the full release cycle for rapid agent iteration: build → upload → restart in seconds.

### Flow

```
make dev-push    (reads .env.dev for defaults)
  1. Cross-compile binary (queries device OS/arch from API)
  2. Upload binary via POST /api/v1/dev/push (multipart, JWT or API key auth)
  3. API saves to temp dir, computes SHA256, creates ephemeral download URL (5-min TTL)
  4. API sends `dev_update` command to agent via WebSocket
  5. Agent disables auto_update (persisted to config), downloads binary, verifies checksum
  6. Agent backs up current binary, replaces, restarts
```

### Authentication

Dev-push accepts **two** auth methods (JWT or API key). **Prefer the API key** — it doesn't expire hourly.

**Option 1: API key (recommended)** — Set in `.env.dev`:
```bash
# .env.dev (gitignored, at repo root)
BREEZE_API_KEY=brz_XXXX          # from web UI → Settings → API Keys
BREEZE_DEV_DEVICE=<device-uuid>
BREEZE_API_URL=http://localhost:3001
```
Then just `cd agent && make dev-push` — no extra args needed.

The `dev-push` route sends `X-API-Key` header when the token starts with `brz_`, `Authorization: Bearer` otherwise.

**Option 2: JWT** — For endpoints that don't accept API keys (e.g. `/devices/:id/diagnostic-logs`):
```bash
# Generate a 1-hour JWT token:
./agent/scripts/gen-jwt.sh                    # uses first user in DB
./agent/scripts/gen-jwt.sh todd@olivetech.co  # specific user

# Use it:
export TOKEN=$(./agent/scripts/gen-jwt.sh)
curl -H "Authorization: Bearer $TOKEN" http://localhost:3001/api/v1/devices/<id>/diagnostic-logs
```

**JWT requirements** (if generating manually):
- Library: `jose` (NOT `jsonwebtoken`)
- Algorithm: `HS256`
- Secret: `JWT_SECRET` from `.env` (at repo root)
- Required claims: `iss: "breeze"`, `aud: "breeze-api"`
- Required fields: `sub` (real user UUID from `users` table), `email`, `scope: "system"`, `type: "access"`
- User lookup: `docker exec breeze-postgres-dev psql -U breeze -d breeze -t -c "SELECT id, email FROM users LIMIT 3;"`

### Usage

```bash
# Easiest — uses .env.dev defaults (API key + device ID):
cd agent && make dev-push

# Override device or token:
make dev-push DEVICE=<deviceId>
make dev-push AUTH_TOKEN=<jwt-or-api-key>

# Manual — build + push separately:
cd agent
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -ldflags "-X main.version=dev-$(date +%s)" \
  -o bin/breeze-agent-dev ./cmd/breeze-agent
curl -X POST http://localhost:3001/api/v1/dev/push \
  -H "X-API-Key: brz_XXXX" \
  -F "agentId=DEVICE_ID" \
  -F "binary=@bin/breeze-agent-dev"
```

### Command Reference

| Type | Payload | Notes |
|------|---------|-------|
| `dev_update` | `{downloadUrl, checksum, version}` | Disables `auto_update`, triggers `UpdateFromURL` |

### Key Files

| File | Purpose |
|------|---------|
| `apps/api/src/routes/devPush.ts` | Upload endpoint + ephemeral download route |
| `agent/internal/heartbeat/handlers_devupdate.go` | `handleDevUpdate` — disables auto-update, triggers updater |
| `agent/internal/updater/updater.go` → `UpdateFromURL()` | Direct URL download (skips version-lookup API) |
| `agent/internal/config/config.go` → `SaveTo()` | Persists `auto_update` flag across restarts |

### Guard Rails

- **Production disabled**: only works when `NODE_ENV !== 'production'` or `DEV_PUSH_ENABLED=true`
- **Auto-update disabled**: `dev_update` sets `auto_update: false` in config to prevent heartbeat from overwriting the dev binary
- **Re-enable**: set `auto_update: true` in agent.yaml or re-enroll the device
- **Ephemeral**: download tokens expire after 5 minutes and files auto-cleanup

### Dev Iteration Loop

The intended workflow for debugging/developing agent code: **fetch logs → fix code → build & push → check logs**.

```
┌─────────────────────────────────────────────────────────┐
│  1. FETCH LOGS — see what's happening on the agent      │
│                                                         │
│  # Get recent agent logs (shipped from agent → DB)      │
│  GET /api/v1/devices/:id/diagnostic-logs                │
│    ?level=warn,error                                    │
│    ?component=updater                                   │
│    ?search=keyword                                      │
│    ?since=2026-02-15T00:00:00Z                          │
│                                                         │
│  # Or bump log level for more detail (auto-reverts)     │
│  Send `set_log_level` command:                          │
│    {level: "debug", durationMinutes: 30}                │
│                                                         │
│  # Direct DB query for fastest access:                  │
│  psql: SELECT * FROM agent_logs                         │
│    WHERE device_id = '<id>'                             │
│    ORDER BY timestamp DESC LIMIT 50;                    │
├─────────────────────────────────────────────────────────┤
│  2. FIX CODE — edit Go source in agent/internal/...     │
├─────────────────────────────────────────────────────────┤
│  3. BUILD & DEPLOY — push new binary to live agent      │
│                                                         │
│  cd agent && make dev-push                              │
│  # reads .env.dev for API key + device ID               │
│                                                         │
│  Agent restarts with new binary in ~5 seconds.          │
├─────────────────────────────────────────────────────────┤
│  4. CHECK LOGS — verify the fix                         │
│                                                         │
│  GET /api/v1/devices/:id/diagnostic-logs                │
│    ?since=<deploy-time>                                 │
│                                                         │
│  Look for:                                              │
│    - New agent version in logs (dev-<timestamp>)        │
│    - Error/warn messages resolved                       │
│    - Expected behavior in component logs                │
│                                                         │
│  If not fixed → loop back to step 1                     │
└─────────────────────────────────────────────────────────┘
```

**API endpoints used in the loop:**

| Step | Endpoint | Auth | Purpose |
|------|----------|------|---------|
| Fetch logs | `GET /api/v1/devices/:id/diagnostic-logs` | JWT (`gen-jwt.sh`) | Query shipped agent logs with filters |
| Bump log level | `set_log_level` command via WS | Agent | Temporarily increase verbosity |
| Build & push | `make dev-push` | API key (`.env.dev`) | Upload new binary, trigger agent restart |
| Check logs | `GET /api/v1/devices/:id/diagnostic-logs?since=...` | JWT (`gen-jwt.sh`) | Verify fix after deploy |

**Log shipping pipeline:** Agent `logging` package → buffer → `POST /api/v1/agents/:id/logs` → `agent_logs` table → queryable via `/devices/:id/diagnostic-logs`

**Filters:** `?level=`, `?component=`, `?search=`, `?since=`, `?until=`, `?page=`, `?limit=` (max 1000)

## Agent Version Management & Upgrades

### Release Pipeline

```
Tag commit (v*) → GitHub Actions builds all platforms → Assets uploaded to GitHub Releases
  → API syncs versions via POST /api/v1/agent-versions/sync-github
  → Registered in `agent_versions` table with download URLs + SHA256 checksums
  → Agents auto-upgrade via heartbeat response `upgradeTo` field
```

### Version Registry (Database)

The `agent_versions` table tracks each binary per platform/arch/component.

| Endpoint | Auth | Purpose |
|----------|------|---------|
| `GET /agent-versions/latest?platform=X&arch=Y` | None | Get latest version info + download URL |
| `GET /agent-versions/:version/download?platform=X&arch=Y` | None | Get download URL for specific version |
| `POST /agent-versions` | System | Manually register a version |
| `POST /agent-versions/sync-github?version=vX.Y.Z` | System | Sync from GitHub releases |

### Auto-Upgrade via Heartbeat

On each heartbeat, the API compares the agent's reported version against the latest registered version:
- **Semver builds** (e.g. `0.12.0`): upgraded when a newer version exists (`compareAgentVersions`)
- **Dev builds** (`dev-*`): always offered the latest release version (dev versions can't be semver-compared)
- The heartbeat response includes `upgradeTo: "X.Y.Z"` which the agent acts on

**Key code**: `apps/api/src/routes/agents/heartbeat.ts` lines ~188-198

### Self-Update Mechanism (Agent Side)

1. Agent receives `upgradeTo` in heartbeat response
2. Calls `GET /api/v1/agent-versions/{version}/download?platform=X&arch=Y` to get URL + checksum
3. Downloads binary from URL (GitHub CDN, S3, or local API)
4. Verifies SHA256 checksum
5. Backs up current binary to `.backup`
6. Platform-specific restart:
   - **Windows**: Spawns detached PowerShell script (stop service → copy binary → start service)
   - **Linux**: `systemctl restart breeze-agent`
   - **macOS**: `launchctl kickstart -k system/com.breeze.agent`
   - **Fallback**: `syscall.Exec()` to replace process
7. On failure, restores from `.backup`

**Key files**: `agent/internal/updater/updater.go`, `agent/internal/heartbeat/heartbeat.go`

### Upgrading from Dev Build to Release

Dev-push sets `auto_update: false` in the agent config to prevent heartbeat from overwriting dev binaries. To return a device to the release track:

**Option 1 — Edit agent config** (on the device):
Set `auto_update: true` in `agent.yaml`, then restart the agent. The next heartbeat will trigger upgrade to latest release.

**Option 2 — Re-enroll** the device (clean slate).

**Note**: The `compareAgentVersions` function returns `0` for dev versions (can't parse `dev-*` as semver), so the heartbeat has special handling: if `agentVersion.startsWith('dev-')`, it always sets `upgradeTo` to the latest release regardless of comparison.

### Binary Serving Modes

Controlled by `BINARY_SOURCE` env var:

| Mode | Behavior |
|------|----------|
| `github` (default) | Redirects agent to GitHub Releases CDN |
| `local` + S3 | Generates presigned S3 URLs |
| `local` (disk) | Serves from `./agent/bin/` (or `AGENT_BINARY_DIR`) |

### Install Scripts

| Platform | Script | Binary Location | Service |
|----------|--------|-----------------|---------|
| Linux | `agent/scripts/install/install-linux.sh` | `/usr/local/bin/breeze-agent` | systemd (`breeze-agent.service`) |
| macOS | `agent/scripts/install/install-darwin.sh` | `/usr/local/bin/breeze-agent` | launchd (`com.breeze.agent.plist`) |
| Windows | `agent/scripts/install/install-windows.ps1` | `C:\Program Files\Breeze\breeze-agent.exe` | Windows Service (`BreezeAgent`) |

Dynamic installer endpoint: `GET /api/v1/agents/install.sh` — detects OS/arch, downloads binary, enrolls, installs service.

## Security

- Agent auth: `brz_` token in `Authorization: Bearer` header
- Server validates via SHA-256 hash comparison (same pattern as API keys)
- Rate limited: 120 req/60s per agent via Redis sliding window
- WebSocket token passed as query parameter, validated on connect
- Config file restricted to owner-only (0600)
- Mutating commands are audit-logged with `actorType: 'agent'`
