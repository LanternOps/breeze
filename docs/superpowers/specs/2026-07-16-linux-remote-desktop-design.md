# Linux Remote Desktop — Design

**Date:** 2026-07-16
**Status:** Draft spec — pending review
**Origin:** field investigation of a customer-style Ubuntu 22.04 xrdp VM (US prod) + full code map of the Linux desktop path
**Related bugs found during investigation:** macOS spawn path executed on Linux, Assist migrate/uninstall thrash loop (both fixable independently of this spec)

## Problem

Linux remote desktop has **never worked in any released build**. Release builds compile the Linux agent with `CGO_ENABLED=0` (`.github/workflows/release.yml:104-112`), and the only Linux capturer is behind `//go:build linux && cgo` (`agent/internal/remote/desktop/capture_linux.go:1`) — so every shipped agent contains the `capture_linux_nocgo.go` stub that returns `ErrNotSupported`. Verified on a deployed v0.96.0 agent: `ldd` shows no X11 linkage.

Even if the capturer were compiled in, five more defects block every real-world Linux configuration:

| # | Defect | Location | Effect |
|---|--------|----------|--------|
| 1 | `isHeadless` computed once at process start | `agentapp/main.go:680`, `service_unix.go:47` | On-demand sessions (xrdp, login/logout) leave the flag stale in both directions until agent restart |
| 2 | Headless route runs macOS-only spawn code on Linux | `heartbeat/handlers_desktop_helper.go:467-511` (`runtime.GOOS != "windows"`) | Writes `/Library/LaunchAgents/*.plist`, calls `launchctl` on Ubuntu; misleading "no desktop-helper connected" error |
| 3 | No desktop-helper binary is built or shipped for Linux | `agent/Makefile:23-25` (darwin only), release.yml | Headless/helper path has nothing to spawn even with a correct spawn branch |
| 4 | Direct path never discovers the display | `capture_linux.go` (`XOpenDisplay(NULL)`) | Root systemd service has no `DISPLAY`/`XAUTHORITY`; cannot attach even to a live X session |
| 5 | Input requires `xdotool`, never pre-flighted; X11-only | `input_linux.go` (`InputAvailable()` hard-codes `true`) | Silent per-event failures when missing; dead under Wayland |
| 6 | Capability reporting is dishonest | `heartbeat/desktop_access_other.go:7` (nil for Linux), `userhelper/client.go:1247,1256` (`CanCapture = hasDisplay`, probe darwin-only) | UI shows an enabled Connect Desktop button on Wayland/X11 desktops that always fails; xrdp boxes stuck greyed "headless" |

There is **zero Wayland support** (no PipeWire/xdg-desktop-portal code) — relevant because Ubuntu ≥22.04 GNOME defaults to Wayland.

### The xrdp scenario (field evidence)

The investigated machine is representative of "Linux box used for interactive login" in MSP fleets: no console GUI, xrdp + XFCE, sessions created on demand at display `:10+` (`X11DisplayOffset=10`), persisting across disconnects (`KillDisconnected=false`). RDP works because RDP is a session *broker*. Breeze's Linux desktop is a session *mirror* — it can only attach to an existing display server. The spec below embraces that distinction: Phases 0–2 make mirroring work everywhere it can; session *creation* is explicitly Phase 3 / deferred.

## Goals / Non-goals

**Goals**
- Shipped (CGO_ENABLED=0) Linux agents can capture real X11 sessions: console Xorg (GDM/LightDM), xrdp/virtual displays, kiosk setups — including when the session appears/disappears after agent start.
- Honest capability reporting: Linux devices emit `desktopAccess` with actionable reasons; the Connect Desktop button state matches reality.
- Wayland desktops (GNOME/KDE) supported via a per-session Linux desktop-helper using xdg-desktop-portal ScreenCast + PipeWire (Phase 2).
- Input without external binary dependencies (drop xdotool).
- Reuse the existing WebRTC/encoder pipeline unchanged (OpenH264 runtime download already works on Linux — verified in the field).
- Preserve the existing consent-gate semantics (`consentUnavailableBehavior` governs unattended sessions).

**Non-goals (YAGNI / deferred)**
- Creating login sessions where none exists (xrdp-style brokering, virtual displays, greeter capture) — Phase 3 sketch only.
- Audio capture on Linux (Windows-only WASAPI today; PipeWire loopback is a future nice-to-have).
- VA-API/NVENC hardware encoding on Linux (software OpenH264 is sufficient at Phase 1 bitrates; perf work later).
- RDP protocol interop, BSD support.
- Multi-display-*server* session picker UI (Phase 1 auto-selects; picker noted as Phase 2 follow-up).

