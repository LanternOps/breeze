---
issue: 12117
parent: 3864
status: draft (awaiting approval)
---

# Linux Per-Session Desktop Helper on the Broker IPC — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Linux a per-session, unprivileged desktop helper. The root agent spawns it into a user's logind session with `systemd-run`, and it authenticates to the session broker in both directions. It hosts the WebRTC session itself, so Wayland capture from #11841 can move into it, and no frame data ever reaches root.

**Architecture:** The helper is the existing `breeze-agent desktop-helper` subcommand. Root launches it with `systemd-run -M <user>@ --user --collect` as a transient unit in the user's systemd user manager. The helper dials the broker. The broker admits it only with a single-use **spawn ticket** that root minted for one logind session, and that ticket is the only thing that earns the new Linux desktop scope. A Linux-only, on-demand manager owns spawn, generation, crash backoff and teardown. X11 keeps its direct in-root path byte-for-byte. Wayland keeps reporting `wayland_unsupported` until the capture backend (W4, rebased from #11841) registers through the seam this plan defines.

**Tech Stack:** Go agent (`agent/`), `golang.org/x/sys/unix`, systemd/logind (`systemd-run`, `systemctl`, `loginctl`), existing `internal/ipc`, `internal/sessionbroker`, `internal/userhelper`, `internal/remote/desktop`, and `internal/heartbeat`.

**Spec:** Issue #12117, and the architecture decision in the newest comment on #3864 (binding). Read both before any task. Community PR #11841 supplies the W4 capture code.

## Global Constraints

- Nothing new runs as root. The root agent never decodes, re-encodes or buffers frame data from the helper.
- X11 sessions keep the current direct path: `handlers_desktop.go` direct branch, `x11.ProbeCapture`, and `computeDesktopAccess` output unchanged for X11.
- Until W4 merges, every Wayland device still reports `desktopAccess = {mode:"unavailable", reason:"wayland_unsupported"}`. Do not add any new reason string to the API enum (`apps/api/src/routes/agents/schemas.ts`, `packages/shared/src/types/index.ts`) in W1–W3.
- Resolve every system binary with `linuxsession.ResolveSystemBinary(name)` (`internal/patching/linuxsession/binary.go:44`), never from `PATH`. Spawn every child with `procspawn.Command` / `procspawn.CommandContext`. No `//procspawn:exempt` is needed or allowed for these spawns.
- All new Linux-only code sits in `_linux.go` files. The decision logic sits in untagged pure functions so that `go test -race` exercises it on macOS dev hosts as well as on CI Linux.
- Feature flag: agent config key `desktop_wayland_helper` (bool, default `false`). With the flag off, the agent behaves exactly as `origin/main` does today.
- Public repo: no hostnames, IPs or customer names in code, tests or docs. Write security comments neutrally ("the broker must reject…"), and include no exploit narratives.

## Review Focus

These are failure modes the spec implies that are easy to miss. Each one has a pinning test in the task named.

1. **A ticket replayed or reused after a helper restart.** A second connection presenting a consumed nonce, or a nonce from an older generation, must be rejected permanently. Pinned in Task 1.2 (`TestLinuxDesktopTicket_SingleUse`, `TestLinuxDesktopTicket_StaleGeneration`).
2. **A Linux user-role peer claiming `binaryKind=desktop_helper` without a ticket must not fall through to `userHelperScopes`.** That set includes `run_as_user`. Pinned in Task 1.3 (`TestAdmitLinuxDesktopHelper_NoTicketRejected`).
3. **A stalled or slowloris helper.** One that sends a partial frame, a 16 MiB length header, or nothing at all must not pin memory or a goroutine in root past the existing deadlines. Pinned in Task 1.4 (`TestLinuxDesktopHelper_OversizeHeaderRejectedBeforeAlloc`, `TestLinuxDesktopHelper_StalledPeerEvicted`).
4. **Logout or a fast user switch while a technician is connected.** The live session must end, and the helper must be stopped and must not be respawned for a session logind no longer reports as active. Pinned in Task 2.4 (`TestLinuxDesktopManager_SessionGoneStopsHelper`, `TestLinuxDesktopManager_InactiveSessionEndsLiveDesktop`).
5. **An agent that is not root, such as a dev run, or a socket whose server is not uid 0.** The helper must refuse to authenticate and say why in its log. It must never fall back to an unverified connection. Pinned in Task 1.1 (`TestCheckUnixServerIdentity_*`).

---

## Background the implementer needs (verified against `origin/main` 384f8889c8)

- **Broker admission** is `Broker.handleConnection`, `internal/sessionbroker/broker.go` ~2236–2490. The order is: SO_PEERCRED via `ipc.GetPeerCredentials` (`ipc/auth_linux.go`, uid plus `/proc/<pid>/exe`), auth request, rate limit and quota, protocol version, claimed UID equals kernel UID, exe path allowlist, exe SHA-256 allowlist, then `roleIdentityRejection` (~2922) and `grantScopes` (~3000).
  - On Unix, `roleIdentityRejection` rejects only non-root `system`, `watchdog` and `backup` roles.
  - `scopesForRole` (~2969) gives `macDesktopHelperScopes` only on darwin.
  - On Linux every other user-role peer gets `userHelperScopes = {notify, clipboard, run_as_user}`.
- **Inbound filtering** is in `shouldForwardUnsolicitedHelperMessage` and `sanitizeCapabilitiesForSession` (broker.go ~3723–3790). `ipc.MaxMessageSize` is 16 MiB, and `Conn.Recv` allocates the body from the header length (`ipc/protocol.go` ~301).
- **Helper entry.** `breeze-agent desktop-helper` already exists: `desktopHelperCmd` → `runDesktopHelper` → `runHelperProcess` in `internal/agentapp/main.go` ~2162.
  - `desktopHelperRole()` there, and its twin in `cmd/breeze-desktop-helper/main.go` ~210, return `HelperRoleSystem` off darwin. The broker rejects that for a non-root uid.
  - The separate `breeze-desktop-helper` binary is built and shipped for darwin only (`.github/workflows/release.yml` ~333; `agentapp/first_install_release.go:139`).
- **Helper client.** `internal/userhelper/client_unix.go` `dialIPC` is a bare `net.DialTimeout`. Windows verifies the server through `ipc.VerifyServerIdentity` and the pure `ipc.CheckServerIdentity` (`ipc/serveridentity.go`).
- **Desktop over IPC (macOS precedent).** The steps are:
  1. `desktop_fence_sync`
  2. `desktop_start` (`DesktopStartRequest` carries the SDP offer, ICE servers, `StartGeneration` and `RevocationLease`), answered by `DesktopStartResponse`
  3. `desktop_ice_trickle_begin` and `desktop_local_ice_candidate` / `desktop_remote_ice_candidate`
  4. `desktop_lease_renew` / `desktop_lease_update`
  5. `desktop_stop`
  6. `desktop_peer_disconnected`

  The agent side is `startDesktopViaHelper` → `startDesktopOnSession` (`heartbeat/handlers_desktop_helper.go`). The helper side is `userhelper.handleDesktopStart` → `desktop.SessionManager.StartSession`. `TypeDesktopFrame` and `TypeDesktopInput` have no sender. Frames never cross IPC on macOS, and the same must hold on Linux.
- **Two different "generations".**
  - The *desktop start fence* (`heartbeat/desktop_fence.go`, `userhelper/desktop_fence.go`) orders start and stop commands from the control plane. It is reused unchanged.
  - The *helper spawn generation* is new in this plan. It orders helper processes for one logind session.
  - The *revocation lease* (`remote/desktop/revocation_lease.go` plus the IPC bridge) is also reused unchanged.
  - Do not confuse any of these with `heartbeat/handlers_desktop_lease.go`, which holds the Windows on-demand helper leases.
- **Lifecycle.** `sessionbroker.HelperLifecycleManager` (`lifecycle_core.go`) is keyed by `HelperKey{WindowsSessionID uint32, Role}` and is driven by SCM events. `lifecycle_stub.go` (`!windows`) builds it with a nil spawner. On Linux no manager is constructed at all.
- **Linux sessions.** `sessionbroker/detector_linux.go` (`loginctl`, polled every 5 s, id-keyed `DetectedSession` with `UID`, `State`, `LogindType`, `Seat`, `IsRemote`, `Class`, `Locked`) and `patching/linuxsession.List` (graphical sessions with `UID`, `Username`, `Type`, `Display`).
- **Socket reachability.** `/var/run/breeze/agent.sock` is `0660 root:breeze`. `install-linux.sh` adds users to `breeze` only if they are logged in at install time. A user manager started before a later `usermod` keeps its old group list, and transient units inherit it.

