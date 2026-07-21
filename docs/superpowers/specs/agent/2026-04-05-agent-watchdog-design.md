# Breeze Agent Watchdog Service — Design Spec

**Date:** 2026-04-05
**Status:** Draft

## Context

The Breeze agent is a single Go binary running as a system service. If it crashes, hangs, or gets corrupted, the only recovery path is the OS service manager's built-in restart (launchd `KeepAlive`, systemd `Restart=on-failure`, Windows SCM recovery). This is insufficient for:

- Deadlocked/hung agents that are still technically alive (service manager won't restart)
- Failed updates that leave a broken binary (service manager restarts the broken binary in a loop)
- Situations requiring diagnostic collection when the agent is unresponsive
- Future tamper protection (binary integrity, config protection)

A lightweight secondary service — the **watchdog** — provides independent monitoring, recovery, and a failover API connection when the primary agent is down.

## Architecture Overview

```
┌──────────────────────────────────────────────────────┐
│                    Breeze API                         │
│  (heartbeat, commands, agent-versions, diagnostics)  │
└──────────┬──────────────────────────────┬────────────┘
           │ normal operation             │ failover only
           │ (agent HTTP/WS)             │ (watchdog HTTP poll)
           ▼                              ▼
┌─────────────────┐   IPC socket   ┌─────────────────┐
│  breeze-agent   │◄──────────────►│ breeze-watchdog  │
│  (primary svc)  │  HMAC-signed   │  (watchdog svc)  │
│                 │  envelopes     │                   │
│ - metrics       │                │ - health checks   │
│ - commands      │                │ - recovery        │
│ - scripts       │                │ - failover API    │
│ - desktop       │                │ - update agent    │
│ - patching      │                │ - diagnostics     │
└─────────────────┘                └───────────────────┘
        │                                   │
        └───── OS Service Manager ──────────┘
              (launchd/systemd/SCM)
              ultimate backstop for both
```

**Key principle:** The watchdog is so simple it essentially can't break. It imports only IPC, config, updater, and HTTP client code from the agent. No metrics, no scripts, no WebSocket, no desktop capture.

## State Machine

```
                    ┌─────────────┐
         startup───►│  CONNECTING  │ (trying to reach agent via IPC)
                    └──────┬──────┘
                           │ IPC handshake succeeds
                           ▼
                    ┌─────────────┐
              ┌────►│  MONITORING  │◄──── agent recovered
              │     └──────┬──┬───┘      (IPC reconnects)
              │            │  │
              │  crash/    │  │ shutdown_intent received
              │  unhealthy │  │ or state file = "stopping"
              │            │  │
              │            ▼  ▼
              │     ┌───────────┐ ┌─────────┐
              │     │ RECOVERING│ │ STANDBY │ (intentional stop, don't recover)
              │     └─────┬─────┘ └────┬────┘
              │        │        │ timeout expires or
              │        │        │ API sends "start_agent" cmd
              │        ▼        ▼
              │     ┌─────────────┐
              └─────│  FAILOVER   │ (own API connection, accepts commands)
                    └─────────────┘
```

### States

- **CONNECTING** — startup state. Attempts IPC connection with backoff. If agent is already running and IPC handshake succeeds, transitions directly to MONITORING (normal boot path). If agent process not found, skips to RECOVERING.
- **MONITORING** — steady state. Runs layered health checks. Logs to local journal. Agent relays commands and token updates via IPC.
- **RECOVERING** — agent unhealthy. Escalating recovery: graceful restart -> force kill + restart -> wait for service manager. Tracks attempts with cooldown.
- **STANDBY** — agent stopped intentionally. No recovery attempts. Transitions to FAILOVER on timeout (stuck update) or API command. Returns to MONITORING if agent reconnects.
- **FAILOVER** — recovery exhausted or STANDBY timeout. Opens HTTP connection to API, ships diagnostic logs, accepts lifecycle commands. Continues agent recovery attempts in background.

### Graceful Shutdown Detection

Two mechanisms (belt and suspenders):

1. **IPC shutdown notice** — agent sends `shutdown_intent` message before stopping, with reason (`"user_stop"`, `"update"`, `"config_reload"`) and expected duration.
2. **State file fallback** — agent writes `agent.state` in config dir. A crash leaves the file as `"running"` (or missing). Watchdog reads this if IPC message was missed.

**State file schema** (`agent.state` — JSON, same config dir as `agent.yaml`):

```json
{
  "status": "running|stopping|stopped",
  "reason": "user_stop|update|config_reload|crash",
  "pid": 12345,
  "version": "0.12.1",
  "last_heartbeat": "2026-04-05T10:30:00Z",
  "timestamp": "2026-04-05T10:30:00Z"
}
```

- Agent writes `"running"` + PID on startup
- Agent writes `"stopping"` + reason before graceful shutdown
- Crash leaves `"running"` with stale PID — watchdog detects PID is dead
- `last_heartbeat` updated after each successful API heartbeat (used by Tier 3 check)

### STANDBY Timeouts

| Reason | Timeout |
|--------|---------|
| `update` | 30 minutes |
| `config_reload` | 5 minutes |
| `user_stop` | Indefinite (requires API command to start) |

## Layered Health Checks

Three tiers, cheapest to most expensive:

### Tier 1 — Process Check (every 5s)

- Check agent PID (from PID file or process table) is alive and not zombie
- Windows: `OpenProcess` + `GetExitCodeProcess`
- macOS/Linux: `kill(pid, 0)` signal check
- **PID gone → immediate RECOVERING**

### Tier 2 — IPC Health Probe (every 30s)

- Send `watchdog_ping` over IPC, expect `watchdog_pong` within 5s
- Pong payload includes `HealthMonitor.Summary()` — subsystem health without duplicating logic
- **3 consecutive failures → RECOVERING**

### Tier 3 — Heartbeat Staleness (every 2 min)

- Agent writes `last_heartbeat` timestamp to state file after each successful API heartbeat
- Stale threshold: >3x heartbeat interval (default 3 min)
- **Stale alone → log warning only** (API might be down)
- **Stale + degraded IPC → RECOVERING**

### Escalation Matrix

| Signal | Response |
|--------|----------|
| PID gone | Immediate → RECOVERING |
| 3 failed IPC pings | Graceful restart → RECOVERING |
| IPC degraded + heartbeat stale | Force restart → RECOVERING |
| Stale heartbeat alone | Log warning, no action |

### Recovery Sequence

1. Graceful restart via service manager (`launchctl kickstart`, `systemctl restart`, SCM stop/start)
2. Wait 15s, check if agent comes back
3. If not: force kill PID + service manager start
4. Wait 15s
5. If not: enter FAILOVER
6. **Cooldown:** max 3 recovery attempts per 10 minutes (prevents restart storms)

## IPC Integration

The watchdog connects as a new IPC client role to the agent's existing socket.

### Authentication

- Connects to agent's IPC socket (same path: `/var/run/breeze/breeze.sock`, named pipe on Windows)
- Sends `AuthRequest` with `HelperRole: "watchdog"`
- Agent validates: binary hash on allowlist, process running as root/SYSTEM
- Agent responds with session key for HMAC signing
- All messages use existing HMAC-SHA256 envelope protocol

### Message Types

**v1 — Implemented:**

| Type | Direction | Purpose |
|------|-----------|---------|
| `watchdog_ping` | Watchdog → Agent | Health probe with health summary request |
| `watchdog_pong` | Agent → Watchdog | Health response + `HealthMonitor.Summary()` |
| `shutdown_intent` | Agent → Watchdog | Intentional stop with reason + expected duration |
| `token_update` | Agent → Watchdog | Relayed auth token after rotation |
| `watchdog_command` | Agent → Watchdog | API-originated command relayed to watchdog |
| `watchdog_command_result` | Watchdog → Agent | Result of relayed command |
| `state_sync` | Agent → Watchdog | Periodic: version, config hash, connection status |

**Tamper protection placeholders (defined, not implemented):**

| Type | Direction | Purpose |
|------|-----------|---------|
| `integrity_check` | Watchdog → Agent | Request binary/config hash verification |
| `integrity_result` | Agent → Watchdog | Hash comparison result |
| `tamper_alert` | Watchdog → API | Alert when integrity check fails (failover) |

## Failover API Connection

When in FAILOVER, the watchdog opens its own HTTP connection to the Breeze API.

### Connection Details

- **HTTP polling only** — no WebSocket (keeps watchdog simple)
- Uses agent's auth token from `secrets.yaml` (or last `token_update` via IPC)
- Adds `X-Breeze-Role: watchdog` header to all requests
- Uses agent's mTLS cert if configured
- Poll interval: 30s

### API Endpoints Used

| Endpoint | Purpose |
|----------|---------|
| `POST /api/v1/agents/{id}/heartbeat` | Watchdog heartbeat (role: watchdog, agent status, recovery log) |
| `GET /api/v1/agents/{id}/commands?role=watchdog` | Poll for watchdog-targeted commands |
| `POST /api/v1/agents/{id}/commands/{cmdId}/result` | Submit command results |
| `POST /api/v1/agents/{id}/logs` | Ship watchdog + agent diagnostic logs |
| `GET /api/v1/agent-versions/{version}/download` | Download binaries for updates |

### Accepted Commands (Failover Mode)

| Command | Action |
|---------|--------|
| `restart_agent` | Re-attempt recovery sequence |
| `update_agent` | Download new agent binary, replace, start |
| `update_watchdog` | Self-update: download, backup, replace, restart via service manager |
| `collect_diagnostics` | Gather agent logs, config (redacted), system info, health journal → upload |
| `start_agent` | Start agent service (from STANDBY) |

### Token Staleness in Failover

If the agent is down and the API rotates the device token, the watchdog's cached token becomes invalid. Mitigation:

- API-side: when a watchdog heartbeat arrives with a stale token, the API recognizes the `X-Breeze-Role: watchdog` header and issues a one-time token refresh in the heartbeat response (same pattern as the agent's `RotateToken` response field)
- Watchdog persists the new token to `secrets.yaml` so the agent picks it up on restart

### Failover Exit

- Continues IPC reconnection attempts in background
- When IPC reconnects → transition to MONITORING, close HTTP polling
- Sends final heartbeat: `role: "watchdog", status: "returning_to_monitoring"`

## Binary Structure & Code Reuse

### Reused from agent (`agent/internal/`)

| Package | Purpose |
|---------|---------|
| `ipc/` | Protocol, envelope, HMAC signing |
| `config/` | Config loading, paths, platform detection |
| `updater/` | Download, checksum, backup/replace |
| `mtls/` | mTLS cert loading |

### New watchdog code

| File | Purpose |
|------|---------|
| `cmd/breeze-watchdog/main.go` | CLI: `run`, `status`, `health-journal`, `trigger-failover`, `trigger-recovery`, `service install/uninstall` |
| `internal/watchdog/watchdog.go` | State machine, health check orchestrator |
| `internal/watchdog/checks.go` | Tier 1/2/3 health check implementations |
| `internal/watchdog/failover.go` | HTTP API client, command handler |
| `internal/watchdog/journal.go` | Rolling health journal (file-based, capped size) |
| `internal/watchdog/state.go` | State file reader/writer |
| Platform service files | Thin — plist/unit/SCM templates |

### Not imported by watchdog

Metrics collectors, script executor, WebSocket client, session broker, desktop capture, heartbeat loop, command handler registry.

### Estimated binary size

~5-8 MB (vs ~30+ MB for full agent). Mostly Go runtime + IPC + HTTP + TLS.

## Build & Makefile

### New targets

```makefile
build-watchdog:              # Current platform
build-watchdog-linux:        # linux/amd64, linux/arm64
build-watchdog-darwin:       # darwin/amd64, darwin/arm64
build-watchdog-windows:      # windows/amd64
dev-push-watchdog:           # Build + upload + trigger update
dev-push-both:               # Agent + watchdog together
```

### Build output

```
bin/breeze-watchdog                    # Current platform
bin/breeze-watchdog-{os}-{arch}        # Platform-specific
bin/breeze-watchdog-windows-amd64.exe
```

## Installation

### Shared installer — watchdog ships alongside agent

**macOS `.pkg`:**
- Package includes both `breeze-agent` and `breeze-watchdog` binaries
- Postinstall installs both LaunchDaemon plists and loads both
- Preinstall stops both services before upgrade
- Code signing covers both binaries (preserves TCC permissions)
- `.pkg` update atomically replaces both binaries

**Windows MSI:**
- `breeze.wxs` gains `BreezeWatchdog` component
- Both services registered during install, watchdog starts after agent
- Uninstall removes both

**Linux install script:**
- Copies both binaries to `/usr/local/bin/`
- Installs both systemd units
- `breeze-watchdog.service` has `After=breeze-agent.service` (ordering only)
- Explicitly no `Requires=` or `BindsTo=` — watchdog must outlive agent

### OS Service Registration

| Platform | Service Name | Key Config |
|----------|-------------|------------|
| macOS | `com.breeze.watchdog` | LaunchDaemon, `KeepAlive=true`, `ThrottleInterval=5` |
| Linux | `breeze-watchdog.service` | systemd, `Restart=always`, `RestartSec=5`, `StartLimitBurst=10` |
| Windows | `BreezeWatchdog` | SCM, auto-start, recovery: restart on failure |

Note: `Restart=always` (not `on-failure`) and higher `StartLimitBurst` — the watchdog is the last line of defense.

### Enrollment

- Watchdog does not need its own enrollment
- Installer starts agent first, agent enrolls, then watchdog starts and connects via IPC
- Watchdog inherits device identity from shared config

### Mutual Independence

- Agent without watchdog: works exactly as today
- Watchdog without agent: goes straight to RECOVERING → FAILOVER
- Neither requires the other to start

## Cross-Update Paths

| Scenario | Mechanism |
|----------|-----------|
| Normal agent update (macOS) | `.pkg` replaces both binaries atomically |
| Normal agent update (Windows) | MSI replaces both binaries |
| Normal agent update (Linux) | Agent updates self, then updates watchdog binary separately |
| Agent updates watchdog only | Binary replacement + service restart (all platforms) |
| Watchdog self-update (failover) | Binary replacement + service restart (all platforms) |

## Shared Config

Watchdog reads the agent's `agent.yaml` and `secrets.yaml` — no separate config file.

New section in `agent.yaml`:

```yaml
watchdog:
  enabled: true
  process_check_interval: 5s
  ipc_probe_interval: 30s
  heartbeat_stale_threshold: 3m
  max_recovery_attempts: 3
  recovery_cooldown: 10m
  standby_timeout: 30m
  failover_poll_interval: 30s
  health_journal_max_size_mb: 10
  health_journal_max_files: 3
```

## API-Side Changes

### Schema additions (`apps/api/src/db/schema/devices.ts`)

```sql
watchdog_status      enum('connected', 'failover', 'offline')  nullable
watchdog_last_seen   timestamp  nullable
watchdog_version     text  nullable
```

No separate table — watchdog is an attribute of the device.

### Heartbeat handler

- Check for `role: "watchdog"` in payload
- Update `watchdog_status`, `watchdog_last_seen`, `watchdog_version` only
- Don't overwrite agent metrics/health columns
- Return watchdog-targeted commands only

### Command routing

- New `target_role` column on `device_commands`: `'agent'` (default) or `'watchdog'`
- Watchdog polls filter by `target_role = 'watchdog'`
- Existing agent commands unaffected

### Agent version endpoint

- `POST /api/v1/agent-versions` accepts `asset_type: 'agent' | 'watchdog' | 'helper'`
- `GET /api/v1/agent-versions/{version}/download` accepts `?type=watchdog`
- Reuses existing upload/checksum infrastructure

### Dashboard (minimal v1)

- Device detail: watchdog status badge (connected / failover / offline / not installed)
- Device list: optional watchdog status column
- Alert: watchdog enters FAILOVER → device alert created

### New route

- `GET /api/v1/devices/{id}/watchdog-logs` — same pattern as `/diagnostic-logs`

## Dev Workflow

### `make dev-push-watchdog`

Mirrors existing agent dev-push: build with dev version stamp, upload to API, trigger update.

### `make dev-push-both`

Push agent + watchdog in one command for testing cross-update.

### Local dev mode (`breeze-watchdog run --dev`)

- Shorter intervals: 2s / 10s / 30s (instead of 5s / 30s / 2min)
- Verbose console logging (stdout, no file)
- Skips binary hash validation on IPC auth (rebuild without updating allowlists)
- `--agent-pid` flag to monitor a specific process (agent running in terminal)

### CLI diagnostic commands

- `breeze-watchdog status` — current state, last check results, IPC status, agent PID
- `breeze-watchdog health-journal` — dump last N health check entries
- `breeze-watchdog trigger-failover` — force FAILOVER for testing
- `breeze-watchdog trigger-recovery` — force recovery attempt

## Logging

### Normal operation (MONITORING)

- Local health journal: rolling file in agent log directory (`watchdog-journal.log`)
- Logs every health check result, state transitions, actions taken
- Capped: `health_journal_max_size_mb` (default 10MB), `health_journal_max_files` (default 3)

### Failover mode

- Ships logs to API via `POST /agents/{id}/logs` (same endpoint as agent log shipping)
- Includes watchdog health journal + agent log tail (last crash context)

### Dev mode

- All output to stdout, verbose level
- No file logging

## Tamper Protection (Future — v2+)

Interfaces defined in v1 but not implemented:

- **Binary integrity:** watchdog checksums agent binary on each Tier 2 health check, compares to known-good hash from last update
- **Service registration:** watchdog monitors launchd plist / systemd unit / Windows service registration for unauthorized changes
- **Config protection:** watchdog monitors `agent.yaml` and `secrets.yaml` for unauthorized modifications
- **Alert path:** `tamper_alert` IPC message type → API alert → dashboard notification

## Verification Plan

### Unit tests
- State machine transitions (all edges)
- Health check logic (each tier independently)
- Recovery sequence with mocked service manager
- Failover HTTP client with mocked API
- State file read/write
- IPC message serialization

### Integration tests
- Watchdog + agent IPC handshake (role: watchdog)
- Graceful shutdown detection (IPC + state file)
- Token rotation relay
- Cross-update flow

### Manual E2E testing
- Kill agent process → watchdog detects → restarts → MONITORING
- Hang agent (block main goroutine) → IPC timeout → watchdog restarts
- `breeze-agent service stop` → shutdown_intent → STANDBY → no recovery
- STANDBY timeout → FAILOVER → API command → start agent
- `dev-push-watchdog` → agent updates watchdog binary
- `dev-push-both` → both binaries updated
- Watchdog self-update in failover mode