## Architecture overview

```
Phase 0  Correctness: stop running darwin code on Linux; fix Assist thrash; honest errors
Phase 1  X11 mirror via pure-Go wire protocol (jezek/xgb, no CGO): display discovery + Xauthority resolution +
         dynamic headless + XTest input + Linux desktopAccess reporting
Phase 2  Linux desktop-helper (per-session) + Wayland via portal/PipeWire;
         helper spawn branch for Linux; real capability probing
Phase 3  (deferred) session creation / greeter attach / virtual displays
```

The key packaging decision: **stay `CGO_ENABLED=0` and speak the X11 wire protocol in pure Go via `github.com/jezek/xgb` (≥v1.2.0; pin v1.3.1)** — no C libraries loaded at all, only the `/tmp/.X11-unix/XN` socket plus the auth cookie. This supersedes the earlier purego/Xlib idea, which is disqualified: Xlib's IO-error contract calls `exit(1)` when the X connection dies (exactly the xrdp session-logout case this feature targets) and the only escape hatches (longjmp/pthread_exit from the error callback) are inexpressible from Go. xgb turns a dead server into a plain read error, and the jezek fork exists specifically to fix close-time panics with server-death tests. MIT-SHM segments come from `golang.org/x/sys/unix` (`SysvShmGet/Attach/Detach/Ctl`, already a direct dep). One new direct dependency, zero transitive. No new cross-toolchains in CI for Phase 1.

---

## Phase 0 — Correctness fixes (independent PRs, ship immediately)

1. **Gate the darwin spawn path on darwin.** `spawnHelperForDesktop` (`handlers_desktop_helper.go:467`): change `runtime.GOOS != "windows"` to an explicit `darwin` branch; Linux returns a typed error (`errors.New("linux desktop-helper not yet supported")`) that Phase 2 replaces with a real spawn. Same sweep for `kickstartDarwinDesktopHelpers` callers.
2. **Fix the Assist migrate/uninstall thrash loop.** `helper/manager.go:194` runs `migrateToSessions()` (which recreates `<baseDir>/sessions` and `pkill`s the helper) on every Apply tick when the dir is missing; with Assist disabled, `uninstallLocked()` (`manager.go:301`) then deletes the dir and clears `pendingHelperVersion`, so both re-fire every tick on **all platforms**. Fix: gate the migration call on `settings.Enabled || m.isInstalled()` — but snapshot `wasInstalled := m.isInstalled()` **before** `migrateFromLegacyName()` (which can delete the binary first) so a pre-sessions legacy box upgrading with Assist disabled still completes uninstall cleanup exactly once instead of stranding `helper_config.yaml`. Make `uninstallPackage()` log only on actual removal (linux `install_linux.go:27` **and** darwin `install_darwin.go`; windows already correct). Two regression tests: disabled+uninstalled = stable no-op (0 seam calls, `pendingHelperVersion` preserved), and disabled+installed = cleanup fires exactly once then no-ops.
3. **Honest error for the nocgo stub.** Until Phase 1 lands, `start_desktop` on Linux should return "remote desktop is not yet supported on Linux agents" rather than the plist/launchctl noise (a `runtime.GOOS == "linux"` early return in `handleStartDesktop` — the spawn-path gating in fix 1 alone still yields the generic "no capable helper" message).
4. **(Track for Phase 2, do not fix in Phase 0)** On Linux `legacyBinaryPath()` == `defaultBinaryPath()` == `/usr/local/bin/breeze-helper`, so once a Linux Assist/helper binary is ever installed, `migrateFromLegacyName()` will `pkill` + delete it on **every** Apply tick even when enabled. Harmless today (no Linux helper is published) but Phase 2's desktop-helper must guard `migrateFromLegacyName` on `oldPath != m.binaryPath` first.

## Phase 1 — X11 mirror done right (agent-only, no new binaries)

### 1.1 X11 over the wire (jezek/xgb, no CGO)

New `agent/internal/remote/desktop/x11/` package speaking the X protocol via `github.com/jezek/xgb` v1.3.1:

