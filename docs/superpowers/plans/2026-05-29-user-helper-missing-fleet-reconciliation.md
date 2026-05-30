# Windows agents missing `breeze-user-helper.exe` → black-screen remote desktop (fleet-wide)

## Summary

On Windows, remote-desktop capture runs inside an on-demand SYSTEM-context helper process spawned from `breeze-user-helper.exe`. A fleet of Windows agents never has that binary on disk, so the broker falls back to spawning `breeze-agent.exe` as the helper — which repeatedly fails its IPC keepalive and is torn down as a "stranded session." Result: **connect → black screen, 0 fps**, with no capture pipeline ever running.

## Evidence (US prod, 2026-05-29/30)

Querying `agent_logs` on US, 6 distinct Windows devices in 24h emit the helper-missing warning:

```
WIN-0UPTVR9F059  79    win-build  68    HomeUse  50    DESKTOP-FMF4L6O  4    HY-75311  3    Scope-dope  1
```

For `win-build` (Windows Server 2022, agent 0.68.2, online), the repeating triad — including at the connect attempt:

- `sessionbroker: breeze-user-helper.exe missing — falling back to agent binary` → `expectedPath: C:\Program Files\Breeze\breeze-user-helper.exe`
- `sessionbroker: failed to send pong`
- `sessionbroker: keepalive pong timeout, closing stranded session`

The warnings pre-date the v0.68.2 tag (warnings at 14:29, tag at 17:20), so these boxes were helper-less on the prior version too — not a 0.68.2 regression.

## Root cause: only two delivery vectors, neither self-heals

`breeze-user-helper.exe` lands on disk via exactly two paths:

1. **MSI install** — `build-msi.ps1 -UserHelperExePath` + the `AgentUserHelper` scheduled task.
2. **In-place upgrade prefetch** — `prefetchUserHelper` (heartbeat.go:3137) fetches the `user-helper` component during `doUpgrade` and `RestartWithHelper` (restart_windows.go:219) swaps both binaries. **Deliberately non-fatal** — any fetch failure logs `"proceeding with agent-only upgrade"` and continues helper-less.

There is **no idempotent "helper missing? fetch it" reconciliation** independent of a version change. So an agent that is (a) installed via a vector that skips the MSI (**direct-exe enrollment #410**, or a **pre-#816 MSI**) **and** (b) already at the latest version (no upgrade event will ever fire `doUpgrade`) has **no path to ever acquire the helper**. It's permanently stuck on the flaky `breeze-agent.exe`-as-helper fallback. This is exactly the case `userhelper_path.go:35-39` anticipated.

The v0.68.2 release does publish `breeze-user-helper-windows-amd64.exe`, the MSI bundles it, and `agent_versions` advertises a `user-helper` row — the artifact exists; the gap is purely delivery to already-installed, already-current agents.

## Scope-model clarification (so this isn't misread)

To be explicit, because "the user helper does remote desktop" is misleading: **remote-access capability is not granted to the user-token helper.**

- `systemHelperScopes = {notify, tray, clipboard, desktop}` — `desktop` (capture + input) is **SYSTEM-role only**.
- `userHelperScopes = {notify, clipboard, run_as_user}` — **no capture, no input.**
- Scope grant is identity-gated: `roleIdentityRejection` (broker.go:1604) rejects a `system`-role claim unless the named-pipe peer credential is the SYSTEM SID (`S-1-5-18`), which can't be forged over the pipe.
- The capture helper is spawned **on-demand** per `start_desktop` (`startDesktopViaHelper` → `findOrSpawnHelper`), not standing.

The only real wart is that **both roles run the same `breeze-user-helper.exe` binary on Windows** (macOS uses a separate `breeze-desktop-helper`, path-checked at broker.go:1653). That binary-sharing is why a single missing file knocks out the SYSTEM capture path too.

## Fix (implemented)

Add a startup/heartbeat **reconciliation** decoupled from upgrades: on Windows, if `breeze-user-helper.exe` is absent next to the agent, fetch the binary matching the **current** agent version via the `user-helper` update component and install it. Self-heals the whole fleet; MSI/upgrade become fast paths, not the only paths.

- `reconcileUserHelper(binaryPath)` + `reconcileUserHelperFromExecutable()` — heartbeat.go. Guards: non-Windows no-op; present no-op; missing → `DownloadBinary(currentVersion)` → install. All failures non-fatal (logged, retried next tick). Version is current-not-latest because the broker hash-allowlist is version-specific.
- Wired into the heartbeat loop, throttled at 30 min; zero-valued timer fires on the first tick (≈startup). Sits after the auth-dead skip so it never runs token-less.
- Extracted shared `installUserHelperBinary(tempPath, installPath, version)` (backup → taskkill → copy → broker `RefreshAllowedHashes` + hash-verify); `handleDevUpdateUserHelper` now reuses it.
- Tests: 4 new cases (non-Windows no-op, present no-op, missing→download+install with current version, download-fail→no-install). RED→GREEN verified; `go test -race ./internal/heartbeat/ ./internal/updater/ ./internal/sessionbroker/` all `ok`.

## Follow-up

Once fleet telemetry confirms reconciliation drives the helper-missing warning to zero, promote the `resolveUserHelperPath` `fs.ErrNotExist` fallback (userhelper_path.go:48) from a Warn-and-degrade to a hard error so a genuine regression surfaces loudly instead of silently falling back.
