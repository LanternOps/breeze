# Device User Idle Time — Design

**Date:** 2026-06-11
**Status:** Approved

## Problem

The device detail page shows Logged-in User but gives no indication of whether that user is actually at the machine. Session tracking shipped in Feb 2026 (commit 832f96bf) with full plumbing for `idleMinutes` — agent struct field, API schema (`submitSessionsSchema`), `device_sessions.idle_minutes` column, and the `GET /devices/:id/sessions/active` endpoint — but the agent hardcodes `IdleMinutes: 0` (`agent/internal/collectors/sessions.go:184,219`) and no UI displays it. The agent does not call any OS input-idle API anywhere.

## Goal

Show real user idle time (e.g. "Idle 23m") on the device detail overview, measured by the agent per session.

## Decision

Measure idle in the agent's existing session detector (Approach A — service-side WTS query on Windows), not via the user helper. The helper-IPC path (`GetLastInputInfo` reported over the named pipe) is the fallback if Windows console-session measurement proves unreliable in practice; it is explicitly out of scope for this iteration.

## Design

### 1. Agent — measure idle per session (the only new plumbing)

`DetectedSession` (`agent/internal/sessionbroker/detector.go`) gains an idle field with explicit unknown-ness, e.g. `IdleFor time.Duration` + `IdleKnown bool`.

Per platform:

- **Windows** (`detector_windows.go`): alongside the existing `WTSConnectState` query (info class 4), also query `WTSSessionInfoEx` (info class 25) and read `WTSINFOEX.Data.WTSInfoExLevel1.LastInputTime` (FILETIME). Idle = now − LastInputTime. A zero FILETIME — a known quirk for the console session on some Windows versions — means **unknown**, never "0 minutes". Callable from Session 0; no helper involvement.
- **macOS** (`detector_darwin.go`): read `HIDIdleTime` (nanoseconds) from the `IOHIDSystem` IORegistry entry via the existing cgo path. The value is system-wide; apply it to the console session (the only kind the darwin detector reports today). The `detector_darwin_nocgo.go` variant leaves idle unknown.
- **Linux** (`detector_linux.go`): add `IdleHint,IdleSinceHint` to the existing `loginctl show-session --property=...` invocation. Idle = now − IdleSinceHint when `IdleHint=yes`; otherwise unknown. Headless/Wayland sessions that don't populate the hint stay unknown. Best-effort by design.

`collectors/sessions.go` changes:

- `UserSession.IdleMinutes` becomes `*int` (`json:"idleMinutes,omitempty"`). Rationale: with plain `int`+`omitempty`, "measured 0" and "unknown" are indistinguishable on the wire. As a pointer, measured-active serializes as `0`, unknown is omitted. Old agents (which always had the zero value omitted) therefore read as unknown, and the UI shows "—" instead of a false "Active".
- The two hardcoded `IdleMinutes: 0` sites populate from the detector (nil when unknown), clamped to the API max of 10080 minutes.
- `LastActivityAt` is set to `now − idle` when idle is known (today it is overwritten to `now` on every 5-minute refresh, making it useless as an idle signal). When idle is unknown, keep current behavior.
- `activityState` semantics are unchanged — it remains OS session connect state (active/locked/disconnected/away). No derived "idle" state from thresholds in this iteration.

### 2. API / DB — two one-line tweaks, no migration

`submitSessionsSchema` already accepts optional `idleMinutes` (int, 0–10080). `GET /devices/:id/sessions/active` already returns it. No migration, no RLS work, no new endpoints. Two small route fixes are required:

- The ingestion route (`apps/api/src/routes/agents/sessions.ts:98,111`) coerces a missing `idleMinutes` to `0`, which would erase the null-means-unknown semantics. Change `?? 0` to `?? null` at both sites.
- The active-sessions endpoint (`apps/api/src/routes/devices/sessions.ts`) doesn't select `updatedAt`; add it to the response so the UI tooltip can show report freshness.

### 3. Web UI — one stat in the overview strip

`apps/web/src/components/devices/DeviceDetails.tsx`, overview tab stat strip (CPU / RAM / Last Seen / Uptime / Logged-in User): add a **User Idle** stat next to Logged-in User.

- Data source: `GET /devices/:id/sessions/active`, fetched when the overview tab renders. Read-only GET — `runAction` does not apply (mutations only).
- Session selection: prefer the `console` session; if none, the least-idle active session.
- Display rules:
  - no active sessions, or `idleMinutes` null → `—`
  - selected session `activityState === 'locked'` → `Locked`
  - `idleMinutes` 0 (i.e. <1m) → `Active`
  - otherwise a compact duration: `23m`, `1h 5m`
- Tooltip: per-session breakdown (username, type, state, idle) when multiple sessions exist, plus report freshness ("as of <time>") — the agent reports sessions every 5 minutes, so the value is up to ~5 minutes stale.

### 4. Testing

Per `breeze-testing` conventions, tests alongside source:

- **Go** (table-driven): FILETIME→duration conversion incl. zero-FILETIME→unknown; loginctl `IdleHint`/`IdleSinceHint` parsing incl. missing/`no` cases; collector test asserting `IdleMinutes` pointer population and `LastActivityAt = now − idle`.
- **Web** (Vitest + jsdom): display-rule formatting — unknown→`—`, locked→`Locked`, 0→`Active`, durations, console-session preference.
- Validator bounds for `idleMinutes` are already covered by existing schema tests.
- **Manual verification, early**: Windows console-session `LastInputTime` on the e2e Windows device (`E2E_WINDOWS_DEVICE_ID` env). This is the single platform risk; if it reads zero, the helper-IPC fallback becomes a follow-up.

## Rollout

Requires an agent release for real data. Until a device's agent upgrades, its `idleMinutes` stays null and the UI shows `—` — stale-correct, never wrong. No env vars, no config, no migration.

## Out of scope

- Helper-IPC idle reporting (fallback if WTS console measurement fails verification)
- Deriving `activityState: 'idle'` from idle thresholds
- Idle time in the device list / fleet views
- Idle-based alerting or automation triggers