- **Connection + auth**: the agent dials `/tmp/.X11-unix/XN` itself, extracts the MIT-MAGIC-COOKIE-1 for display N from the resolver-determined Xauthority file with its own ~40-line parser (cloned from xgb `auth.go`, with a stale-hostname fallback), and connects via `xgb.NewConnNetWithCookieHex` — per-connection auth, zero process-global env. Only MIT-MAGIC-COOKIE-1 is supported (maps to the `x11_auth_failed` reason).
- **Capture**: `shm.GetImage` into a SysV segment (`unix.SysvShmGet(IPC_PRIVATE, size, IPC_CREAT|0o777)` + `unix.SysvShmAttach`, `IPC_RMID` immediately after the server attaches so segments never leak); core-protocol `xproto.GetImage` fallback when MIT-SHM is absent. Frames are 32bpp BGRX → capturer implements `BGRAProvider`; existing colorconv/OpenH264 path unchanged.
- **Input**: `xtest.FakeInputChecked` (motion/button/key); keysym→keycode via `xproto.GetKeyboardMapping` with a static name→keysym table (ported from today's `translateKey`).
- **Cursor**: `xfixes.QueryVersion` + `GetCursorImageAndName` on a dedicated second connection (preserves the existing name→CSS `CursorShape()` contract and the 120Hz-polling isolation).
- **Monitors**: `randr.GetMonitors` (RandR ≥1.5) with `GetScreenResources`/xinerama fallback, mapped onto the existing `MonitorInfo` shape.

**All X state is per-capturer-instance** — the C-global `g_ctx`/`g_curCtx`/`cursorCtxOnce` pattern in today's CGO code is deleted, which is what makes monitor switch, WS+WebRTC coexistence, standalone tool capturers, and Close-during-borrow benign. A failed connect yields the `x11_connect_failed` capability reason (there are no client libraries to be "missing"). The `linux && cgo` / `linux && !cgo` split collapses to one `//go:build linux` file.

### 1.2 Display/session discovery (`resolveLinuxDisplayTargets`)

New resolver in the agent, evaluated **fresh on every `start_desktop` and every heartbeat** (cached ≤30s):

1. Enumerate `/tmp/.X11-unix/X*` → candidate X display numbers; enumerate `/run/user/*/wayland-*` → Wayland sessions (Phase 1: reported, not capturable).
2. For each X display, resolve the owning session:
   - Find the X server process for `:N` (match `-displayfd`/argv or the socket via `/proc/<pid>/fd`); record its uid and any `-auth <path>` argument (**authoritative** — covers GDM, LightDM, xrdp, startx).
   - Cross-reference `loginctl list-sessions` / `Display=:N` for user, session id, `Active` state (parser is table-tested against fixtures: GDM Xorg, xrdp multi-session, tty-only).
3. `XAUTHORITY` resolution order: X server `-auth` arg → session leader's `/proc/<pid>/environ` `XAUTHORITY` → `~owner/.Xauthority` → `/run/user/<uid>/gdm/Xauthority`.
4. Selection policy (Phase 1, no picker): active `loginctl` graphical session first, else the display with the most recently active session, else lowest display number. Log the chosen target and alternatives at info.

The resolver result (`{display, xauthPath, ownerUID, ownerName, sessionType}`) is consumed inside `newPlatformCapturer` and the input handler — NOT only in `handleStartDesktop` — so every standalone capturer path (AI screenshot/computer_action tools, `ProbeCaptureAccess`, the legacy WS manager, monitor switch) inherits it with no new plumbing. Auth is injected per connection via the xgb cookie constructor; nothing process-global is mutated. Note the "one desktop session at a time" invariant holds only *inside* `SessionManager` (`startMu`): the WS JPEG manager, screenshot borrowers, monitor-switch second capturers, and the 120Hz cursor loop all run concurrently — per-instance X state is the correctness mechanism, not the single-session assumption. The root agent reads the user's Xauthority directly — it is never copied or re-permissioned.

### 1.3 Routing changes

In `handleStartDesktop` (`handlers_desktop.go:184`), Linux stops keying off boot-time `isHeadless`:

```go
if runtime.GOOS == "linux" {
    if helper := h.findActiveHelper(target); helper != nil { /* Phase 2 path */ }
    if target := resolveLinuxDisplayTargets(); target.HasX11() {
        return direct capture with target        // Phase 1 path
    }
    return typed error (reason from resolver)     // no_display_session / wayland_unsupported / x11_connect_failed
}
```

`cfg.IsHeadless` remains for macOS/Windows routing. On Linux the payload's `IsHeadless` is recomputed per tick from the resolver (fixes staleness) — but the command handlers must NOT gate on a mutating shared `h.isHeadless` bool. Required companion changes (verified against the routing code):

- **No data race / no route-flip:** never rewrite the `h.isHeadless` field the handlers read (it is a plain bool read on pool-worker goroutines; per-tick writes fail `go test -race`, and a flip between start and stop strands a live capture session). Route `start_desktop` off the fresh resolver result and make **stop routing state-based** — `handleStopDesktop` checks `h.desktopOwners` first, else `h.desktopMgr.StopSession` (both are safe no-ops for unknown IDs) — rather than re-reading the flag. Give the same treatment to the `desktop_stream_stop` no-op and the `desktop_input`/`desktop_config` gates (`handlers_desktop.go:382/400/434`).
- **Register `desktopMgr.OnSessionStopped` unconditionally on Linux** (`heartbeat.go:629`): today it is wired only when `!cfg.IsService && !cfg.IsHeadless` at boot, so a box that booted headless never reports a direct-session WebRTC drop and never tears down the consent banner. The callback is nil-checked at every fire site and inert in helper mode, so unconditional registration is safe.
- **Static-screen watchdog:** the ticker loop's no-video watchdog terminates a session after ~3s+5×5s if `lastVideoWriteUnixNano` never advances. Today the CRC-unchanged skip path never bumps the capture-alive heartbeat (it's only reached on a `nil,nil` Capture, which the current capturer never returns). The rewrite must feed the heartbeat on a genuinely-static screen — either bump `noteVideoWrite` on a differ-skip, or return `nil,nil` on no-damage like DXGI — and a perf-sanity test must assert a long static period does not kill the session.
- Note `heartbeat.go:542` (the headless Assist spawn-func branch) is dead code — `h.sessionBroker` is nil at that line, assigned later at `:592`. Fix or delete it while touching the constructor; do not replicate the ordering bug.

