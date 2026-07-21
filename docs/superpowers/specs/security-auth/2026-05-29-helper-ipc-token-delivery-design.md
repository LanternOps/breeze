# Helper IPC Token Delivery — Design

**Date:** 2026-05-29
**Status:** Design — pending implementation plan
**Author:** Todd Hebebrand (with Claude)
**Related:** Security review finding HIGH-1 (helper token in world-readable `agent.yaml`)

## Problem

The Breeze Assist Helper (Tauri desktop app, `apps/helper/`) authenticates to the
`/helper/*` API routes with a per-device `helper_auth_token`. Today the Go agent
persists that token into `agent.yaml`, and the Helper reads it directly off disk
(`apps/helper/src-tauri/src/lib.rs:79-130`).

Commit `9968f3f4` (branch `fix/helper-config-readable-perms`) widened `agent.yaml`
from `0640` to `0644` so the Helper — which runs as the **logged-in user**, not
root/SYSTEM — can read it. The side effect: `helper_auth_token` is now readable by
**every local user**, not just the agent's group.

The token is not low-value. Server-side (`apps/api/src/routes/helper/index.ts:64-174`)
it mints an auth context scoped to the **device's entire organization** and can drive
the Helper AI tools (`query_devices`, `query_audit_log`, `manage_services`,
`file_operations`, …). On a multi-user host (RDS / terminal server — common in MSP
fleets) any unprivileged local user can lift the token from `agent.yaml` and, from any
machine, call `POST /helper/chat/...` to enumerate and act across the whole org's
devices without ever touching the agent.

We must stop persisting the helper token in a world-readable file while still letting
the user-session Helper obtain it.

## Goal & Non-Goals

**Goal:** Deliver `helper_auth_token` to the Assist Helper over an authenticated local
IPC channel, gated by kernel-verified peer identity + a binary-hash allowlist, so the
security boundary becomes *"be the genuine, hash-allowlisted `breeze-helper` binary
connecting over an authenticated channel"* instead of *"be any local user who can read
a 0644 file."*

**Non-Goals:**
- General-purpose Helper↔agent IPC. The Helper does its real work over HTTPS to the
  server (`helper_fetch`); the only thing it needs from the agent locally is its token.
  We give the Assist Helper a deliberately minimal IPC surface.
- Changing the org-scope of the helper token itself. A genuine Helper run by any user
  on a multi-user box still receives an org-scoped token — that is inherent to the
  current product design. This change raises the bar from "read a file" to "be the
  genuine Helper binary," which is the actual exposure being fixed.
- Reworking the agent/watchdog/userhelper IPC. We reuse it.

## Background: the existing IPC system

The Go agent already has a mature IPC system (`agent/internal/ipc/`,
`agent/internal/sessionbroker/`) used today by the watchdog and the Session-0
remote-desktop userhelper. We reuse it wholesale.

- **Transport** (`ipc/auth_*.go`): Windows named pipe `\\.\pipe\breeze-agent-ipc`;
  macOS Unix socket `/Library/Application Support/Breeze/agent.sock`; Linux Unix socket
  `/var/run/breeze/agent.sock`. The Windows pipe SDDL grants *Interactive Users
  read/write* (`sessionbroker/broker_windows.go:12`), so user-session processes can
  connect; peer-auth is the real gate.
- **Wire format** (`ipc/protocol.go`): 4-byte big-endian length prefix + JSON
  `Envelope{ID, Seq, Type, Payload, Error, HMAC}`. Pre-auth frames use a zero HMAC key;
  after auth, both sides switch to a random 256-bit `sessionKey`.
- **Peer authentication** (`ipc/auth_*.go`, `sessionbroker/broker.go:~1095-1404`):
  kernel-verified PID → SID (Windows) / UID (`SO_PEERCRED`/`LOCAL_PEERCRED` on
  unix) + binary path, **plus** a binary-hash allowlist (`selfHashes`,
  `RefreshAllowedHashes` at `broker.go:1696-1714`). Connections whose binary hash isn't
  allowlisted are rejected with `pre_auth_reject` / `binary_path_unknown`
  (`broker.go:1202`).
- **Handshake payloads** (`ipc/message.go:135-164`):
  - `AuthRequest{protocolVersion, uid, sid, username, sessionId, displayEnv, pid,
    binaryHash, winSessionId, helperRole, binaryKind, desktopContext}`
  - `AuthResponse{accepted, sessionKey, agentId, allowedScopes, reason, permanent}`
- **Role → scope mapping** (`sessionbroker/broker.go:209-213`):
  - `systemHelperScopes = [notify, tray, clipboard, desktop]`
  - `userHelperScopes = [notify, clipboard, run_as_user]`
  - `watchdogHelperScopes = [watchdog]`
- **Targeted push:** `PreferredSessionWithScope(scope)` / `SessionsWithScope(scope)`
  (`broker.go:481-540`). The watchdog already receives rotated tokens this way via the
  existing `token_update` message (`heartbeat.go:2460-2471`).

