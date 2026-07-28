# RDS Per-Session Helpers — On-Demand Lifecycle Design

**Date:** 2026-07-28
**Status:** Approved design, pre-implementation
**Branch:** `ToddHebebrand/multiple-user-helpers`

## Problem

On an RD Session Host, the Windows agent spawns two Go `breeze-user-helper.exe` processes per active session (`system` + `user` role), retains a SYSTEM helper indefinitely for every disconnected RDP session, and the Assist manager spawns a Tauri `breeze-helper.exe` per session on top. At 50 concurrent users that is ~150 processes — and most do nothing, because `run_as_user` delivery (`broker.go:1049-1110`) and `assist` authentication (`broker.go:2452`) are console-gated. Meanwhile the console gates block capabilities MSPs actually want on terminal servers: shadowing a user's RDP session and running scripts as an RDP user.

## Goals (phase 1)

1. **Shadow/capture a specific RDP session** from the remote-desktop flow.
2. **`run_as_user` targeted at a specific session** instead of silently falling back to SYSTEM.
3. **On-demand helper spawning on RDS hosts**: zero per-session helpers at rest; spawn when a session is targeted, reap when idle.
4. Workstation behavior **unchanged**.

Deferred to later phases: per-session PAM elevation dialog, Assist (Tauri) helper in RDP sessions.

## Phase 0 — cleanups (independently shippable, land first)

These fix waste that exists on `main` today and shrink the surface the new lifecycle touches:

1. **Assist manager stops spawning into non-console sessions.** Helpers launched into RDP sessions are rejected at auth (`broker.go:2452`) anyway — spawn only where auth can succeed (`agent/internal/helper/manager.go:248-300`).
2. **Disconnected-RDP SYSTEM-helper retention gets an idle cap.** Today `helper_key.go:37` retains the SYSTEM helper for a disconnected RDP session forever; on terminal servers disconnected sessions linger for days. Add a retention timeout (reap after the session has been disconnected ~10 min; the lease path in phase 1 re-spawns on demand).
3. **`run_as_user` console gate fails loudly.** The silent SYSTEM fallback in `broker.go:1049-1110` becomes a hard, typed error ("no eligible session for user-context execution") until session targeting ships, then merges into the routing rules below.

## Architecture (approach: lease-driven desired-set)

The existing sessionbroker lifecycle — reconcile loop (30s + SCM events), spawn registry, exponential backoff, fatal cooldown, startup timeout, and the #2536 RDS job-object fallback — is retained unchanged. Only the **desired-set computation** (`lifecycle_core.go:179-197`) becomes mode-dependent.

### RDS detection

At broker start: `OSVERSIONINFOEXW.wSuiteMask & VER_SUITE_TERMINAL && !(wSuiteMask & VER_SUITE_SINGLEUSERTS)` → RDS mode. A server-driven mode override (`auto | always-on | on-demand`, default `auto`) can force either lifecycle. The resolved mode is reported in the heartbeat so the web UI knows to show session pickers.

### Lease table

The broker maintains an in-memory lease table `{sessionID, role, expiresAt}`, mutated under the broker's existing lock:

- Remote-desktop connect targeting session N → `system`-role lease.
- Script targeted at session N → `user`-role lease.
- Leases renew while the WebRTC connection or script is live; released leases expire ~2 min later and reconcile reaps the helper.
- Session logoff removes leases and stops helpers immediately (existing SCM logoff path).

On RDS, `computeDesiredHelpers` reads the lease table instead of enumerating all sessions. On workstations it behaves exactly as today.

### Spawn-and-wait

The command path acquires a lease, triggers reconcile, and blocks until the helper reaches IPC-ready or the existing 90s startup budget (`helperStartupTimeout`) expires, then returns a clean error to the tech.

## Capture, routing, consent

- **Capture:** the `system`-role helper already binds to its session via `SetTokenInformation(TokenSessionId)` at spawn — a helper spawned into session N captures session N. Work is plumbing: RD connect payload gains optional `targetSessionId` (web → API → agent command), which drives the lease, and the broker routes capture/input to helper key `(N, system)` instead of implicitly-console.
- **`run_as_user`:** script commands gain the same optional `targetSessionId`, routed to that session's `user`-role helper. Routing rules: explicit target → route there; no target on RDS → hard error; no target on workstation → console (today's behavior).
- **Consent:** policy level `silent | notify | ask-first`, default `notify`, implemented in the target session's `system`-role helper (owns desktop scope). `notify` = persistent on-screen banner while shadowed. `ask-first` = accept/decline prompt before the stream starts; no answer in 30s = deny. Level delivered via the existing `HelperSettings` heartbeat path.

## API / web / policy

- **`enumerate_sessions` device command:** exposes the WTS detector's data (user, session id, state, protocol, idle time) over the existing command round-trip. Fetched live when a dialog opens; nothing persisted.
- **UI:** RD connect and run-script dialogs show a session dropdown only when the device heartbeat reports RDS mode; non-RDS devices see zero change. Mutations wrapped in `runAction`.
- **Policy:** consent level and mode override are new fields on the existing `HelperSettings` config-policy feature (resolved server-side in `apps/api/src/routes/agents/helpers.ts` `buildHelperConfigUpdate`, delivered via heartbeat). No new table, no new RLS/tenancy work; partner-wide by nature of the existing policy hierarchy.

## Error handling

- Spawn timeout → typed error surfaced in the tech's dialog ("helper failed to start in session X").
- `ask-first` declined or timed out → "user declined" error.
- Mid-stream helper death or session logoff → existing keepalive/evict (30s ping / 45s evict) tears down the stream; lease released.
- Lease table under broker lock; reconcile reads a snapshot — no new concurrency surface.

## Testing

- **Unit (Go):** lease TTL/renewal/expiry, desired-set-from-leases vs workstation mode, suite-mask detection parsing, `targetSessionId` routing, consent-level gating, phase-0 retention cap.
- **Windows integration:** extend `agent/internal/sessionbroker/rds_lifecycle_integration_test.go` with on-demand spawn/reap cycles.
- **API/web (Vitest):** command schema validators; dialog render with/without the RDS heartbeat flag.
- **Manual release gate:** multi-session verification on the RDS rig (no RDS box in CI) — shadow with each consent level, targeted script execution, idle reap, disconnected-session retention cap.

## Out of scope

Per-session PAM elevation, Assist helper in RDP sessions, on-demand lifecycle for workstations (possible later behind the `always-on`/`on-demand` override), session log-off/management actions in the UI, VDI products that don't set `VER_SUITE_TERMINAL` (covered by the manual mode override).
