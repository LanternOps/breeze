# RDS Per-Session Helpers — On-Demand Lifecycle Design

**Date:** 2026-07-28 (rev 2, post codex review)
**Status:** Approved design, pre-implementation
**Branch:** `ToddHebebrand/multiple-user-helpers`

## Problem

On an RD Session Host, the Windows agent spawns two Go `breeze-user-helper.exe` processes per active session (`system` + `user` role), retains a SYSTEM helper indefinitely for every disconnected RDP session, and the Assist manager spawns a Tauri `breeze-helper.exe` per session on top. At 50 concurrent users that is ~150 processes — and most do nothing, because `run_as_user` delivery and `assist` authentication (`broker.go:2452`) are console-gated. Meanwhile the console gates block capabilities MSPs actually want on terminal servers: shadowing a user's RDP session and running scripts as an RDP user.

## Goals (phase 1)

1. **Shadow/capture a specific active RDP session** from the remote-desktop flow. Disconnected sessions are not shadowable (no input desktop to capture — `detector_windows.go:315`); the picker shows them as unavailable.
2. **`run_as_user` targeted at a specific session** with honest failure semantics.
3. **On-demand helper spawning on RDS hosts**: zero per-session helpers at rest; spawn when a session is targeted, reap when idle.
4. Workstation behavior **unchanged**.

Deferred to later phases: per-session PAM elevation dialog, Assist (Tauri) helper in RDP sessions.

## What already exists (reuse, don't rebuild)

Codex review established that more plumbing exists than the rev-1 spec assumed:

- **Desktop `targetSessionId` is already end-to-end:** API validator (`apps/api/src/routes/remote/schemas.ts:28`), API forwarding (`remote/sessions.ts:925`), viewer protocol (`apps/viewer/src/lib/protocol.ts:83`), agent routing (`handlers_desktop_helper.go:111`). Phase 1 adds a *UI picker* and RDS-strict semantics, not new transport.
- **`list_sessions` device command exists** (`handlers_desktop.go:97,284`) but has no API/web caller and its result lacks idle time (`ipc/message.go:384`). Extend it; do not add a new `enumerate_sessions`.
- **Exact-session `run_as_user` delivery exists in the broker:** `FindUserSession` (`broker.go:1417`), per-session selection (`broker.go:1445`), `LaunchProcessViaUserHelperForSession` (`broker.go:1519`). The gap is only that the script command/API/UI carry no session target (`handlers_script.go:23`, `apps/api/src/routes/scripts.ts:200`, `ScriptPickerModal.tsx:25`).
- **Consent policy exists:** `config_policy_remote_access_settings` (`configurationPolicies.ts:314`) with `sessionPromptMode off | notify | consent`, technician identity level, and timeout, resolved per remote connection (`apps/api/src/routes/remote/helpers.ts:409,525`). Phase 1 does NOT add consent fields to `HelperSettings` — that would create two policy sources. The work is agent-side *routing*: delivering the prompt/banner to the target session.

## Phase 0 — cleanups (independently shippable, land first)

1. **Assist manager stops spawning into non-console sessions.** Decision point is the Windows enumerator (`agent/internal/helper/enumerator_windows.go:16`), which currently accepts all active/connected sessions; helpers launched off-console are rejected at auth (`broker.go:2452`). Update `manager_test.go:184` expectations. Two residual launch paths must be covered in the same PR: the legacy **HKLM Run** value (removed only under one-time migration conditions, `migrate.go:65`, `manager.go:215` — make removal unconditional on hosts where the manager filters) and any doc/behavior implications of that removal.
2. **Disconnected-RDP SYSTEM-helper retention gets an idle cap.** Requires tracking a disconnected-since timestamp — `DetectedSession` has none (`detector.go:29`), so a stateless predicate in `helper_key.go` would re-add the key every reconcile. Add transition tracking in the lifecycle manager; reap after ~10 min disconnected. (Phase 1 re-spawns on demand.)
3. **`run_as_user` failure semantics made honest.** Correction from rev 1: when no console helper exists, execution does NOT silently run as SYSTEM — the handler logs a misleading "downgrading to SYSTEM" message (`handlers_script.go:52-72`) and the executor then rejects with `runAs=user requires a connected user helper session` (`executor.go:348`, pinned by `handlers_script_test.go:219`). Phase 0 fixes the misleading log and surfaces a typed, early error naming the eligible sessions.

## Architecture (approach: lease-driven desired-set)

The reusable machinery: the desired-map reconcile tail (`lifecycle_core.go:220-265`), spawn registry, retry/backoff bookkeeping, fatal cooldown, startup timeout, and the #2536 job-object fallback (`spawner_windows.go:274`). The following pieces are mode-dependent and must change — the rev-1 claim that *only* the desired-set function changes was too strong:

### RDS detection & mode

At broker start: `OSVERSIONINFOEXW.wSuiteMask & VER_SUITE_TERMINAL && !(wSuiteMask & VER_SUITE_SINGLEUSERTS)` → RDS mode. Server-driven override (`auto | always-on | on-demand`, default `auto`) delivered via the helper config-policy feature's JSONB (`configurationPolicies.ts:98` — storage fits; the transport does not, see Policy section). The resolved mode is reported agent→server in a **new heartbeat payload field** (none exists today — `heartbeat.go:79`, `agents/schemas.ts:155`) so the UI knows to show session pickers. On-demand mode only applies where the proactive lifecycle runs today (Windows service mode, `heartbeat.go:643,1027`).

### Lease table

Owned by the **lifecycle manager under its own `m.mu`** — not the broker lock, to preserve the existing lock order (reconcile holds `m.mu` while publishing desired keys into broker state, `lifecycle_core.go:230`; broker-lock-held reconcile triggers would invert it).

Lease shape: `{sessionID, userSID, role, ownerOpID, expiresAt}`:

- **`userSID` binding:** acquisition validates the target session against a fresh WTS snapshot and records the session's user; a lease is invalid if the session ID has been reused by a different user (Windows recycles WTS session IDs after logoff).
- **`ownerOpID` refcount:** each operation (remote-desktop connection, script run) holds its own reference; release decrements, and the helper is reaped ~2 min after the last reference drops. Prevents one tech's disconnect from tearing down a helper another tech's script is using. Script cancellation/list-running (`handlers_script.go:112`) resolves the target helper via the lease's ownerOpID rather than broadcasting.
- **Desired set on RDS** = leases **intersected with the current WTS enumeration** (session exists, same user SID, state Active). Intersection — not leases alone — restores the "detector catches up" safety property that covers dropped SCM events (`service_windows.go:237`).

### SCM event handling (mode-aware)

The handlers at `lifecycle.go:97-121` encode always-on semantics. In on-demand mode: logoff/terminate invalidates all leases for that session (typed error to any in-flight waiter); disconnect invalidates `system`-role leases (the session is no longer shadowable) and ends any live shadow stream; logon/connect events do not spawn anything.

### Spawn-and-wait (new lifecycle API)

The command path acquires a lease and calls a new operation-level wait API. Two confirmed gaps it must close:

1. **Readiness ≠ authenticated.** The lifecycle marks a helper connected at auth (`lifecycle_core.go:478`) but capabilities (`CanCapture`) arrive on a later message (`client.go:124` → `broker.go:2733`). The waiter completes only on *capabilities received*.
2. **Typed failure, not timeout.** Registry reservation silently refuses starts during fatal cooldown / retry exhaustion / backoff / unknown liveness (`lifecycle_registry.go:69-109`) with no surfaced signal. The wait API returns typed states (`spawning | ready | fatal-cooldown(until) | retries-exhausted | session-gone`) so the tech sees the real reason instead of a 90s hang. Existing desktop demand-wait is 10s (`handlers_desktop_helper.go:344`); the RDS path uses the lifecycle's 90s budget with progress signaling.

### Interaction with the logon scheduled task

The installer registers `\Breeze\AgentUserHelper` to launch a helper at every logon (`install-windows.ps1:77`). In on-demand mode that helper has no desired key, is rejected by admission (`broker_admission.go:97`), and today would exit fatally (`agentapp/main.go:1692`) and retry per task settings. On-demand mode requires a distinct admission answer ("not currently desired — exit cleanly, no retry") so RDS hosts don't run a logon-triggered crash loop per user.

## Capture, routing, consent

- **Capture:** validated — for an *active* session the capture stack has no console dependency: token bound via `SetTokenInformation(TokenSessionId)` (`spawner_windows.go:381`), `winsta0\Default` (`:394`), capture/input attach to the input desktop (`prepare_capture_windows.go:7`, `input_windows.go:485`), WebRTC is helper-local. Three targeting fixes ship with phase 1:
  - The issue-#434 fail-open (target session vanished → silently fall back to any capable helper, `handlers_desktop_helper.go:204`) becomes strict when the request carries an explicit target on an RDS host: fail closed with "session ended". Workstation fallback behavior is preserved.
  - Exact-target selection must apply the disconnected-session filter (today it accepts a capable helper before filtering — `broker.go:1348` vs `:1369`).
  - The GDI capture fallback's `nil` frame + `nil` error (`capture_windows_nocgo.go:276`) must become an error so a non-capturable session fails the probe (`session_webrtc.go:267`) instead of answering with a black stream.