## Design

### 1. Dedicated role, scope, and message type (least privilege + token separation)

We do **not** overload the existing `token_update` message (it carries the *agent*
token to the watchdog). Two independent controls keep tokens from reaching the wrong
peer:

1. **A dedicated message type** `TypeHelperTokenUpdate = "helper_token_update"`
   (`ipc/message.go`), payload:
   ```go
   type HelperTokenUpdate struct {
       Token     string `json:"token"`
       ExpiresAt string `json:"expiresAt,omitempty"` // RFC3339, optional
   }
   ```
   The agent token continues to travel only via `token_update`; the helper token only
   via `helper_token_update`.

2. **A dedicated minimal role/scope** for the Assist Helper:
   - `HelperRoleAssist = "assist"` (`ipc/message.go`)
   - `assistHelperScopes = []string{"assist"}` (`sessionbroker/broker.go`) — note this
     does **not** include `desktop`, `clipboard`, or `run_as_user`. The Assist Helper
     can receive its token and nothing else over IPC.
   - `BinaryKind = "assist_helper"`.

   The broker sends `helper_token_update` only to sessions holding the `assist` scope,
   and `token_update` only to `watchdog`-scope sessions. A bug in one path cannot
   deliver a token to the other audience.

### 2. Binary trust: allowlist the Helper binary

Add the installed Assist Helper binary path(s) to the broker's trusted-path set
(alongside `breeze-watchdog` / userhelper at `broker.go:~1648-1696`) so
`RefreshAllowedHashes` includes the genuine `breeze-helper` binary's SHA-256 in
`selfHashes`:

- **Windows:** `breeze-helper.exe` at its installed location (next to the agent or in
  its Program Files install dir).
- **macOS:** the Helper executable inside its `.app` bundle.
- **Linux:** the installed `breeze-helper` path (if/when shipped).

Because `RefreshAllowedHashes` recomputes from the on-disk binary, a Tauri self-update
that changes the Helper's hash is picked up automatically — no pinned hash to rotate.
Replacing the binary at that path requires write access to a protected install
location (admin), which is outside the threat model this change addresses (an admin
already wins).

### 3. Rust IPC client (focused subset)

A new client module in `apps/helper/src-tauri/` implements only what's needed to
authenticate and receive the token — **not** the desktop/clipboard/command message
types.

Responsibilities:
- **Transport:** connect the platform pipe/socket (`tokio` + `winio` named pipe on
  Windows; Unix domain socket on macOS/Linux). Tauri already depends on `tokio`.
- **Framing:** 4-byte BE length prefix + JSON `Envelope`, matching `ipc/protocol.go`.
- **HMAC-SHA256:** zero key for `auth_request`; switch to the `sessionKey` from
  `auth_response` for subsequent frames; verify HMAC on inbound frames; track `seq`.
  Crates: `hmac`, `sha2`.
- **Handshake:** build `auth_request` with `helperRole="assist"`,
  `binaryKind="assist_helper"`, self-computed `binaryHash`, and the kernel-resolvable
  identity fields; handle `auth_response` (store session key) and `pre_auth_reject`
  (log + back off / exit per `permanent`).
- **Token receipt:** on `helper_token_update`, store the token **in memory only**
  (never write to disk). Inject it into the existing `helper_fetch` Authorization
  header (`lib.rs:615`), replacing the file read.
- **Resilience:** if the agent isn't up or the channel drops, reconnect with bounded
  backoff and surface a "connecting to agent" state in the UI. No silent file fallback
  except the explicit Phase-1 path (§4).

### 4. Two-phase rollout (zero lockout)

The agent and Helper update independently, so we split the change:

**Phase 1 (this work):**
- Agent: continue writing `helper_auth_token` to `agent.yaml` **and** `secrets.yaml`
  (unchanged), **and** push it via `helper_token_update` on assist-helper auth and on
  rotation.
- Helper: prefer IPC; fall back to reading `agent.yaml`/`secrets.yaml` only if IPC is
  unavailable. (The file still exists in Phase 1, so the fallback is no worse than
  today; the leak is not yet closed.)

**Phase 2 (later release, gated on adoption telemetry):**
- Agent: **stop** writing `helper_auth_token` to `agent.yaml` (keep it in
  `secrets.yaml` as the agent's own source of truth; deliver to the Helper only via
  IPC).
- Helper: IPC-only; remove the file-read fallback (`lib.rs:79-130`,
  `helper_token_from_config`).
- **The HIGH-1 leak is fully closed at Phase 2.**

This sequencing guarantees no version-skew combination locks the Helper out:
| Agent | Helper | Phase 1 outcome | Phase 2 outcome |
|-------|--------|-----------------|-----------------|
| old (file only) | old (file only) | works (file) | n/a |
| new (file + IPC) | old (file only) | works (file) | — |
| new (file + IPC) | new (IPC + fallback) | works (IPC) | — |
| new-P2 (IPC only) | new (IPC) | — | works (IPC) |
| new-P2 (IPC only) | old (file only) | — | **must be upgraded first** (gate Phase 2 on Helper adoption) |