### 1.4 Input: XTest replaces xdotool

`input_linux.go` reimplemented on xgb's XTEST bindings, owning its own resolved X connection (the AI computer_action path constructs an InputHandler with no capturer present, so input cannot assume a shared connection): mouse move/click/scroll (buttons 4/5/6/7 for scroll), key events via keysym→keycode with shift-state handling (same viewer keymap contract as today, `apps/viewer/src/lib/keymap.ts`). `InputAvailable()` returns whether the X connection + XTest extension are live. `xdotool` dependency is removed entirely (docs updated). Multi-monitor offsets work as on other platforms (single X screen spanning monitors; `SetDisplayOffset` already generic).

### 1.5 Capability reporting + UI

- New `heartbeat/desktop_access_linux.go` implementing `computeDesktopAccess` (retag `desktop_access_other.go` to `!darwin && !linux`): probes the resolver (and a cached connect round-trip, ≤1/60s) and emits **`mode: 'user_session'`** when capturable (NOT a new `available` value — `mode` has no zod `.catch`, so an unknown value silently drops the whole desktopAccess object on already-deployed servers) or `mode: 'unavailable'` with reasons: `no_display_session`, `wayland_unsupported` (Phase 1), `x11_connect_failed`, `x11_auth_failed`. The call site (`heartbeat.go:3083`) is currently gated `runtime.GOOS == "darwin" && h.sessionBroker != nil` — a Linux arm without the broker condition must be added, and the Linux impl nil-guards the broker.
- API: extend the `desktopAccess` reason enum (`apps/api/src/routes/agents/schemas.ts:22-29`) AND the shared `DesktopAccessReason` type (`packages/shared/src/types/index.ts`) with the four Linux reasons. `heartbeat.ts:458-468` already trusts Linux `isHeadless` — unchanged.
- Web: `ConnectDesktopButton.tsx` already renders reason-driven tooltips from `desktopAccess`; add the Linux reason strings. **i18n: new keys must land in en + es/fr/de + pt-BR in the same PR** (locale-parity CI reds main otherwise).

### 1.6 Phase 1 result matrix

| Environment | Behavior after Phase 1 |
|---|---|
| xrdp session live or disconnected-but-alive | Works (mirror of `:10+`), no agent restart needed |
| xrdp box, no session since boot | Button greyed, tooltip "no active graphical session — log in via RDP/console first" |
| Console Xorg desktop (GDM/LightDM, any DE) | Works |
| GNOME/KDE on Wayland | Button greyed, tooltip "Wayland desktop — requires agent vX.Y (helper)" until Phase 2 |
| Headless server, no X libs | Button greyed, "no graphical session" |
| Old agent + new server | `desktopAccess` absent → current behavior (isHeadless-only gating) — backward compatible |