---

## File Structure

| File | Wave | Responsibility |
|---|---|---|
| `agent/internal/ipc/serveridentity_unix.go` (new, untagged) | W1 | Pure `CheckUnixServerIdentity(UnixServerEvidence) error` |
| `agent/internal/ipc/serveridentity_linux.go` (new) | W1 | `GatherUnixServerEvidence(*net.UnixConn, socketPath) (UnixServerEvidence, error)` |
| `agent/internal/userhelper/client_unix.go` (modify) | W1 | Linux: verify the server before sending `auth_request` |
| `agent/internal/ipc/message.go` (modify) | W1 | `AuthRequest.LogindSessionID`, `AuthRequest.SpawnTicket` |
| `agent/internal/ipc/protocol.go` (modify) | W1 | `Conn.SetMaxRecvSize` checked before allocation |
| `agent/internal/sessionbroker/linux_desktop_ticket.go` (new, untagged) | W1 | Ticket store: issue / consume / revoke, TTL, cap |
| `agent/internal/sessionbroker/linux_desktop_admission.go` (new, untagged) | W1 | Pure admission decision plus `linuxDesktopHelperScopes` |
| `agent/internal/sessionbroker/linux_desktop_inbound.go` (new, untagged) | W1 | Inbound type allowlist and per-type size/count bounds |
| `agent/internal/sessionbroker/broker.go` (modify) | W1 | Wire admission, scope, receive cap and inbound filter |
| `agent/internal/sessionbroker/linux_desktop_listener_linux.go` (new) | W2 | Per-UID listener (see Open Decision 2) |
| `agent/internal/sessionbroker/linux_desktop_spawn.go` (new, untagged) | W2 | Pure `buildSystemdRunArgv` / `buildSystemctlStopArgv`, unit naming, user validation |
| `agent/internal/sessionbroker/linux_desktop_spawn_linux.go` (new) | W2 | `systemdRunSpawner` (procspawn plus ResolveSystemBinary) |
| `agent/internal/sessionbroker/linux_desktop_manager.go` (new, untagged) | W2 | `LinuxDesktopHelperManager` state machine with injected clock, spawner and logind lookup |
| `agent/internal/sessionbroker/linux_desktop_manager_linux.go` (new) | W2 | Constructor wiring to the real detector and spawner |
| `agent/internal/agentapp/main.go`, `cmd/breeze-desktop-helper/main.go` (modify) | W2 | `desktopHelperRole()` → user on Linux; Linux helper reads the ticket env and exits on disconnect |
| `agent/internal/userhelper/linux_desktop_env.go` (new, untagged) | W2 | Parse and validate `BREEZE_LOGIND_SESSION` / `BREEZE_SPAWN_TICKET` |
| `agent/internal/config/config.go` (modify) | W2 | `DesktopWaylandHelper bool` with `mapstructure:"desktop_wayland_helper"` |
| `agent/internal/heartbeat/handlers_desktop_helper.go` (modify) | W3 | Linux branch of `spawnHelperForDesktop`; Linux helper selection |
| `agent/internal/heartbeat/linux_desktop_route.go` (new, untagged) | W3 | Pure `linuxDesktopRoute(...)` decision |
| `agent/internal/heartbeat/handlers_desktop.go` (modify ~336) | W3 | Wayland plus flag → helper path; X11 unchanged |
| `agent/internal/heartbeat/desktop_access_linux.go` (modify) | W3 | Wayland stays `wayland_unsupported` unless a capable bound helper exists |
| `agent/internal/remote/desktop/session_backend.go` (new, untagged) | W3 | `SessionBackend` seam plus `RegisterSessionBackend` |
| `agent/internal/remote/desktop/capture_linux.go`, `session_webrtc.go` (modify) | W3 | Use the registered backend when present |
| `agent/internal/remote/desktop/wayland/*` (from #11841) | W4 | Portal plus PipeWire backend, run inside the helper |

---

## Wave W1 — Two-way trust and the Linux desktop scope (no behaviour change)

Nothing spawns a Linux desktop helper yet, so this wave changes no shipped behaviour. It lands the auth contract that every later wave relies on.

### Task 1.1: Helper verifies it is talking to the real broker (Linux)

**Files:**
- Create: `agent/internal/ipc/serveridentity_unix.go`, `agent/internal/ipc/serveridentity_linux.go`
- Modify: `agent/internal/userhelper/client_unix.go` (`dialIPC`)
- Test: `agent/internal/ipc/serveridentity_unix_test.go`, `agent/internal/ipc/serveridentity_linux_test.go`

**Interfaces:**
- Produces:
  ```go
  type DirEvidence struct { Path string; UID uint32; Mode fs.FileMode }
  type UnixServerEvidence struct {
      PeerUID  uint32        // SO_PEERCRED of the connected server end (credentials only)
      DirChain []DirEvidence // every ancestor of the canonical socket dir, socket dir first, "/" last
  }
  func CheckUnixServerIdentity(ev UnixServerEvidence) error   // pure
  func peerUcredOnly(conn *net.UnixConn) (uid uint32, pid int32, err error) // linux; no /proc read
  func GatherUnixServerEvidence(conn *net.UnixConn, socketPath string) (UnixServerEvidence, error) // linux
  var ErrUnixServerNotRoot, ErrUnixSocketDirUnsafe error
  ```
- Rules:
  - The check fails unless `PeerUID == 0` and **every** entry in `DirChain` is root-owned with `Mode&0o022 == 0`.
  - The chain is built from `filepath.EvalSymlinks(filepath.Dir(socketPath))`, so `/var/run` → `/run` is resolved, and walks up to `/`.
  - `ipc.GetPeerCredentials` is **not** reused, because it needs `/proc/<pid>/exe`, which an unprivileged client cannot read for a root process.
  - uid 0 proves the server is privileged, not specifically that it is Breeze. That is the strongest anchor available to an unprivileged client, and it is enough to stop a non-root impostor.

- [ ] **Step 1: Write failing table tests:**
  - `TestCheckUnixServerIdentity_AcceptsRootServerInRootDirs`
  - `TestCheckUnixServerIdentity_RejectsNonRootPeer`: PeerUID 1000 → `ErrUnixServerNotRoot`.
  - `TestCheckUnixServerIdentity_RejectsGroupWritableDir`: mode 0o775 → `ErrUnixSocketDirUnsafe`.
  - `TestCheckUnixServerIdentity_RejectsUserOwnedAncestor`: a user-owned entry in the middle of the chain → `ErrUnixSocketDirUnsafe`.
  - `TestCheckUnixServerIdentity_RejectsEmptyChain`
- [ ] **Step 2: Run** `cd agent && go test -race ./internal/ipc -run TestCheckUnixServerIdentity` → FAIL (undefined).
- [ ] **Step 3: Implement** both functions. In `dialIPC`, on `runtime.GOOS == "linux"`, gather and check before returning the conn. On failure, close the conn and return an error wrapping the sentinel. The supervisor logs it at warn.
- [ ] **Step 4: Linux-only test** `TestGatherUnixServerEvidence_SelfListener`. Listen in a `t.TempDir()`, dial, and assert `PeerUID == uint32(os.Getuid())`. It runs on CI Linux, and the CI runner is non-root, so it also proves that the check rejects a non-root server end to end.
- [ ] **Step 5: Run** `go test -race ./internal/ipc ./internal/userhelper` → PASS. Run `GOOS=linux go vet ./internal/ipc ./internal/userhelper`.
- [ ] **Step 6: Commit** `feat(agent): verify the broker is root before a Linux helper authenticates (#12117)`

Note: this also hardens the existing `breeze-agent user-helper` on Linux, because it uses the same client. A dev agent run as non-root will now refuse its helpers. Say so in the PR body.

### Task 1.2: Spawn ticket store

**Files:**
- Create: `agent/internal/sessionbroker/linux_desktop_ticket.go`
- Test: `agent/internal/sessionbroker/linux_desktop_ticket_test.go`

**Interfaces:**
- Produces:
  ```go
  type LinuxDesktopBinding struct {
      UID             uint32
      Username        string
      LogindSessionID string
      Generation      uint64 // helper spawn generation, monotonic per logind session
  }
  type linuxDesktopTickets struct { /* mu, byNonce, latestGen map[string]uint64, now func() time.Time */ }
  func newLinuxDesktopTickets(now func() time.Time) *linuxDesktopTickets
  func (t *linuxDesktopTickets) issue(b LinuxDesktopBinding) (nonce string, err error)
  func (t *linuxDesktopTickets) consume(nonce, logindSessionID string, peerUID uint32) (LinuxDesktopBinding, error)
  func (t *linuxDesktopTickets) revokeSession(logindSessionID string)
  const linuxDesktopTicketTTL = 20 * time.Second
  const maxLinuxDesktopTickets = 16
  var errTicketUnknown, errTicketExpired, errTicketUIDMismatch, errTicketSessionMismatch, errTicketStaleGeneration, errTicketStoreFull error
  ```
- The nonce is 32 bytes from `crypto/rand`, base64url without padding. Lookup is by nonce and the compare is constant-time. `issue` for a session revokes any earlier unconsumed ticket for that session and sets `latestGen[session] = b.Generation`. `consume` deletes the entry before returning on **every** outcome, so a nonce cannot be reused even after a failed attempt.

- [ ] **Step 1: Write failing tests:**
  - `TestLinuxDesktopTicket_SingleUse`: the second `consume` gives `errTicketUnknown`.
  - `TestLinuxDesktopTicket_Expired`: advance the clock by TTL+1 ns → `errTicketExpired`.
  - `TestLinuxDesktopTicket_UIDMismatch`.
  - `TestLinuxDesktopTicket_SessionMismatch`.
  - `TestLinuxDesktopTicket_StaleGeneration`: issue gen 1, issue gen 2; the gen 1 nonce gives `errTicketUnknown`.
  - `TestLinuxDesktopTicket_FailedConsumeBurnsNonce`: a uid mismatch, then a correct uid → `errTicketUnknown`.
  - `TestLinuxDesktopTicket_Cap`: the 17th live ticket → `errTicketStoreFull`.
  - `TestLinuxDesktopTicket_ConcurrentConsume`: 50 goroutines and exactly one success, under `-race`.
- [ ] **Step 2: Run** `go test -race ./internal/sessionbroker -run TestLinuxDesktopTicket` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(agent): single-use spawn tickets for Linux desktop helpers (#12117)`

### Task 1.3: Admission and the Linux desktop scope

**Files:**
- Create: `agent/internal/sessionbroker/linux_desktop_admission.go`
- Modify: `agent/internal/ipc/message.go` (AuthRequest), `agent/internal/sessionbroker/broker.go` (handleConnection after step 7, `scopesForRole`, `Session` struct)
- Test: `agent/internal/sessionbroker/linux_desktop_admission_test.go`

**Interfaces:**
- Consumes: `linuxDesktopTickets` (Task 1.2).
- Produces:
  ```go
  // ipc.AuthRequest additions
  LogindSessionID string `json:"logindSessionId,omitempty"`
  SpawnTicket     string `json:"spawnTicket,omitempty"`

  var linuxDesktopHelperScopes = []string{"desktop"}

  type LogindSessionState struct { UID uint32; Type, State, Class string; Remote, Exists, PropertiesUnknown bool; OtherGraphicalSessions int }
  type logindLookupFunc func(ctx context.Context, id string) (LogindSessionState, error)

  // Pure. Called only when goos == "linux".
  func linuxDesktopAdmission(goos string, role ipc.HelperRole, req ipc.AuthRequest) (isLinuxDesktop bool, reject string)
  func linuxDesktopSessionLive(st LogindSessionState, b LinuxDesktopBinding) (reason string, ok bool)

  // Broker
  func (b *Broker) IssueLinuxDesktopTicket(binding LinuxDesktopBinding) (string, error)
  func (b *Broker) RevokeLinuxDesktopTickets(logindSessionID string)
  // Session field, set once before registration, read-only after
  LinuxDesktop *LinuxDesktopBinding
  ```
- Rules. On Linux each of these is a permanent reject unless noted.
  - `role == user && binaryKind == desktop_helper` with an empty ticket: reject with "linux desktop helper requires a spawn ticket". **Never** fall through to `userHelperScopes`.
  - A non-empty `SpawnTicket` or `LogindSessionID` on any other role or binary kind: reject.
  - Otherwise, consume the ticket against the kernel UID (`creds.UID`, never `authReq.UID`), which must be nonzero. Then look up logind with a 2 s context through an explicit `loginctl show-session <id>`.
  - `linuxDesktopSessionLive` requires `Exists`, `UID == binding.UID`, `Type == "wayland"`, `State == "active"` (read explicitly, never the list-row default), `Class == "user"` and `!Remote`.
  - **Fail closed on an incomplete answer.** A failed or partial query is the `PropertiesUnknown` case in `detector_linux.go`, whose list-row default reads `active` (`logind_props.go` ~79); that is a reject.
  - Reject if the uid has **any other** local graphical session, X11 or Wayland. The user bus is shared, so the session is ambiguous. Return `LogindSessionState.OtherGraphicalSessions int`.
  - **Same build as the daemon.** The peer's verified exe hash must equal the SHA-256 of the running daemon's own executable, recorded once at broker start as `Broker.selfExeHash`. Matching any allowlisted hash is not enough. After a self-update replaces the file on disk, a freshly spawned helper would run the new build while root still runs the old one, so the hash comparison rejects it until root restarts. Task 2.4 checks the same thing before spawning.
  - On success, scopes are exactly a copy of `linuxDesktopHelperScopes`. Do not add `consent_ui_fallback`, prompt scopes or messaging. `applyAuthAdvertisements` is skipped except `uiLocale`.
  - A Linux desktop helper is never chosen by `notify`, `clipboard`, `run_as_user`, consent or prompt routing. Assert this through `HasScope` in the tests.
- Darwin and Windows behaviour is unchanged (`TestScopesForRole_*` existing tests stay green).

- [ ] **Step 1: Write failing tests:**
  - `TestAdmitLinuxDesktopHelper_NoTicketRejected`
  - `TestAdmitLinuxDesktopHelper_TicketOnUserHelperRejected`
  - `TestAdmitLinuxDesktopHelper_ValidTicketGetsDesktopOnly`: the scopes equal `[]string{"desktop"}` and `HasScope("run_as_user") == false`.
  - `TestAdmitLinuxDesktopHelper_KernelUIDNotClaimedUID`
  - `TestAdmitLinuxDesktopHelper_HashMustMatchRunningBuild`: an allowlisted but different hash → reject.
  - `TestLinuxDesktopSessionLive_*`, covering inactive, x11, remote, a different uid, a missing session, a greeter class, `PropertiesUnknown`, uid 0, and a second graphical session of either type.
  - `TestAdmitLinuxDesktopHelper_DarwinUnchanged`

  Drive the broker through the existing test harness (`helperPathsFn`, an injected hash allowlist, `b.goos = "linux"`) and an injected `logindLookup`.
- [ ] **Step 2: Run** `go test -race ./internal/sessionbroker -run 'LinuxDesktop|ScopesForRole'` → FAIL.
- [ ] **Step 3: Implement.** Admission runs after step 7 (hash) and before step 8 (duplicate session id), so an unauthenticated peer cannot burn a ticket. Log rejects with the reason and the peer uid, and never with the nonce.
- [ ] **Step 4: Run** → PASS. Also run `go test -race ./internal/sessionbroker` in two batches (`-run 'Broker'`, then the rest) with `-timeout 600s`.
- [ ] **Step 5: Commit** `feat(agent): Linux desktop helper scope, admitted only by spawn ticket (#12117)`

### Task 1.4: Bounds on what root accepts from a Linux desktop helper

**Files:**
- Modify: `agent/internal/ipc/protocol.go`
- Create: `agent/internal/sessionbroker/linux_desktop_inbound.go`
- Modify: `agent/internal/sessionbroker/broker.go` (pre-auth cap; post-auth: set the cap; message loop: filter; `sanitizeCapabilitiesForSession`), `agent/internal/sessionbroker/session.go` (`RecvLoop` correlated-response size check ~623), `agent/internal/heartbeat/desktop_ice_trickle.go` (~85: root generation)
- Test: `agent/internal/ipc/protocol_maxrecv_test.go`, `agent/internal/sessionbroker/linux_desktop_inbound_test.go`

**Interfaces:**
- Produces:
  ```go
  func (c *Conn) SetMaxRecvSize(n uint32)          // 0 = MaxMessageSize; checked against the header BEFORE make()
  func (c *Conn) SetFrameDeadline(d time.Duration) // absolute: first header byte → body complete; 0 = off
  const preAuthMaxRecv = 64 << 10                  // ALL connections, all platforms, until admission
  const linuxDesktopHelperMaxRecv = 256 << 10
  const linuxDesktopHelperFrameDeadline = 10 * time.Second
  // Broker field; W1 default returns false. Task 3.3 sets it to: flag on && desktop.WaylandBackendCompiled.
  linuxWaylandCaptureAuthorized func() bool
  // nil = accept; non-nil = drop and count; disconnect once strikes hit linuxDesktopInboundStrikeLimit (3)
  func checkLinuxDesktopInbound(env *ipc.Envelope, st *linuxDesktopInboundState) error
  ```
- **The pre-auth cap applies to every helper connection on every platform.** Codex and I agree on this; see Open Decision 5. `handleConnection` sets `SetMaxRecvSize(preAuthMaxRecv)` before the first `Recv`, then raises the cap after admission: back to `MaxMessageSize` for existing roles, and to `linuxDesktopHelperMaxRecv` for a Linux desktop helper.
- Resumable `Recv` fixes framing, but it does not defend against a slowloris peer. The frame deadline does, together with the keepalive. Apply it to Linux desktop helpers only.
- **Capabilities are root-authoritative.** For a session with `LinuxDesktop != nil`, `sanitizeCapabilitiesForSession` forces `CanNotify`, `CanTray` and `CanClipboard` to false. It forces `CanCapture` to false unless `linuxWaylandCaptureAuthorized()` returns true. That is always false in W1–W3. Task 3.3 wires it, and it becomes true only in W4. The helper's claim is an upper bound, never a grant.
- **Semantic replay.** For Linux desktop sessions, ownership of `desktop_local_ice_candidate`, `desktop_lease_renew` and `desktop_peer_disconnected` is checked against the tuple (broker connection instance, desktop session id, root-recorded start generation).
  - Root forwards **its own recorded generation**, never the helper-supplied one. Today `desktop_ice_trickle.go` ~85 forwards the helper's.
  - Messages for a desktop session that is already terminal are dropped.
  - Applying the same fix to macOS helpers is Open Decision 8.
- The inbound allowlist, from helper to root, for a session with `LinuxDesktop != nil`. Every other type is dropped and counted.

  | Type | Bound |
  |---|---|
  | `capabilities` | ≤ 4 KiB, through the existing `sanitizeCapabilitiesForSession` |
  | Command responses to `desktop_start`, `desktop_stop`, `desktop_fence_sync` | Matched to a pending command id; ≤ 128 KiB (SDP answer ≤ 64 KiB inside) |
  | `desktop_local_ice_candidate` | ≤ 2 KiB each, ≤ 256 per desktop session id; candidate type checked by the existing validator |
  | `desktop_lease_renew` | ≤ 1 KiB, ≤ 1 per 5 s per desktop session |
  | `desktop_peer_disconnected` | ≤ 1 KiB, reason truncated to 128 bytes |
  | Helper log relay | Existing per-helper rate cap (~20 lines/min) |
  | Keepalive pong | Existing |

- Explicitly dropped: `desktop_frame`, `desktop_input`, `desktop_clipboard_*`, `tcc_status`, prompt/consent/notify/tray/message/chat types, and SAS. Anything addressed to another helper's session id is also dropped: the existing owner check in `heartbeat.go` (~2071) stays, and this is an extra layer in front of it.

- [ ] **Step 1: Write failing tests:**
  - `TestConnSetMaxRecvSize_RejectsBeforeAlloc`: a header of 16 MiB against a 256 KiB cap → error, and `rbody` stays nil.
  - `TestConnSetMaxRecvSize_ZeroMeansDefault`
  - `TestLinuxDesktopInbound_DropsFrameAndInput`
  - `TestLinuxDesktopInbound_ICECandidateCap`: the 257th is dropped.
  - `TestLinuxDesktopInbound_StrikeLimitDisconnects`
  - `TestLinuxDesktopHelper_OversizeHeaderRejectedBeforeAlloc`
  - `TestLinuxDesktopHelper_StalledPeerEvicted`: a helper that authenticates and then never sends keepalive is evicted at `keepaliveTimeout`. Use the injected clock or the existing keepalive test seam.
  - `TestConnFrameDeadline_TrickledFrameFails`: one byte per second against a 10 s deadline → error at the deadline.
  - `TestHandleConnection_PreAuthCapAllRoles`: a 1 MiB auth header → closed, no allocation. A real `AuthRequest` with 32 `PromptKinds` still fits under 64 KiB.
  - `TestSanitizeCapabilities_LinuxDesktopCannotSelfGrantCapture`
  - `TestLinuxDesktopICE_ForwardsRootGeneration`: the helper sends gen "999", and root forwards its recorded gen.
  - `TestLinuxDesktopInbound_TerminalSessionDropped`
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** Call `SetMaxRecvSize` right after a Linux desktop admission and before the session is registered.
- [ ] **Step 4: Run** `go test -race ./internal/ipc ./internal/sessionbroker -run 'MaxRecv|LinuxDesktop'` → PASS. Run `go test -race -run Fuzz ./internal/ipc` for the seed corpus only.
- [ ] **Step 5: Commit** `feat(agent): bound what root accepts from a Linux desktop helper (#12117)`

**W1 ships:** Two-way auth for Linux helpers, plus a 64 KiB pre-auth receive cap on every platform. No helper is spawned yet. The PR body states that the Linux `user-helper` now verifies its server, and that the pre-auth cap is global.

---

## Wave W2 — Spawn and lifecycle (flag-gated; nothing is routed to the helper yet)

### Task 2.1: Helper-side Linux mode

**Files:**
- Create: `agent/internal/userhelper/linux_desktop_env.go`, plus a test
- Modify: `agent/internal/agentapp/main.go` (`desktopHelperRole`, `runHelperProcess`), `cmd/breeze-desktop-helper/main.go` (`desktopHelperRole`), `agent/internal/userhelper/client.go` (`authenticate`, `detectCapabilities`)

**Interfaces:**
- Produces:
  ```go
  type LinuxDesktopEnv struct { LogindSessionID, SpawnTicket, SocketPath string }
  func ParseLinuxDesktopEnv(getenv func(string) string) (LinuxDesktopEnv, error) // validates: session id [A-Za-z0-9]{1,32}, ticket base64url len 43, socket absolute under /run/breeze or /var/run/breeze
  ```
- Behaviour on Linux when `BREEZE_SPAWN_TICKET` is set:
  - `desktopHelperRole()` returns `HelperRoleUser` on Linux in both copies.
  - `authenticate` sends `LogindSessionID` and `SpawnTicket`.
  - The helper scrubs the ticket from its own environment after reading it, with `os.Unsetenv`.
  - It does **not** use the reconnecting `userhelper.Supervisor`. Because the ticket is single-use, a disconnect is final: end any live `SessionManager` session, then exit 0.
  - It exits after `linuxDesktopHelperIdleExit = 5 * time.Minute` with no live desktop session.
  - `detectCapabilities` reports `CanCapture=false` on Linux unless `desktop.SessionBackendRegistered()` (Task 3.3) is true.
  - Without the env vars, the Linux `desktop-helper` subcommand exits 2 with "desktop-helper on Linux is started by the agent".

- [ ] **Step 1: Write failing tests:**
  - `TestParseLinuxDesktopEnv_*`: valid, bad session id, bad ticket length, relative socket and socket outside /run.
  - `TestDesktopHelperRole_LinuxIsUser`
  - `TestLinuxDesktopHelper_DisconnectIsFinal`: drive the client with an `ipc` pipe pair, close the server side, and assert the run function returns without redialing.
  - `TestDetectCapabilities_LinuxDesktopHelperNoBackend`: `CanCapture=false`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `go test -race ./internal/userhelper ./internal/agentapp -run 'LinuxDesktop|DesktopHelperRole'` → PASS.
- [ ] **Step 5: Commit** `feat(agent): Linux desktop-helper mode authenticates with a spawn ticket (#12117)`

### Task 2.2: Socket reachability for the spawned helper

This task follows whichever option Open Decision 2 settles on. The default is a per-UID listener.

**Files:**
- Create: `agent/internal/sessionbroker/linux_desktop_listener_linux.go`, plus a test
- Modify: `agent/internal/sessionbroker/broker.go` (`listenOn` refactor so that a second listener shares `startAcceptedConnection` and the shutdown accounting)

**Interfaces:**
- Produces:
  ```go
  func (b *Broker) EnsureLinuxDesktopListener(uid uint32) (socketPath string, err error) // /run/breeze/desktop/<uid>.sock
  func (b *Broker) CloseLinuxDesktopListener(uid uint32)
  ```
- Rules:
  - The directory `/run/breeze/desktop` is created `0755 root:root`, and the call fails if it exists with another owner or mode.
  - The socket is created by root, `chown uid:0`, and set to mode `0600`.
  - The owning uid can `chmod` its own socket. The file mode is therefore advisory, and the kernel uid check is the real control.
  - Each connection accepted on the listener carries the listener's expected uid into `handleConnection`. The SO_PEERCRED uid is compared **before the auth request is read**, and a mismatch closes the connection with no reply.
  - **The endpoint is ticket-only.** On this listener, anything other than `role=user`, `binaryKind=desktop_helper` with a ticket is a permanent reject. Other broker roles are never reachable through it.
  - Conversely, a `SpawnTicket` on the shared socket is a reject.
  - Creation fails closed. If `/run/breeze/desktop` or the socket path already exists and is not exactly what root expects (a directory owned by root with mode 0755; a socket for the same uid), refuse, and remove it only when it is a socket. Never follow a symlink (`Lstat` throughout). Replacing a listener for a uid closes the old one first.
  - Unlinking a socket does not close connections already made through it. `CloseLinuxDesktopListener` also closes every broker session accepted on that listener.
  - The listener closes when the manager forgets the last entry for that uid, and on broker shutdown.

- [ ] **Step 1: Write failing tests:**
  - `TestLinuxDesktopListener_ModeAndOwner`. This needs root, so it is skipped unless the euid is 0; the pure path check is covered separately.
  - `TestLinuxDesktopListener_RejectsWrongUIDPeer`, using the injected peer-cred seam.
  - `TestLinuxDesktopListener_TicketOnSharedSocketRejected`
  - `TestLinuxDesktopListener_ClosedOnShutdown`
  - `TestLinuxDesktopListener_RefusesForeignOwnedDir`
  - `TestLinuxDesktopListener_UIDCheckedBeforeAuthRead`: a wrong-uid peer's auth bytes are never read.
  - `TestLinuxDesktopListener_NonDesktopRoleRejected`: covers `system`, `assist` and `watchdog` arriving on it.
  - `TestLinuxDesktopListener_CloseDropsLiveSessions`
  - `TestLinuxDesktopListener_SymlinkedPathRefused`
  - `TestLinuxDesktopListener_HandshakeConcurrencyCap`: a third concurrent unauthenticated connection for one uid is closed (`maxLinuxDesktopHandshakesPerUID = 2`).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `go test -race ./internal/sessionbroker -run LinuxDesktopListener` → PASS.
- [ ] **Step 5: Commit** `feat(agent): per-user broker listener for Linux desktop helpers (#12117)`

### Task 2.3: systemd-run spawner

**Files:**
- Create: `agent/internal/sessionbroker/linux_desktop_spawn.go`, `linux_desktop_spawn_linux.go`, and tests

**Interfaces:**
- Produces:
  ```go
  type LinuxDesktopSpawnSpec struct {
      Binding    LinuxDesktopBinding
      Ticket     string
      AgentExe   string // os.Executable() resolved with EvalSymlinks; must be in Broker.allowedHelperPaths()
      SocketPath string
      RuntimeDir string // /run/user/<uid>
      WaylandDisplay string // from linuxsession, validated [A-Za-z0-9._-]{1,64}
  }
  type linuxDesktopSpawner interface {
      Start(ctx context.Context, spec LinuxDesktopSpawnSpec) (unit string, err error)
      Stop(ctx context.Context, username, unit string) error
  }
  func linuxDesktopUnitName(logindSessionID string, gen uint64, rnd [4]byte) string // "breeze-desktop-helper-<id>-g<gen>-<hex8>.service"; id restricted to [A-Za-z0-9]
  func validLinuxUsername(s string) bool                              // ^[A-Za-z0-9._][A-Za-z0-9._-]{0,63}$ and not "root"
  func buildSystemdRunArgv(spec LinuxDesktopSpawnSpec, unit string) []string
  func buildSystemctlStopArgv(username, unit string) []string
  ```
- `buildSystemdRunArgv` produces exactly the following. There is **no `--pipe`, `--wait` or `--pty`**: the helper dials the broker itself, so the design does not depend on passing fds across `-M user@`.

  ```
  -M <username>@ --user --collect --quiet --unit=<unit> --service-type=exec
  --property=NoNewPrivileges=yes
  --setenv=XDG_RUNTIME_DIR=<RuntimeDir>
  --setenv=WAYLAND_DISPLAY=<WaylandDisplay>
  --setenv=XDG_SESSION_ID=<LogindSessionID>
  --setenv=XDG_SESSION_TYPE=wayland
  --setenv=BREEZE_LOGIND_SESSION=<LogindSessionID>
  --setenv=BREEZE_SPAWN_TICKET=<Ticket>
  --setenv=BREEZE_IPC_SOCKET=<SocketPath>
  -- <AgentExe> desktop-helper
  ```

  The binary is `linuxsession.ResolveSystemBinary("systemd-run")`. Stop is `systemctl -M <username>@ --user stop <unit>`, with the binary from `ResolveSystemBinary("systemctl")`. Both run with `procspawn.CommandContext` and a 10 s timeout, and stderr is captured and truncated to 512 bytes in the error.
- Hygiene:
  - The child gets a fixed minimal environment (`PATH=/usr/bin:/bin`, `LANG=C`), never root's environment.
  - The ticket never appears in a log line. Errors log the argv with the ticket value redacted.
  - The ticket is briefly visible in `/proc/<pid>/cmdline` of root's `systemd-run`. That is acceptable, because a ticket is bound to the target uid and is only accepted on that uid's `0600` listener.
  - A `Unit … already exists` error is returned as a collision and never retried with the same name.
- The user manager inherits its environment from the session. The plan sets `WAYLAND_DISPLAY`, `XDG_RUNTIME_DIR` and the session id with `--setenv`, for this unit only. It never runs `import-environment`.
  - A missing `/run/user/<uid>/bus` or a dead `user@<uid>.service` is a distinct error, `ErrLinuxDesktopUserManagerUnavailable`.
  - Never enable linger. A user manager that exists does not prove a graphical session; only logind does.
- A probe, once per agent run: `systemd-run --version`. A major version below `linuxSystemdMinVersion` makes `Start` return `ErrLinuxDesktopSpawnUnsupported`. The constant is 248, where user-manager `-M user@` support landed (Codex cites the v248 NEWS entry). The lab leg (Task 4.3) confirms it on downstream builds.

- [ ] **Step 1: Write failing tests:**
  - `TestBuildSystemdRunArgv_Exact`: golden slice.
  - `TestBuildSystemdRunArgv_NoPipeOrWait`
  - `TestValidLinuxUsername_RejectsRootAndMetachars`: covers `root`, `a b`, `x;y`, an empty name, 65 characters and a leading `-`.
  - `TestLinuxDesktopUnitName_Sanitized`
  - `TestSystemdMajorVersion_Parse`, against `systemd 255 (255.4-1ubuntu8)` and garbage input.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** Run `go test ./internal/procspawn -run TestEverySpawnIsPlacedOrExempt` to prove that both spawns go through procspawn.
- [ ] **Step 4: Run** `go test -race ./internal/sessionbroker -run 'Systemd|LinuxDesktopUnit|LinuxUsername' && go test ./internal/procspawn` → PASS.
- [ ] **Step 5: Commit** `feat(agent): systemd-run spawner for the Linux desktop helper (#12117)`

### Task 2.4: Linux desktop helper manager (lifecycle)

**Files:**
- Create: `agent/internal/sessionbroker/linux_desktop_manager.go`, `linux_desktop_manager_linux.go`, `linux_desktop_manager_test.go`
- Modify: `agent/internal/sessionbroker/broker.go` (the session-closed callback notifies the manager), `agent/internal/heartbeat/heartbeat.go` (construct it on Linux only when `cfg.DesktopWaylandHelper`), `agent/internal/config/config.go`
- Leave `lifecycle_stub.go` unchanged. The Windows `HelperLifecycleManager` is keyed by a uint32 WTS session and is always-on or lease-driven, which is the wrong shape for on-demand logind sessions. See Open Decision 6.

**Interfaces:**
- Consumes: `IssueLinuxDesktopTicket`, `RevokeLinuxDesktopTickets` (1.3), `linuxDesktopSpawner` (2.3), `logindLookupFunc` (1.3), `EnsureLinuxDesktopListener` (2.2).
- Produces:
  ```go
  type LinuxDesktopHelperManager struct { /* mu; bySession map[string]*linuxDesktopEntry; nextGen uint64; deps */ }
  type linuxDesktopEntry struct { binding LinuxDesktopBinding; unit string; state linuxDesktopState; attempts int; nextAttempt time.Time; liveDesktops int }
  type linuxDesktopState int // idle, spawning, connected, stopping
  // OnHelperStopped is implemented in heartbeat: for every desktop session the
  // closed helper owned (desktopOwnerSession), call sendDesktopDisconnectNotification,
  // mark the start fence terminal (noteStop), and refuse further lease renewals.
  type LinuxDesktopHooks struct { OnHelperStopped func(s *Session, reason string) }
  func NewLinuxDesktopHelperManager(b *Broker, sp linuxDesktopSpawner, lookup logindLookupFunc, list func(context.Context) ([]DetectedSession, error), hooks LinuxDesktopHooks, now func() time.Time) *LinuxDesktopHelperManager
  func (m *LinuxDesktopHelperManager) Ensure(ctx context.Context, logindSessionID string) error // idempotent; returns ErrLinuxDesktop* sentinels
  func (m *LinuxDesktopHelperManager) Stop(ctx context.Context, logindSessionID, reason string)
  func (m *LinuxDesktopHelperManager) Run(ctx context.Context)              // reconcile every 5 s
  func (m *LinuxDesktopHelperManager) OnSessionClosed(s *Session)           // registered via broker lifecycle-closed callbacks
  func (m *LinuxDesktopHelperManager) BoundSession(logindSessionID string) *Session
  var ErrLinuxDesktopSessionNotEligible, ErrLinuxDesktopMultipleWaylandSessions, ErrLinuxDesktopSpawnBackoff error
  const linuxDesktopMaxAttempts = 3            // per Ensure demand
  var   linuxDesktopBackoff = []time.Duration{time.Second, 2 * time.Second, 4 * time.Second}
  ```
- State rules. The implementer writes the bodies, and the tests pin the outcomes.

  **`Ensure`**
  1. Look the session up in logind. It must pass `linuxDesktopSessionLive`.
  2. If the same uid has more than one live Wayland session, return `ErrLinuxDesktopMultipleWaylandSessions`. The portal is reached through the per-user bus and cannot be pinned to one session.
  3. If the entry is already `connected` with a live broker session, return nil.
  4. Otherwise: `gen = ++nextGen`, issue a ticket, `Start`, set state `spawning`.
  5. A failed `Start` increments `attempts` and schedules `nextAttempt` from `linuxDesktopBackoff`. A call before `nextAttempt` returns `ErrLinuxDesktopSpawnBackoff`. Once `attempts` reaches `linuxDesktopMaxAttempts`, `Ensure` returns the last error until the next `Ensure` after a reconcile sees the session change, or until 60 s pass.

  **Admission hook.** When the broker admits a session whose `LinuxDesktop.Generation` equals the entry's generation, set the entry to `connected` and reset `attempts`. A connecting helper whose generation is lower than the entry's is already refused by the ticket store, because its ticket was revoked.

  **`OnSessionClosed`**
  - It is a crash or exit when the closed session is the entry's bound one.
  - If `liveDesktops > 0` or a start is pending, respawn through `Ensure` under the backoff.
  - Otherwise go to `idle` and run `Stop` to collect the unit.

  **`Run` reconcile, every 5 s, for each entry**
  - Session missing, or `State` is `closing`: `Stop(reason "logout")`, which revokes tickets, closes the broker session, runs `systemctl stop` and forgets the entry.
  - `State != active`, from a fast user switch or a lock that moves the seat: send `desktop_stop` for each live desktop session on the bound helper with reason `session_inactive`, then `Stop`.
  - UID changed: `Stop`.

  **`Stop`** never relies on the helper cooperating, in this order:
  1. Revoke the ticket, then close the IPC session. The scope is gone at this point, and a surviving process cannot reconnect without a new ticket.
  2. Call `hooks.OnHelperStopped(session, reason)`. For each live desktop session hosted there, it reports the session ended to the API through `sendDesktopDisconnectNotification` (`heartbeat.go` ~2303), refuses further lease renewals for it, and marks it terminal at the start fence. The API then ends the viewer side, and TURN credentials are not renewed.
  3. Run `systemctl stop`.
  4. If the peer pid from the session's creds is still alive 5 s later, send SIGKILL, but only after re-checking that `/proc/<pid>` has the same uid and start time.

  A hostile helper can ignore `desktop_stop` and its own revocation lease, and its user manager can ignore a unit stop. Ending authorised viewing therefore rests on root revoking at the broker and the control plane ending the session (step 2), not on the helper exiting.

  **Retry budget.** Root owns it. Respawns triggered by one `Ensure` demand share `linuxDesktopMaxAttempts` and an overall deadline of `linuxDesktopEnsureDeadline = 30 * time.Second` from the first attempt. Nothing the helper sends resets the budget.

  **Idle expiry.** Root enforces it. An entry with `liveDesktops == 0` for `linuxDesktopHelperIdleExit` (5 min) is `Stop`ped, whether or not the helper exited on its own.

  **Pre-spawn build check.** `Ensure` returns `ErrLinuxDesktopAgentUpdatePending` when the SHA-256 of the on-disk agent executable differs from `Broker.selfExeHash`.

  **Orphan sweep.** On manager start, after an agent restart or crash, and for each user with a live user manager, list `breeze-desktop-helper-*` units and stop them. The list is `systemctl -M <user>@ --user list-units --plain --no-legend 'breeze-desktop-helper-*'`, bounded to 64 units.

  **Ambiguity re-check.** Each reconcile re-runs the "other graphical session for this uid" check. A newly ambiguous uid gets `Stop(reason "ambiguous_session")`.

  **Broker shutdown.** Stop every entry with a 5 s budget.

- [ ] **Step 1: Write failing tests** with a fake spawner, a fake lookup, a fake list and a fake clock:
  - `TestLinuxDesktopManager_EnsureSpawnsOnceConcurrently`: 20 goroutines and 1 `Start`.
  - `TestLinuxDesktopManager_EnsureRejectsInactiveX11RemoteGreeter`
  - `TestLinuxDesktopManager_MultipleWaylandSessionsRefused`
  - `TestLinuxDesktopManager_CrashRespawnsWithBackoff`: attempts at +1 s, +2 s, +4 s, then it stops.
  - `TestLinuxDesktopManager_IdleExitDoesNotRespawn`
  - `TestLinuxDesktopManager_SessionGoneStopsHelper`
  - `TestLinuxDesktopManager_InactiveSessionEndsLiveDesktop`
  - `TestLinuxDesktopManager_RespawnRevokesOldTicket`
  - `TestLinuxDesktopManager_StopDoesNotNeedHelperCooperation`: the fake helper ignores `desktop_stop`, and the session is still closed and the ticket revoked.
  - `TestLinuxDesktopManager_ShutdownStopsAll`
  - `TestLinuxDesktopManager_StopNotifiesAPIAndDeniesRenewals`
  - `TestLinuxDesktopManager_RetryBudgetNotResetByHelperTraffic`
  - `TestLinuxDesktopManager_RootIdleExpiry`: the fake helper never exits, and it is stopped at 5 min.
  - `TestLinuxDesktopManager_UpdatePendingRefusesSpawn`
  - `TestLinuxDesktopManager_OrphanSweepOnStart`
  - `TestLinuxDesktopManager_NewSecondSessionStopsHelper`
- [ ] **Step 2: Run** `go test -race ./internal/sessionbroker -run LinuxDesktopManager` → FAIL.
- [ ] **Step 3: Implement.** Wire construction in `heartbeat.go` behind `runtime.GOOS == "linux" && cfg.DesktopWaylandHelper`, and start `Run` with the agent's context.
- [ ] **Step 4: Run** → PASS (`-race -count=3`).
- [ ] **Step 5: Commit** `feat(agent): on-demand lifecycle for the Linux desktop helper (#12117)`

**W2 ships:** With `desktop_wayland_helper: true` and a manual `Ensure`, which a test-only debug command may expose in dev builds only, the helper starts in the user's session, authenticates and idles. With the flag off nothing changes, because the manager is never constructed.

---

## Wave W3 — Route Wayland starts to the helper, and the capture seam (still `wayland_unsupported`)

### Task 3.1: Routing decision

**Files:**
- Create: `agent/internal/heartbeat/linux_desktop_route.go`, plus a test
- Modify: `agent/internal/heartbeat/handlers_desktop.go` (~336), `agent/internal/heartbeat/handlers_desktop_helper.go` (`spawnHelperForDesktop` Linux branch, `findActiveHelper` Linux selection)

**Interfaces:**
- Produces:
  ```go
  type linuxDesktopRouteKind int // routeDirectX11, routeHelper, routeUnsupported
  func linuxDesktopRoute(flag bool, active *sessionbroker.DetectedSession, hasManager bool) linuxDesktopRouteKind // pure
  ```
- The routing table:

  | Condition | Route | Effect |
  |---|---|---|
  | `!flag` | `routeDirectX11` | Today's path, including today's Wayland error |
  | Active seat session `LogindType == "x11"` | `routeDirectX11` | Byte-for-byte unchanged |
  | `"wayland"` and a manager exists | `routeHelper` | — |
  | Anything else | `routeDirectX11` | Today's behaviour |

- `handlers_desktop.go`: the guard becomes `(... && runtime.GOOS != "linux") || h.linuxRouteIsHelper()`, which sends the start into `startDesktopViaHelper`.
- In the Linux branch of `spawnHelperForDesktop`, `routeHelper` calls `manager.Ensure(ctx, activeLogindID)`. Every other route still returns `ErrLinuxDesktopHelperUnsupported`.
- On Linux, `targetSession` means a logind session id. `findActiveHelper` on Linux returns `manager.BoundSession(id)` only if the bound session `HasScope("desktop")` and `CanCapture`.
- The `OnSessionStopped` / `OnClipboardSummary` registration at `heartbeat.go` ~1609 stays. It is inert for helper-hosted sessions, whose disconnects arrive over IPC as on macOS.

- [ ] **Step 1: Write failing tests:**
  - `TestLinuxDesktopRoute_Table`: every row above.
  - `TestStartDesktop_LinuxX11UnchangedWithFlagOn`: the existing direct-start test runs with the flag on, and asserts `desktopMgr.StartSession` was called and the helper path was not.
  - `TestStartDesktop_LinuxWaylandFlagOffUnchanged`
  - `TestSpawnHelperForDesktop_LinuxWaylandCallsEnsure`
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `go test -race ./internal/heartbeat -run 'LinuxDesktopRoute|StartDesktop_Linux|SpawnHelperForDesktop'` → PASS. Run the existing `handlers_desktop_helper_*_test.go` in one batch.
- [ ] **Step 5: Commit** `feat(agent): route Wayland desktop starts to the Linux helper behind a flag (#12117)`

### Task 3.2: Desktop access stays honest

**Files:**
- Modify: `agent/internal/heartbeat/desktop_access_linux.go`, plus `desktop_access_linux_test.go`

- Rule: the X11 branch is unchanged. For `x11.ErrWaylandUnsupported`, return `user_session` **only if** the flag is on and `manager.BoundSession(active)` reports `CanCapture`. Otherwise keep `wayland_unsupported`. The heartbeat must not spawn a helper just to answer the probe.
- [ ] **Step 1: Write failing tests:**
  - `TestComputeDesktopAccess_WaylandNoBackendStaysUnsupported`
  - `TestComputeDesktopAccess_WaylandCapableHelperIsUserSession`
  - `TestComputeDesktopAccess_X11Unchanged`
- [ ] **Step 2–4:** Fail, then implement, then pass (`go test -race ./internal/heartbeat -run ComputeDesktopAccess`).
- [ ] **Step 5: Commit** `feat(agent): report Wayland desktop access from the bound helper (#12117)`

### Task 3.3: The capture seam (#11841 plugs in here)

**Files:**
- Create: `agent/internal/remote/desktop/session_backend.go`, plus a test
- Modify: `agent/internal/remote/desktop/capture_linux.go` (`newPlatformCapturer`), `session_webrtc.go` (~121, input handler construction)

**Interfaces:**
- Produces:
  ```go
  // SessionBackend opens one capture source and its matching input sink as a
  // pair (a portal RemoteDesktop session owns both). Registered only by the
  // Linux desktop-helper process; the root agent never registers one.
  type SessionBackend interface {
      Open(ctx context.Context, cfg CaptureConfig) (BackendSession, error)
      Probe(ctx context.Context) error // unprivileged; nil = can capture
  }
  type BackendSession interface {
      Capturer() ScreenCapturer
      Input() InputHandler
      // Done is closed when the source ends on its own (portal revoked,
      // compositor gone); Err then reports why. ErrShareStopped for a user revoke.
      Done() <-chan struct{}
      Err() error
      Close() error
  }
  func RegisterSessionBackend(b SessionBackend)   // panics if called twice
  func SessionBackendRegistered() bool
  // Root-side truth about this build (helper and root are the same binary).
  // false until W4 adds the wayland package; W4 flips it in the same PR.
  const WaylandBackendCompiled = false
  var ErrShareStopped = errors.New("desktop share stopped by the user")
  ```
- Behaviour:
  - When a backend is registered, `newPlatformCapturer` on Linux and the input construction in `session_webrtc.go` use one `BackendSession` per desktop session.
  - `Done()` ends the WebRTC session. The helper then sends `desktop_peer_disconnected` with reason `share_stopped` when `Err()` is `ErrShareStopped`, or `capture_ended` otherwise.
  - Without a backend, both paths are byte-for-byte today's X11 code.
  - The helper calls `RegisterSessionBackend` from `runHelperProcess` on Linux only. In W3 nothing registers one, so `CanCapture` stays false and Wayland stays `wayland_unsupported`.
  - Root wires `Broker.linuxWaylandCaptureAuthorized` to `cfg.DesktopWaylandHelper && desktop.WaylandBackendCompiled`. This is the authoritative clamp from Task 1.4: even a helper that claims `CanCapture=true` is clamped to false in W3.
- [ ] **Step 1: Write failing tests** with a fake backend:
  - `TestSessionBackend_UsedWhenRegistered`
  - `TestSessionBackend_DoneEndsSession`
  - `TestSessionBackend_NotRegisteredUsesX11Path`
  - `TestRegisterSessionBackend_Twice_Panics`
  - `TestRootAgentNeverRegistersBackend`: assert that `agentapp.runAgent`'s import graph has no `RegisterSessionBackend` call site. Use a source-scan test in the style of `TestEverySpawnIsPlacedOrExempt`.
- [ ] **Step 2–4:** Fail, then implement, then pass (`go test -race ./internal/remote/desktop -run SessionBackend`).
- [ ] **Step 5: Commit** `feat(agent): session backend seam for Linux desktop-helper capture (#12117)`

**W3 ships:** The routing and the seam exist. Wayland still reports `wayland_unsupported`, because nothing registers a backend. X11 is unchanged.

---

## Wave W4 — Wayland capture inside the helper (rebase of #11841)

The contributor owns this wave. If they decline, we port it with credit. It is not part of #12117, and it is listed here so the seam is unambiguous.

### Task 4.1: Port #11841 onto the seam

The pieces move as follows:

| From #11841 | Becomes |
|---|---|
| `portal_linux.go` (handshake, keysym, pointer, axis input) and `helper_linux.go` (gst pipeline) | `agent/internal/remote/desktop/wayland`, implementing `SessionBackend` / `BackendSession` |
| Capture and input | Run **in the helper process**, which is already on the user's session bus. The PipeWire fd from `OpenPipeWireRemote` stays in the helper. |
| gst output | Should produce raw frames (`video/x-raw,format=BGRx`) for the existing encoder rather than JPEG. Decode, if any, stays in the helper. |
| `session_linux.go` (`startPipe`, the `live` singleton, the stdout framing, the stdin JSON) | Deleted. The broker IPC replaces it. |
| `user_linux.go` session lookup | Replaced by the manager (Task 2.4). |
| The probe | Becomes `SessionBackend.Probe`, run unprivileged in the helper. `busctl` and the plugin check run as the user. The root heartbeat no longer runs them. |
| `agentapp/main.go` `wayland-capture` subcommand | Deleted. The helper registers the backend in `runHelperProcess` on Linux. |
| `go.mod` `godbus/dbus/v5` | Kept. |

- Tests: carry over `frame_test` if frames are still parsed, plus `keys_test` and `input_linux_test`. Add `TestWaylandBackend_PortalCancelIsShareStopped` and `TestWaylandBackend_ProbeRunsWithoutRoot` (the fake bus).

### Task 4.2: Flip `CanCapture`

Set `desktop.WaylandBackendCompiled = true` in the same PR that adds the backend. `detectCapabilities` on Linux sets `CanCapture` from `SessionBackend.Probe`, and root's clamp now lets that claim through, but only while the flag is on. Desktop access then reports `user_session` for an eligible Wayland session while the flag is on.

### Task 4.3: Lab leg (gate before the flag defaults on)

Run this on GNOME (Ubuntu 24.04 or newer) and KDE Plasma 6 (Fedora KDE or Kubuntu), both on Wayland, as a non-admin user who was **not** logged in when the agent was installed. Record:

1. The `systemd-run --version` that works, which sets `linuxSystemdMinVersion`.
2. Whether `WAYLAND_DISPLAY` / `DBUS_SESSION_BUS_ADDRESS` are already present in the user manager environment, or come only from our `--setenv`.
3. Ticket admission succeeds, and the scopes are `["desktop"]`.
4. The portal dialog appears and both accept and cancel behave correctly. Cancel shows up as `share_stopped`.
5. Logout during a live session: the helper unit is gone within 10 s, and `systemctl --user list-units 'breeze-desktop-helper-*'` is empty.
6. Fast user switch to a second user: the live session ends with `session_inactive`.
7. Killing the helper mid-session respawns it within the backoff, and the viewer reconnects.
8. A second user running `breeze-agent desktop-helper` by hand with a copied ticket is rejected: the ticket is consumed, or the listener uid does not match.
9. With the flag off, the box behaves as `origin/main`.

The `--pipe`/fd-passing question from #11841 does not apply, because the design never passes fds across `-M`. Record that it was not needed.

---

## Threat model

**Assumption:** a hostile local user fully controls their own user manager (env, `LD_PRELOAD`), and therefore controls the helper process after the broker's exe-hash check passes. The hash and path check proves which binary was *started*, not what the process *does*. Every grant to a Linux desktop helper must be safe to hand to that user, and every claim it makes is an assertion, not a fact.

| Root accepts | Bound | Where enforced |
|---|---|---|
| A connection on the per-UID listener | Kernel uid must equal the listener uid, checked before any byte is read. At most 2 concurrent handshakes per uid. Handshake deadline, rate limit and quota as today. Ticket-only endpoint. | 2.2, existing |
| `auth_request`, on any socket | ≤ 64 KiB pre-auth cap, checked before allocation, on every platform. | 1.4 |
| A ticket | Valid, single-use, ≤ 20 s old, for that logind session and the kernel uid (nonzero). The session must be explicitly active, Wayland, local, class `user`, the only graphical session for the uid, and logind must answer completely. The peer must be the daemon's own running build. | 1.2, 1.3 |
| Messages after auth | ≤ 256 KiB each, checked before allocation. A frame must complete within 10 s. Only the Task 1.4 allowlist is accepted. Three strikes disconnect. | 1.4 |
| Correlated command responses | Must match a pending command id. ≤ 128 KiB. | 1.4 |
| SDP answer and ICE candidates | Size and count caps. Root stamps its own start generation. Each is bound to the connection, desktop session and generation. Messages for a terminal desktop session are dropped. | 1.4 |
| Capabilities | `CanCapture` is clamped by root (flag and build). Notify, tray and clipboard are forced false. | 1.4, 3.3 |
| Lease renewals | Rate-limited. Refused after `Stop`. The control plane remains the lease authority. | 1.4, 2.4 |
| Log lines | Existing relay cap. | existing |
| Liveness | 45 s keepalive. Root-enforced 5 min idle expiry. | existing, 2.4 |

**Root never** does any of the following:
- decodes media from the helper;
- executes a path or argument the helper names;
- opens a file the helper names;
- trusts `authReq.UID`, `Username`, `DisplayEnv`, `LogindSessionID`, a helper-supplied generation, or a capability claim without its own cross-check;
- routes `run_as_user`, notify, clipboard, consent, prompt or SAS traffic to this helper.

Root still relays attacker-influenced SDP and ICE strings to the API and the viewer. They are bounded here, and the API and viewer validators remain responsible for parsing them.

**Wrong-UID peer.** The listener's file mode is advisory, because the owning user can chmod it. What refuses the peer is the kernel uid check before any read, and then the ticket's uid check.

**Replay.** A ticket is consumed on first use, even when the attempt fails. Issuing a new ticket revokes the older one for that session. A stale-generation ticket is rejected. At the message level, ownership is checked as (connection instance, desktop session, root generation). The IPC HMAC and sequence number do not stop an authenticated peer from re-sending meaningful messages, so the message-level check is what does.

**Uncooperative helper.** A helper can ignore `desktop_stop` and its own revocation lease, and its user manager can ignore a unit stop. Root does not depend on any of them:
- It closes the broker session.
- It refuses renewals.
- It reports the session ended to the API, which ends the viewer and stops renewing TURN credentials.
- It kills the pid after verifying its uid and start time.

**Same-UID impostor.** A process running as the same user can race the legitimate helper for the ticket. That is accepted. The ticket authorises a uid to represent a session; it is not proof that the process belongs to that graphical session. The same user can already observe and control their own desktop. The outcome is bounded to that user's own desktop, and any technician input sent to a compromised account's session is already exposed to that account. This matches the macOS helper's trust model, and the PR documents it.

**Exposure accepted for the helper:** short-lived, session-scoped TURN credentials and the viewer's SDP and ICE, as on macOS.

---

## CI traps

- `TestEverySpawnIsPlacedOrExempt` (`internal/procspawn/spawn_contract_test.go`): use `procspawn.CommandContext` for `systemd-run`, `systemctl` and `loginctl`. Setting `SysProcAttr` after `Command` requires `procspawn.Prepare` again. None is needed here.
- **Lint Agent:** run `GOOS=linux golangci-lint run ./...` from `agent/` for `_linux.go` files on a macOS dev host. Run `gofmt` on all new files.
- Tests in `_linux.go` files run only on CI Linux (Test Agent). Keep the decision logic in untagged files so dev hosts cover it.
- `go test -race` per package, in batches, with `-timeout 600s`. Never run the whole agent suite in one go on a loaded host.
- Root-only tests (socket chown) must `t.Skip` when `os.Geteuid() != 0`. CI is non-root, so pure checks carry the coverage.
- `TestAdmitLinuxDesktopHelper_DarwinUnchanged` and the existing `scopesForRole` tests protect the macOS grant.
- The pre-auth cap is global. Run the whole `internal/sessionbroker` and `internal/userhelper` packages, in batches, before opening the W1 PR.

## Open Decisions

**Advisor quorum.** My position was formed first. Codex (`codex exec -s read-only`, reasoning effort `xhigh`) then gave an independent read in two passes. **Codex agreed with the architecture overall.** It disagreed partly on two points, D6 (bounds) and D8 (sessions and shutdown). Both are resolved below and folded into the tasks. It initially preferred a separate Linux binary, then withdrew that once shown that `breeze-agent desktop-helper` already exists and that the ticket, not the path, grants the scope.

1. **Helper binary.**
   - Choice: re-exec `<verified agent exe> desktop-helper`, which already exists, or ship `breeze-desktop-helper` for Linux (release, install, updater and rollback work).
   - **Recommend re-exec.**
   - *Codex: agreed after the follow-up.* It could name no attack that a separate filename stops under the ticket design. Its condition was that admission must bind to the running daemon's build hash, and that is now in Task 1.3.
2. **Socket reachability.**
   - Choice: a per-UID, ticket-only listener (Task 2.2), or `breeze` group membership. Group membership goes stale for user managers started before `usermod`.
   - **Recommend a per-UID listener.**
   - *Codex: agreed.* It preferred this over group repair, abstract sockets or fd passing. Its additions are folded in: uid checked before the auth read, a ticket-only endpoint, fail-closed creation, and closing live sessions on teardown.
3. **More than one graphical session for a uid.**
   - **Recommend refuse**, for any mix of X11 and Wayland, and re-check during operation.
   - *Codex: modified.* It extended the rule from "Wayland only" to "any type". That is adopted.
   - A distinct API reason string, such as `wayland_ambiguous_session`, is a W4 decision. Until then the device reports `wayland_unsupported`.
4. **Fast user switch.**
   - **Recommend ending the live session and stopping the helper.** The next start respawns it in about 1 s.
   - *Codex: agreed.* It added that root must revoke at the broker and the control plane, because the helper may ignore the stop. That is folded into Task 2.4.
5. **Pre-auth receive cap.**
   - **Recommend 64 KiB on every connection, before allocation, in W1.**
   - *Codex: agreed, and pushed for it. It is no longer optional.* It is a global behaviour change, so Todd should note it.
6. **Lifecycle home.**
   - Choice: a new Linux on-demand manager, or generalising `HelperLifecycleManager` (uint32 WTS keys, SCM-driven).
   - **Recommend a new manager.** `lifecycle_stub.go` stays for darwin.
   - *Codex: agreed (D9),* with retry budgets and idle expiry owned by root. That is adopted.
7. **Flag default.** `desktop_wayland_helper` stays off until the W4 lab leg passes on GNOME and KDE. **Todd decides when it flips.**
8. **Follow-ups outside #12117.** Each should be filed as a separate issue:
   - (a) A Linux peer claiming `role=user` with no ticket still gets `userHelperScopes`, including `run_as_user`, on the shared socket.
   - (b) For macOS helpers, root forwards the helper-supplied start generation on ICE trickle (`desktop_ice_trickle.go` ~85). Task 1.4 fixes this for Linux only.

   **Recommend filing both.**

## Execution

Waves W1 to W3 are ours. Run them subagent-driven, task by task. W1 (auth) and W2 (process spawn) each get one independent review round. W4 is the contributor's rebase of #11841, or our port with credit.