- **`run_as_user`:** add `targetSessionId` to the script command schema, API (`scripts.ts:200`), and run dialog; the broker delivery path already supports exact-session execution. Routing rules: explicit target → that session's `user`-role helper (lease-spawned); no target on RDS → typed error listing eligible sessions; no target on workstation → console (today's behavior).
- **Consent:** reuse `config_policy_remote_access_settings` (`sessionPromptMode off | notify | consent`) — no new consent policy surface. Agent-side changes: the consent gate currently picks a single global preferred consent helper (`consent_gate.go:85,160`) and runs before target selection (`handlers_desktop.go:164`); on RDS it must resolve the consent UI *in the target session*. Since `system`-role helpers lack `consent_ui` scope (`broker.go:210`), either grant the target session's SYSTEM helper a scoped consent capability or spawn the consent prompt through it — decided at plan time; the invariant is: the user being shadowed is the one who sees the prompt/banner.

## Policy plumbing (and two pre-existing bugs to fix en route)

The mode override rides the existing `helper` config-policy feature, but the transport is closed at five Assist fields end-to-end — API resolver (`helpers.ts:2490`), response type (`heartbeat.ts:948`), Go decoder (`heartbeat.go:149`), application (`heartbeat.go:3541`), Tauri settings (`manager.go:23`) — and configures only the Tauri Assist manager. Phase 1 extends each hop and gives the sessionbroker lifecycle a settings-update path (its controller interface is currently `Stop`/`Done` only, `heartbeat.go:163`).

Pre-existing defects in this exact path, confirmed by review, fixed as part of the plumbing work:

1. **Partner-owned helper policies never resolve:** the resolver requires `configurationPolicies.orgId = device.orgId` (`helpers.ts:2472`), but partner-owned policies have `orgId = NULL`. Violates the partner-wide-first contract; fix with the dual-axis condition.
2. **Explicit disabled policy overridden by legacy org fallback:** `!settings.enabled` falls through to org-level settings (`helpers.ts:2521`).
3. Cache note: resolved settings are cached 120s (`helpers.ts:2500`) — new fields lag up to one cache window; acceptable, documented.
4. **RLS gap:** `config_policy_remote_access_settings` child-table policies are org-only (`2026-06-19-remote-session-consent-settings.sql:29`) and were not updated by the partner-ownership migration — partner-owned consent policies are invisible under RLS. New migration adds the dual-axis policy.

## API / web

- **Session list:** extend `list_sessions` (add idle time to `ipc/message.go:384` result) and expose it via a device API endpoint; dialogs fetch live on open.
- **UI:** RD connect and run-script dialogs show a session dropdown only when the device heartbeat reports RDS mode; disconnected sessions listed but disabled for shadow. Non-RDS devices see zero change. Mutations wrapped in `runAction`.

## Error handling

- Spawn failures surface the lifecycle's typed state ("helper in fatal cooldown for 7 more minutes", "session ended") — never a bare timeout.
- Consent declined / prompt timeout → typed "user declined" per the remote-access policy's existing timeout semantics.
- Mid-stream helper death or session logoff → existing keepalive/evict (30s ping / 45s evict, `broker.go:183`) plus lease invalidation on the SCM logoff path; stale-IPC eviction (`broker.go:2864`) also releases leases.
- Concurrent techs: server-side single-desktop-session-per-device ordering is unchanged (`remote/sessions.ts:214`); lease refcounts make helper lifetime safe under overlap regardless of which request wins.

## Testing

- **Unit (Go):** lease acquire/refcount/release/expiry; SID-mismatch invalidation on session-ID reuse; desired-set = leases ∩ WTS snapshot; mode-aware SCM handlers; spawn-and-wait typed states (incl. fatal-cooldown surfacing); suite-mask detection; #434 strict-vs-fallback by mode; disconnected-since retention tracking; admission "not desired → clean exit" answer.
- **Windows integration:** extend `rds_lifecycle_integration_test.go` (fake-backed — it does not boot real sessions; scope it to lease/reap/logoff-race mechanics it can actually prove).
- **API/web (Vitest):** schema validators (`targetSessionId` on scripts, heartbeat mode field), dual-axis helper-policy resolution (regression for bug 1), disabled-policy precedence (bug 2), dialog render with/without the RDS flag.
- **Manual release gate:** multi-session verification on the RDS rig — shadow with each `sessionPromptMode`, prompt appears in the *target* session, targeted script execution, idle reap, disconnected-session retention cap, logon-task behavior in on-demand mode.

## Out of scope

Per-session PAM elevation, Assist helper in RDP sessions, on-demand lifecycle for workstations (possible later via the `always-on`/`on-demand` override), shadowing disconnected sessions, session log-off/management actions in the UI, VDI products that don't set `VER_SUITE_TERMINAL` (covered by the manual mode override).