## Phase 2 — Linux desktop-helper + Wayland

### 2.1 Ship the helper

Build `breeze-desktop-helper` for linux/amd64 + linux/arm64 (`CGO_ENABLED=0`, same xgb x11 package): add to `Makefile` `build-all-desktop-helper`, release.yml matrix, signed release manifest, and `binaries-init`. The agent's verified helper downloader (`helper/manager.go` `downloadFunc` path) already enforces manifest signature + SHA-256; reuse it for desktop-helper delivery like darwin.

### 2.2 Spawn + lifecycle (the Linux branch that's missing today)

`spawnHelperForDesktop` Linux branch:

1. Enumerate graphical sessions via `loginctl` (the sessionbroker's `detector_linux.go` already classifies x11/wayland).
2. For the target session, harvest env from the session leader's `/proc/<pid>/environ`: `DISPLAY`/`WAYLAND_DISPLAY`, `XDG_RUNTIME_DIR`, `DBUS_SESSION_BUS_ADDRESS`, `XAUTHORITY`.
3. Spawn `breeze-desktop-helper --context user_session` as the session user (setuid via `os/exec` credential, not `runuser`) with that env; helper connects back over the existing IPC socket (`/var/run/breeze/agent.sock`) — the userhelper client (`internal/userhelper/client.go`) is already cross-platform.
4. Persistence: install an `/etc/xdg/autostart/breeze-desktop-helper.desktop` entry (pattern exists for Assist, `helper/install_linux.go`) so helpers exist at login without on-demand spawn; on-demand spawn remains the fallback for already-running sessions.

### 2.3 Wayland capture + input

- **Capture:** xdg-desktop-portal `org.freedesktop.portal.ScreenCast` over D-Bus (`godbus`, pure Go) → PipeWire stream fd. Request `persist_mode=2` and store the `restore_token` per user (`~/.config/breeze/portal-restore-token`, 0600) so only the **first** session needs the compositor's consent dialog; subsequent connects are unattended. Supported: GNOME ≥42, KDE ≥5.24, wlroots (screencast portal backend).
- **PipeWire consumption is the one risky integration** — no mature pure-Go client. Plan: spike `libpipewire-0.3` via purego (callbacks via `purego.NewCallback`); fallback plan if the spike fails: a small CGO-built `pw-shim` inside the helper only (helpers only run on desktop machines, and helper has no headless-server compatibility constraint). Spike gates the phase.
- **Input:** portal `org.freedesktop.portal.RemoteDesktop` (`NotifyPointerMotionAbsolute`, `NotifyKeyboardKeycode`) over D-Bus — pure Go, works on GNOME/KDE. Where the portal backend lacks RemoteDesktop (some wlroots), fall back to **agent-side uinput injection** (root, `/dev/uinput`, evdev keymap translation) routed over IPC — flagged `input_fallback: uinput` in session metadata.
- **X11 sessions with a helper present** also route through the helper (consent dialogs render in-session; matches darwin architecture); direct attach (Phase 1) remains for X11-without-helper (xrdp disconnected sessions, autostart not yet installed).

### 2.4 Honest helper capability

`detectCapabilities` (`userhelper/client.go:1240-1272`): run a real capture probe on Linux (Xlib open or portal availability check) instead of `CanCapture = hasDisplay`; report `DisplayServer` (already in the IPC message schema, `ipc/message.go:201-207`). This kills the enabled-button-on-Wayland lie for helper-connected devices.

## Phase 3 — deferred sketch (not in scope)

- **Greeter attach:** GDM/LightDM Xorg greeters are capturable with the Phase 1 resolver (auth from the greeter process); GDM-on-Wayland greeter is not. Would give "login screen" access parity with Windows/macOS.
- **Session creation / virtual displays:** headless GNOME Remote Login (GNOME ≥46 `gnome-remote-desktop` system daemon), or spawning an Xorg+dummy / Xvfb session on demand. Large, distro-fragile; revisit on customer demand.

## Change inventory

| Area | Files |
|---|---|
| Agent — x11 wire pkg (new, jezek/xgb) | `agent/internal/remote/desktop/x11/*` (auth parser, resolver, conn, keysym — parsers untagged for darwin -race coverage) |
| Agent — capture/cursor/input/monitor port | `capture_linux.go` (rewrite, drop cgo split), `cursor_linux.go`, `input_linux.go`, new `monitor_linux.go` + retag `monitor_other.go` to `!windows && !linux` |
| Agent — routing | `heartbeat/handlers_desktop.go` (start/stop/stream gates), `handlers_screenshot.go`, `handlers_computer_action.go`, `handlers_desktop_helper.go` (GOOS gates + Linux branch), `heartbeat.go` (dynamic isHeadless, OnSessionStopped unconditional, desktopAccess call-site Linux arm) |
| Agent — capability | `heartbeat/desktop_access_linux.go` (new), `desktop_access_other.go` (build tags), `userhelper/client.go` (probe) |
| Agent — Phase 0 bugs | `helper/manager.go`, `helper/install_linux.go` + regression tests |
| Build/release | `agent/Makefile`, `.github/workflows/release.yml` (Phase 2: helper matrix + manifest) |
| API | `routes/agents/schemas.ts` (reason enum) |
| Web | `ConnectDesktopButton.tsx` tooltips; i18n keys in **all** locales |
| Docs | `apps/docs` remote-desktop page (supported matrix, xdotool removal, Wayland status) |

No DB schema, RLS, or tenancy changes. No new API routes.

## Security considerations

- Root agent reads per-user `.Xauthority` files for capture only; never copies, re-permissions, or ships them. Paths are resolved from the X server process, not user-controlled config.
- Display targets are validated against `loginctl`-known sessions before attach (don't mirror arbitrary/rogue X servers listening on the socket dir without a logind session).
- Portal restore tokens stored per-user 0600; they only restore *capture* grants and are invalidated by the compositor on session changes.
- uinput fallback (Phase 2) is root-only injection via IPC from an authenticated helper session — same trust boundary as existing `run_as_user` IPC.
- Consent-gate semantics unchanged: `decideConsent` + `consentUnavailableBehavior` still governs unattended (nobody-in-session) starts; zenity consent (`consent_supported_linux.go`) works once helpers exist in-session.

## Testing

- **Unit:** resolver parsers (loginctl fixtures: GDM Xorg, xrdp multi-session `:10/:11`, Wayland-only, none), Xauthority resolution table, keysym→keycode mapping, desktopAccess reason mapping, Assist thrash-loop regression, spawn-branch GOOS gating.
- **Integration (manual rig matrix, documented in `internal/` — no infra details in-repo):** xrdp box (session live / disconnected / none since boot), Ubuntu 22.04 GNOME Xorg, Ubuntu 24.04 GNOME Wayland (Phase 2), headless server without X libs, agent restart not required across session churn. Verify end-to-end with the viewer: video, mouse/keyboard, clipboard, monitor list, cursor channel.
- **Perf sanity:** XShm capture at 1080p ≥20fps with OpenH264 on 2-vCPU VM (xrdp-class hardware); idle-detection loop behavior (ticker path — no DXGI-style blocking on X11).
- **Regression:** darwin desktop-helper and Windows session-broker paths untouched (all new branches behind `runtime.GOOS == "linux"`); `go test -race ./...`.

## Rollout

1. **Phase 0** — immediate small PRs (bugfixes; also stops the fleet-wide Assist log thrash).
2. **Phase 1** — target v0.97: agent-only; server enum + UI strings are backward/forward compatible (absent `desktopAccess` keeps today's behavior). Docs + release notes: "Linux remote desktop (X11/xrdp) now supported; xdotool no longer required."
3. **Phase 2** — target v0.98+ after the PipeWire spike: new helper artifacts in the release manifest; Wayland flagged beta initially (GNOME first, KDE next, wlroots best-effort).
4. Estimates: Phase 0 ≈ 1 day; Phase 1 ≈ 1–2 weeks incl. rig testing; Phase 2 ≈ 3–5 weeks incl. spike and packaging.

## Open questions

1. **Multi-session picker:** xrdp hosts can have several user sessions (`:10`, `:11`, …). Phase 1 auto-picks; do we want the existing `list_sessions`/`targetSessionId` plumbing surfaced in the viewer for Linux in Phase 2 (as on Windows)?
2. **Wayland priority:** is GNOME-only acceptable for the Phase 2 beta, or do MSP fleets need KDE/wlroots at parity from day one?
3. **Audio:** PipeWire/Pulse monitor-source capture would slot into the existing PCMU track — worth bundling into Phase 2 or keep deferred?
4. **Helper packaging:** ship desktop-helper inside the existing agent install script, or as a manifest-delivered on-demand download like darwin (recommended: manifest-delivered, matches darwin)?