### 5. Data flow (Phase 1)

```
Agent (SYSTEM/root)                          Assist Helper (logged-in user)
─────────────────────                        ──────────────────────────────
sessionbroker IPC listener                   Rust IPC client (NEW)
  (pipe / unix socket, Interactive RW)  ◀──── connect
  peer-auth: PID→SID/UID + binaryHash
    ∈ selfHashes  (breeze-helper added)
                                        ◀──── auth_request{role=assist,
                                                kind=assist_helper, binaryHash}
  verify peer + hash, assign scope=assist
  ───── auth_response{sessionKey, scopes} ──▶  store session key
  ───── helper_token_update{token} ───────▶  hold token IN MEMORY
  (on rotation) helper_token_update ──────▶  update in-memory token
                                              inject into helper_fetch Authorization

Phase 1: agent ALSO writes token to agent.yaml (fallback). Phase 2: it does not.
```

## Error handling

- **Agent not yet running / channel drop:** Helper reconnects with bounded backoff;
  shows "connecting to agent." In Phase 1 only, after N failed attempts it may read the
  file as a fallback; in Phase 2 there is no fallback.
- **`pre_auth_reject`:** if `permanent` (e.g. `binary_path_unknown`), the Helper logs a
  clear error and stops retrying (a non-allowlisted binary will never be accepted);
  otherwise it backs off and retries (`rate_limited`, `max_conns_exceeded`).
- **HMAC mismatch / malformed frame:** drop the connection and reconnect; never act on
  an unverified frame.
- **Token rotation race:** the Helper always uses the most recently received token; a
  401 from the API triggers an immediate reconnect to pick up a fresh token (covers the
  rotation-grace window the server already supports via `previousHelperTokenHash`).

## Testing

**Go (agent / sessionbroker):**
- Broker accepts a hash-allowlisted assist helper and assigns scope `assist` only
  (denies `desktop`/`clipboard`/`run_as_user`).
- Broker rejects a connection whose binary hash is not in `selfHashes` with
  `pre_auth_reject{code: binary_path_unknown, permanent: true}`.
- Broker sends `helper_token_update` (not `token_update`) to the assist session on auth
  success and on helper-token rotation; verifies the watchdog still receives
  `token_update` (agent token) and never `helper_token_update`.
- `RefreshAllowedHashes` includes the Helper binary path.

**Rust (helper):**
- Envelope framing + HMAC-SHA256 round-trip validated against Go-produced fixtures
  (zero-key pre-auth and session-key post-auth).
- Auth handshake: builds a valid `auth_request`, consumes `auth_response`, switches to
  the session key.
- `helper_token_update` updates the in-memory token; assert the token is **never
  written to disk**.
- Reconnect-with-backoff on dropped channel; `permanent` `pre_auth_reject` stops
  retries.

**Regression / contract:**
- Phase 2: assert `helper_auth_token` is **absent** from `agent.yaml` after
  `config.SaveTo` (it remains in `secrets.yaml`).
- Existing test confirming the Helper never falls back to the full agent token
  (`lib.rs` ~997-1008) must still pass.

## Files touched (anticipated)

**Agent (Go):**
- `agent/internal/ipc/message.go` — `HelperRoleAssist`, `TypeHelperTokenUpdate`,
  `HelperTokenUpdate` struct.
- `agent/internal/sessionbroker/broker.go` — `assistHelperScopes`, role→scope mapping,
  add Helper binary to trusted paths, push `helper_token_update` on assist-auth.
- `agent/internal/heartbeat/heartbeat.go` — push `helper_token_update` to assist
  session(s) on helper-token rotation (mirror of `sendWatchdogTokenUpdate`).
- `agent/internal/config/config.go` — **Phase 2 only:** stop writing
  `helper_auth_token` to `agent.yaml` (keep in `secrets.yaml`); update
  `stripSecretsFromAgentConfig`.

**Helper (Rust + TS):**
- `apps/helper/src-tauri/src/` — new IPC client module (transport, framing, HMAC,
  handshake, token receipt); wire the in-memory token into `helper_fetch`.
- `apps/helper/src-tauri/src/lib.rs` — replace file-read token acquisition with IPC
  (Phase 1: IPC-first with file fallback; Phase 2: IPC-only).
- `apps/helper/src-tauri/Cargo.toml` — add `hmac`, `sha2` (and Windows named-pipe dep
  if not already present).
- Helper UI — "connecting to agent" state.

## Open questions / future work

- **Phase 2 trigger:** define the adoption-telemetry threshold (agent + Helper version
  distribution) that gates the Phase 2 release. Tracked separately.
- **Out of scope but noted:** the org-scope of the helper token and whether destructive
  Helper tools require out-of-band approval (security-review HIGH-1 follow-up) are
  independent of this delivery-mechanism change.
