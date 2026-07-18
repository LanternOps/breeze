# Linux Remote Desktop (Phase 0 + Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make shipped (CGO_ENABLED=0) Linux agents actually capture and control real X11 sessions (console Xorg, xrdp/XFCE, kiosk) end-to-end through the existing WebRTC pipeline, and report honest desktop capability to the UI — plus three independent Phase 0 correctness bugfixes.

**Architecture:** Speak the X11 wire protocol in pure Go via `github.com/jezek/xgb` (no C libraries, no CGO), with MIT-SHM frame grabs backed by SysV segments from `golang.org/x/sys/unix`. A per-request display/session resolver locates the live X display, its owner, and its Xauthority cookie; that cookie is injected per-connection (`xgb.NewConnNetWithCookieHex`) so nothing process-global is mutated. All X state lives on the capturer instance (the old C-global `g_ctx` is deleted), which is what makes concurrent screenshot/monitor-switch/cursor paths safe. Capability is reported to the server via a new Linux `desktopAccess` implementation and surfaced in the web UI with localized reasons.

**Tech Stack:** Go 1.25 (agent, `//go:build linux`, CGO off), `github.com/jezek/xgb` v1.3.1 (shm/xtest/xfixes/randr/xproto), `golang.org/x/sys/unix` (SysV shm), Hono + Zod (API), Astro/React + i18next (web), Vitest + Go `testing`.

**Spec:** `docs/superpowers/specs/2026-07-16-linux-remote-desktop-design.md` (revised 2026-07-16 after multi-agent research verification).

## Global Constraints

- **CGO stays OFF for Linux.** Every new agent Go file is `//go:build linux` with **no** `cgo` tag (release + dev-push + CI test-agent all build `CGO_ENABLED=0`). A `linux && cgo` file would never compile in CI or ship. Verify: `cd agent && CGO_ENABLED=0 GOOS=linux go build ./...`.
- **New X dependency:** `github.com/jezek/xgb` pinned to **v1.3.1** (≥v1.2.0 is required for `NewConnNetWithCookieHex`; v1.1.1 in the module cache lacks it). Zero transitive deps, BSD-3-style license. Add via `go get github.com/jezek/xgb@v1.3.1` then `go mod tidy`. `golang.org/x/sys` is already a direct dep at v0.47.0 — do not bump it.
- **Keep platform-independent logic in untagged files** (auth-cookie parser, loginctl/argv parsers, keysym tables, capability-reason mapping) so it compiles on all GOOS and gets `-race` coverage from the darwin CI leg. Gate only the actual socket-dial / xgb-call / `/proc` / filesystem layer behind `//go:build linux`. (CI: `test-agent` on ubuntu runs `CGO_ENABLED=0 go test ./...` with **no** `-race`; `test-agent-race` runs on macOS where `//go:build linux` files don't compile — so linux-tagged concurrency code is never raced in CI.)
- **No live X server in CI.** ubuntu-latest runners have no `DISPLAY`. Any test that needs a real X connection must `t.Skip()` when a probe fails, following the package convention (`encoder_nvenc_windows_test.go:28`). Pure parser/table tests run unconditionally.
- **desktopAccess `mode` must be `'user_session'` or `'unavailable'`** on Linux — never `'available'`. The zod `mode` enum has no `.catch`, so an unknown mode silently drops the entire desktopAccess object on already-deployed (v0.96) servers.
- **i18n parity:** any new `en` locale key must land in **all five** locale dirs (`en`, `es-419`, `fr-FR`, `de-DE`, `pt-BR`) in the same PR with real (non-English-duplicate) translations, or `localeParity.test.ts` / `translationCoverage.test.ts` red the required `test-web` job.
- **Reason enum is mirrored in 4 places** that must change together: `apps/api/src/routes/agents/schemas.ts:22`, `packages/shared/src/types/index.ts` (`DesktopAccessReason`), `ConnectDesktopButton.tsx` switch, `DeviceInfoTab.tsx` `formatDesktopAccessReason`. Missing the shared type breaks the Type Check CI job.
- **Never edit a shipped migration.** (No DB migrations are needed in this plan — `desktop_access` is jsonb, `is_headless` already exists.)
- **Commit cadence:** each task ends with a commit. Phase 0 tasks (1–3) are independent PRs; ship them first. Branch off `main` per the repo's worktree convention before starting.

---

## Task Map

**Phase 0 — correctness bugfixes (3 independent PRs, ship immediately):**
1. Fix the Assist migrate/uninstall thrash loop (all platforms)
2. Gate the darwin helper-spawn path on darwin; typed Linux error + fast-fail
3. Honest "not supported yet" error for `start_desktop` on Linux

**Phase 1 — X11 mirror (one feature branch, sequential):**
4. Add `jezek/xgb` dep + Xauthority cookie parser (untagged)
5. Display/session resolver: parsers (untagged) + linux glue
6. `x11` package: connection + MIT-SHM capture
7. Keysym name→value table + `GetKeyboardMapping` reverse map (untagged + linux)
8. Port `linuxCapturer` onto the `x11` package (capture + cursor + BGRAProvider)
9. Monitor enumeration via RandR (`monitor_linux.go`)
10. XTest input handler (replace xdotool)
11. Agent routing: dynamic headless, state-based stop, OnSessionStopped, watchdog
12. `desktop_access_linux.go` + call-site Linux arm + capability reason plumbing
13. API + shared reason enum
14. Web `ConnectDesktopButton` reasons + i18n (5 locales) + `DeviceInfoTab`
15. Rig verification against the Ubuntu xrdp box + docs

---

# PHASE 0

## Task 1: Fix the Assist migrate/uninstall thrash loop

**Problem:** With Breeze Assist disabled and not installed, every heartbeat (~60s) `Apply()` recreates `<baseDir>/sessions` via `migrateToSessions()` (which also `pkill`s helpers + removes autostart), then `uninstallLocked()` deletes it again and clears `pendingHelperVersion` — an endless per-tick loop, fleet-wide, on all platforms. Confirmed at `helper/manager.go:193-196, 298-303`.

**Files:**
- Modify: `agent/internal/helper/manager.go:193-196`
- Modify: `agent/internal/helper/install_linux.go:22-29`
- Modify: `agent/internal/helper/install_darwin.go:28-34`
- Test: `agent/internal/helper/manager_test.go` (add two tests)

**Interfaces:**
- Consumes: `Manager.needsSessionMigration() bool`, `Manager.isInstalled() bool`, `Manager.migrateToSessions()`, `Manager.uninstallLocked()`, seam vars `removeAutoStartFunc`, `uninstallPackageFunc`, `stopHelperLegacyFunc`, `migrationTargetsFunc`, `prepareSessionDirFunc` (all `migrate.go:9-20`).
- Produces: no new exported symbols; behavioral fix only.

- [ ] **Step 1: Write the failing regression tests**

Add to `agent/internal/helper/manager_test.go` (follows `TestApplyDisabledStopsRunningHelperAfterRestart` conventions — `New(context.Background(), "", nil, "")` + field injection + seam save/restore via `t.Cleanup`):

```go
func TestApplyDisabledUninstalledIsStableNoOp(t *testing.T) {
	tmpDir := t.TempDir()

	var removeCalls, uninstallCalls, stopLegacyCalls int
	origRemove := removeAutoStartFunc
	origUninstall := uninstallPackageFunc
	origStopLegacy := stopHelperLegacyFunc
	t.Cleanup(func() {
		removeAutoStartFunc = origRemove
		uninstallPackageFunc = origUninstall
		stopHelperLegacyFunc = origStopLegacy
	})
	removeAutoStartFunc = func() error { removeCalls++; return nil }
	uninstallPackageFunc = func() error { uninstallCalls++; return nil }
	stopHelperLegacyFunc = func() { stopLegacyCalls++ }

	mgr := New(context.Background(), "", nil, "")
	mgr.baseDir = tmpDir
	mgr.binaryPath = filepath.Join(tmpDir, "breeze-helper") // absent → not installed
	mgr.sessionEnumerator = &mockEnumerator{}
	mgr.pendingHelperVersion = "1.2.3" // simulate bootstrap version arriving each tick

	mgr.Apply(&Settings{Enabled: false})
	mgr.Apply(&Settings{Enabled: false})

	if _, err := os.Stat(filepath.Join(tmpDir, "sessions")); !os.IsNotExist(err) {
		t.Fatalf("sessions dir should never be created when disabled+uninstalled; err=%v", err)
	}
	if removeCalls != 0 || uninstallCalls != 0 || stopLegacyCalls != 0 {
		t.Fatalf("expected zero cleanup churn, got remove=%d uninstall=%d stopLegacy=%d",
			removeCalls, uninstallCalls, stopLegacyCalls)
	}
	if mgr.pendingHelperVersion != "1.2.3" {
		t.Fatalf("pendingHelperVersion should survive disabled ticks, got %q", mgr.pendingHelperVersion)
	}
}

func TestApplyDisabledInstalledCleansUpOnce(t *testing.T) {
	tmpDir := t.TempDir()
	binPath := filepath.Join(tmpDir, "breeze-helper")
	if err := os.WriteFile(binPath, []byte("fake"), 0755); err != nil {
		t.Fatal(err)
	}

	var uninstallCalls int
	origRemove := removeAutoStartFunc
	origUninstall := uninstallPackageFunc
	origStopLegacy := stopHelperLegacyFunc
	origTargets := migrationTargetsFunc
	origPrepare := prepareSessionDirFunc
	t.Cleanup(func() {
		removeAutoStartFunc = origRemove
		uninstallPackageFunc = origUninstall
		stopHelperLegacyFunc = origStopLegacy
		migrationTargetsFunc = origTargets
		prepareSessionDirFunc = origPrepare
	})
	removeAutoStartFunc = func() error { return nil }
	uninstallPackageFunc = func() error { uninstallCalls++; _ = os.Remove(binPath); return nil }
	stopHelperLegacyFunc = func() {}
	migrationTargetsFunc = func() ([]string, error) { return nil, nil }
	prepareSessionDirFunc = func(path, sessionKey string) error { return nil }

	mgr := New(context.Background(), "", nil, "")
	mgr.baseDir = tmpDir
	mgr.binaryPath = binPath
	mgr.sessionEnumerator = &mockEnumerator{}

	mgr.Apply(&Settings{Enabled: false}) // installed → migrate once, then uninstall
	if uninstallCalls != 1 {
		t.Fatalf("first disabled tick should uninstall once, got %d", uninstallCalls)
	}
	mgr.Apply(&Settings{Enabled: false}) // now uninstalled → full no-op
	if uninstallCalls != 1 {
		t.Fatalf("second disabled tick should be a no-op, got %d uninstall calls", uninstallCalls)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd agent && go test ./internal/helper/ -run 'TestApplyDisabled(UninstalledIsStableNoOp|InstalledCleansUpOnce)' -v`
Expected: `TestApplyDisabledUninstalledIsStableNoOp` FAILS (sessions dir gets created; cleanup churn non-zero). `TestApplyDisabledInstalledCleansUpOnce` may already pass or fail depending on migration — both must pass after the fix.

- [ ] **Step 3: Apply the manager.go gate fix**

In `agent/internal/helper/manager.go`, replace lines 193-196:

```go
	m.migrateFromLegacyName()
	if m.needsSessionMigration() {
		m.migrateToSessions()
	}
```

with:

```go
	// Snapshot install state BEFORE migrateFromLegacyName — on Linux (and
	// old-name darwin/windows) it can delete the binary, and we must still
	// finish uninstall cleanup exactly once for a legacy box upgrading with
	// Assist disabled.
	wasInstalled := m.isInstalled()
	m.migrateFromLegacyName()
	// Only run the one-time per-session migration when Assist is (or was)
	// actually present. When the policy is off and nothing is installed,
	// uninstallLocked() removes the sessions dir every tick — re-running the
	// migration here would recreate it (and pkill stray helpers / rewrite
	// autostart) in an endless migrate/uninstall thrash loop on every heartbeat.
	if m.needsSessionMigration() && (settings.Enabled || wasInstalled) {
		m.migrateToSessions()
	}
```

- [ ] **Step 4: Apply the install-log fixes**

In `agent/internal/helper/install_linux.go`, replace `uninstallPackage` (lines 22-29):

```go
func uninstallPackage() error {
	binaryPath := defaultBinaryPath()
	err := os.Remove(binaryPath)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove binary: %w", err)
	}
	if err == nil {
		log.Info("AppImage removed", "path", binaryPath)
	}
	return nil
}
```

In `agent/internal/helper/install_darwin.go`, guard the `os.RemoveAll(destAppPath)` in `uninstallPackage` (lines 28-34) so the "app bundle removed" Info only fires on a real removal — add before the `RemoveAll`:

```go
	if _, statErr := os.Stat(destAppPath); errors.Is(statErr, os.ErrNotExist) {
		return nil
	}
```

(Add `"errors"` to the imports of `install_darwin.go` if not present. `install_windows.go` already returns early when not installed — no change.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd agent && go test ./internal/helper/ -v`
Expected: PASS, including the two new tests and the existing `TestApplyDisabledStopsRunningHelperAfterRestart`.

- [ ] **Step 6: Commit**

```bash
cd agent && CGO_ENABLED=0 go build ./... && go test ./internal/helper/
git add agent/internal/helper/manager.go agent/internal/helper/install_linux.go agent/internal/helper/install_darwin.go agent/internal/helper/manager_test.go
git commit -m "fix(agent): stop Breeze Assist migrate/uninstall thrash loop on every heartbeat

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 2: Gate the darwin helper-spawn path on darwin

**Problem:** `spawnHelperForDesktop` gates on `runtime.GOOS != "windows"` (`handlers_desktop_helper.go:468`), so headless-at-boot Linux runs macOS plist/launchctl code (writes `/Library/LaunchAgents`, execs `launchctl`), producing a ~20s stall and the misleading "no desktop-helper connected" error on `start_desktop`, `take_screenshot`, and `computer_action`.

**Files:**
- Modify: `agent/internal/heartbeat/handlers_desktop_helper.go` (imports, new sentinel, gate flip, fast-fail, two defense-in-depth guards)
- Test: `agent/internal/heartbeat/handlers_desktop_helper_test.go` (add two tests)

**Interfaces:**
- Produces: `var ErrLinuxDesktopHelperUnsupported error` (exported, package `heartbeat`).
- Consumes: `Heartbeat.spawnHelperForDesktop`, `Heartbeat.findOrSpawnHelper`, `Heartbeat.spawnHelper` seam, test helper `newTestBrokerWithSessions(t, ...)` (`test_helpers_test.go:11`).

- [ ] **Step 1: Write the failing tests**

Add to `agent/internal/heartbeat/handlers_desktop_helper_test.go`:

```go
func TestSpawnHelperForDesktopLinuxReturnsTypedError(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("linux-only: exercises the non-darwin/non-windows spawn branch")
	}
	h := &Heartbeat{}
	err := h.spawnHelperForDesktop("")
	if !errors.Is(err, ErrLinuxDesktopHelperUnsupported) {
		t.Fatalf("expected ErrLinuxDesktopHelperUnsupported, got %v", err)
	}
}

func TestFindOrSpawnHelperSkipsPollOnUnsupportedPlatform(t *testing.T) {
	h := &Heartbeat{
		sessionBroker: newTestBrokerWithSessions(t),
		spawnHelper:   func(string) error { return ErrLinuxDesktopHelperUnsupported },
	}
	start := time.Now()
	got := h.findOrSpawnHelper("")
	if got != nil {
		t.Fatalf("expected nil helper on unsupported platform, got %v", got)
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("findOrSpawnHelper should fast-fail, took %v (10s poll not skipped)", elapsed)
	}
}
```

Ensure `runtime`, `errors`, and `time` are imported in the test file (add if missing).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd agent && go test ./internal/heartbeat/ -run 'TestSpawnHelperForDesktopLinuxReturnsTypedError|TestFindOrSpawnHelperSkipsPollOnUnsupportedPlatform' -v`
Expected: on a darwin dev host, the first test SKIPS and the second FAILS (currently `spawnHelper` returning an error still falls through to the 10s poll). On Linux CI both run; the first FAILS pre-fix.

- [ ] **Step 3: Add the sentinel and `errors` import**

In `agent/internal/heartbeat/handlers_desktop_helper.go`, add `"errors"` to the import block, and after the `maxGUIUserUIDs` const (line 25):

```go
// ErrLinuxDesktopHelperUnsupported is returned by spawnHelperForDesktop on
// Linux (and any other non-darwin/non-windows GOOS) until a real Linux
// desktop-helper spawn branch exists (Phase 2 of the Linux remote-desktop
// plan). findOrSpawnHelper treats it as terminal — there is nothing to poll for.
var ErrLinuxDesktopHelperUnsupported = errors.New("linux desktop-helper not yet supported")
```

- [ ] **Step 4: Flip the spawn gate to darwin-only**

In `spawnHelperForDesktop` (line 467), change the opening condition from `if runtime.GOOS != "windows" {` to `if runtime.GOOS == "darwin" {` (leave the darwin body byte-identical), and immediately after that block closes (after its `return fmt.Errorf("no desktop-helper connected; ensure the LaunchAgents are loaded")` and closing brace, before the Windows `if targetSession == "" {`), insert:

```go
	if runtime.GOOS != "windows" {
		// Linux (and any other non-darwin GOOS): no desktop-helper binary is
		// shipped yet. Phase 2 replaces this with a loginctl-based per-session
		// spawn. Return a terminal sentinel so findOrSpawnHelper does not waste
		// 10s polling for a helper that can never connect.
		return ErrLinuxDesktopHelperUnsupported
	}
```

- [ ] **Step 5: Add the fast-fail in findOrSpawnHelper**

In `findOrSpawnHelper` (line 347), the block is:

```go
	if err := h.spawnDesktopHelper(targetSession); err != nil {
		log.Warn("helper spawn failed", "error", err.Error())
		// Don't give up yet — fall through to disconnected-session fallback below.
	}
```

Replace with:

```go
	if err := h.spawnDesktopHelper(targetSession); err != nil {
		log.Warn("helper spawn failed", "error", err.Error())
		if errors.Is(err, ErrLinuxDesktopHelperUnsupported) {
			// Terminal: no helper can ever connect on this platform yet, so the
			// 10s poll and disconnected-session fallback are pointless.
			return nil
		}
		// Don't give up yet — fall through to disconnected-session fallback below.
	}
```

- [ ] **Step 6: Add defense-in-depth GOOS guards**

At the top of `ensureDarwinHelperPlists()` (line 452) and `kickstartDarwinDesktopHelpers()` (line 597), add:

```go
	if runtime.GOOS != "darwin" {
		return
	}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd agent && go test ./internal/heartbeat/ -run 'TestSpawnHelperForDesktop|TestFindOrSpawnHelper|TestStartDesktopViaHelper|TestHandleStopDesktop' -v`
Expected: PASS (second test now fast-fails; existing seam-based tests unaffected). The linux-gated test still SKIPS on darwin — rely on the ubuntu `test-agent` CI job for its real assertion.

- [ ] **Step 8: Commit**

```bash
cd agent && CGO_ENABLED=0 go build ./... && go test ./internal/heartbeat/
git add agent/internal/heartbeat/handlers_desktop_helper.go agent/internal/heartbeat/handlers_desktop_helper_test.go
git commit -m "fix(agent): don't run macOS launchctl helper-spawn path on Linux

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 3: Honest Linux error for start_desktop (interim, pre-Phase-1)

**Problem:** After Task 2 the Linux `start_desktop` failure is fast but still says "no capable helper available after spawn attempt". Until Phase 1 lands, return a clear message. **This early-return is REMOVED in Task 11** when real capture arrives — it is deliberately interim so the two Phase 0 PRs can merge and ship before Phase 1 is done.

**Files:**
- Modify: `agent/internal/heartbeat/handlers_desktop.go` (in `handleStartDesktop`, after payload validation ~line 131, before ICE parsing)
- Test: `agent/internal/heartbeat/handlers_desktop_test.go` (or the existing desktop test file)

**Interfaces:**
- Consumes: `Command`, `tools.CommandResult`.

- [ ] **Step 1: Write the failing test**

Add to `agent/internal/heartbeat/handlers_desktop_test.go`:

```go
func TestHandleStartDesktopLinuxNotSupportedYet(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("linux-only interim guard")
	}
	h := &Heartbeat{}
	res := handleStartDesktop(h, Command{
		ID: "c1",
		Payload: map[string]any{
			"sessionId": "11111111-1111-1111-1111-111111111111",
			"offer":     "v=0\r\n",
		},
	})
	if res.Status != "failed" || !strings.Contains(res.Error, "not yet supported on Linux") {
		t.Fatalf("expected linux-not-supported failure, got status=%q error=%q", res.Status, res.Error)
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd agent && go test ./internal/heartbeat/ -run TestHandleStartDesktopLinuxNotSupportedYet -v`
Expected: on Linux, FAIL (no such guard). On darwin, SKIP.

- [ ] **Step 3: Add the interim guard**

In `handleStartDesktop` (`handlers_desktop.go`), immediately after the `validateDesktopSessionID` block (~line 131) and before the ICE-server parsing:

```go
	// INTERIM (Phase 0): remote desktop capture is not implemented on Linux
	// agents yet. Removed in Phase 1 when the X11 capturer lands.
	if runtime.GOOS == "linux" {
		return tools.CommandResult{
			Status:     "failed",
			Error:      "remote desktop is not yet supported on Linux agents",
			DurationMs: time.Since(start).Milliseconds(),
		}
	}
```

Confirm `runtime` is imported in `handlers_desktop.go` (it is — used at line 184-context checks).

- [ ] **Step 4: Run to verify it passes**

Run: `cd agent && go test ./internal/heartbeat/ -run TestHandleStartDesktop -v`
Expected: PASS on Linux; SKIP on darwin.

- [ ] **Step 5: Commit**

```bash
cd agent && CGO_ENABLED=0 go build ./...
git add agent/internal/heartbeat/handlers_desktop.go agent/internal/heartbeat/handlers_desktop_test.go
git commit -m "fix(agent): clear 'not supported yet' error for Linux start_desktop (interim)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

# PHASE 1

> Phase 1 is one feature branch. Tasks 4–14 are sequential; Task 15 is rig verification. Where a task cannot be unit-tested against a live X server, it ends with a **compile gate** (`CGO_ENABLED=0 GOOS=linux go build ./...`) plus a deferred rig check in Task 15.

## Task 4: Add jezek/xgb + Xauthority cookie parser

**Files:**
- Modify: `agent/go.mod`, `agent/go.sum`
- Create: `agent/internal/remote/desktop/x11/auth.go` (untagged — pure parser)
- Test: `agent/internal/remote/desktop/x11/auth_test.go`

**Interfaces:**
- Produces:
  ```go
  package x11
  // FindMitMagicCookie parses an Xauthority blob and returns the 16-byte
  // MIT-MAGIC-COOKIE-1 for the given display number and hostname. displayNum is
  // the number after the colon (e.g. "10" for ":10"). Matching follows the X
  // convention: family FamilyWild(65535) OR (FamilyLocal(256) AND address==hostname),
  // AND (recorded display=="" OR ==displayNum), AND name=="MIT-MAGIC-COOKIE-1".
  // Falls back to any MIT-MAGIC-COOKIE-1 entry matching displayNum when no
  // hostname match is found (stale-hostname tolerance). Returns ErrNoCookie if none.
  func FindMitMagicCookie(blob []byte, displayNum, hostname string) ([]byte, error)
  var ErrNoCookie = errors.New("no MIT-MAGIC-COOKIE-1 entry for display")
  ```

- [ ] **Step 1: Add the dependency**

Run:
```bash
cd agent && go get github.com/jezek/xgb@v1.3.1 && go mod tidy
```
Expected: `go.mod` gains `github.com/jezek/xgb v1.3.1`; `go.sum` updated. Confirm no other module version changed (`git diff agent/go.mod`).

- [ ] **Step 2: Write the failing parser test**

Create `agent/internal/remote/desktop/x11/auth_test.go`. The Xauthority binary format per entry: `uint16 family` (big-endian), then four length-prefixed (`uint16` BE length) byte fields: address, display-number (ASCII), name, data.

```go
package x11

import (
	"bytes"
	"encoding/binary"
	"testing"
)

func writeField(buf *bytes.Buffer, b []byte) {
	_ = binary.Write(buf, binary.BigEndian, uint16(len(b)))
	buf.Write(b)
}

func entry(family uint16, addr, display, name string, data []byte) []byte {
	var buf bytes.Buffer
	_ = binary.Write(&buf, binary.BigEndian, family)
	writeField(&buf, []byte(addr))
	writeField(&buf, []byte(display))
	writeField(&buf, []byte(name))
	writeField(&buf, data)
	return buf.Bytes()
}

func TestFindMitMagicCookie(t *testing.T) {
	cookie := bytes.Repeat([]byte{0xAB}, 16)
	other := bytes.Repeat([]byte{0xCD}, 16)

	local := entry(256, "ubuntu", "10", "MIT-MAGIC-COOKIE-1", cookie)   // FamilyLocal
	wrongDisplay := entry(256, "ubuntu", "11", "MIT-MAGIC-COOKIE-1", other)
	wild := entry(65535, "", "10", "MIT-MAGIC-COOKIE-1", cookie)        // FamilyWild
	xdm := entry(256, "ubuntu", "10", "XDM-AUTHORIZATION-1", other)     // wrong scheme

	cases := []struct {
		name          string
		blob          []byte
		display, host string
		want          []byte
		wantErr       bool
	}{
		{"exact local+display match", append(append([]byte{}, wrongDisplay...), local...), "10", "ubuntu", cookie, false},
		{"wild family matches", wild, "10", "someotherhost", cookie, false},
		{"stale hostname falls back to display match", entry(256, "oldhost", "10", "MIT-MAGIC-COOKIE-1", cookie), "10", "newhost", cookie, false},
		{"no matching display", wrongDisplay, "10", "ubuntu", nil, true},
		{"only XDM scheme present", xdm, "10", "ubuntu", nil, true},
		{"empty blob", nil, "10", "ubuntu", nil, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := FindMitMagicCookie(tc.blob, tc.display, tc.host)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expected error, got cookie %x", got)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if !bytes.Equal(got, tc.want) {
				t.Fatalf("cookie = %x, want %x", got, tc.want)
			}
		})
	}
}
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd agent && go test ./internal/remote/desktop/x11/ -run TestFindMitMagicCookie -v`
Expected: FAIL — `undefined: FindMitMagicCookie`.

- [ ] **Step 4: Implement the parser**

Create `agent/internal/remote/desktop/x11/auth.go`:

```go
// Package x11 speaks the X11 wire protocol (via github.com/jezek/xgb) so the
// Breeze agent can mirror and control X sessions without linking any C
// libraries (CGO stays off). This file is the pure-Go Xauthority parser and has
// no build tag so it is compiled and race-tested on every platform.
package x11

import (
	"encoding/binary"
	"errors"
)

const (
	familyLocal = 256   // FamilyLocal
	familyWild  = 65535 // FamilyWild
	mitCookie   = "MIT-MAGIC-COOKIE-1"
)

// ErrNoCookie is returned when no usable MIT-MAGIC-COOKIE-1 entry is found.
var ErrNoCookie = errors.New("no MIT-MAGIC-COOKIE-1 entry for display")

type authEntry struct {
	family  uint16
	address string
	display string
	name    string
	data    []byte
}

// FindMitMagicCookie extracts the 16-byte MIT-MAGIC-COOKIE-1 for displayNum from
// an Xauthority blob. See the doc comment on the exported symbol in the plan.
func FindMitMagicCookie(blob []byte, displayNum, hostname string) ([]byte, error) {
	entries, err := parseXauthority(blob)
	if err != nil {
		return nil, err
	}
	var staleMatch []byte
	for _, e := range entries {
		if e.name != mitCookie {
			continue
		}
		if e.display != "" && e.display != displayNum {
			continue
		}
		switch {
		case e.family == familyWild:
			return e.data, nil
		case e.family == familyLocal && e.address == hostname:
			return e.data, nil
		default:
			// Same display, MIT cookie, but hostname mismatch — remember it as a
			// stale-hostname fallback (hostname changed since the session started).
			if staleMatch == nil {
				staleMatch = e.data
			}
		}
	}
	if staleMatch != nil {
		return staleMatch, nil
	}
	return nil, ErrNoCookie
}

func parseXauthority(blob []byte) ([]authEntry, error) {
	var entries []authEntry
	pos := 0
	readField := func() ([]byte, bool) {
		if pos+2 > len(blob) {
			return nil, false
		}
		n := int(binary.BigEndian.Uint16(blob[pos:]))
		pos += 2
		if pos+n > len(blob) {
			return nil, false
		}
		f := blob[pos : pos+n]
		pos += n
		return f, true
	}
	for pos < len(blob) {
		if pos+2 > len(blob) {
			break
		}
		family := binary.BigEndian.Uint16(blob[pos:])
		pos += 2
		address, ok := readField()
		if !ok {
			break
		}
		display, ok := readField()
		if !ok {
			break
		}
		name, ok := readField()
		if !ok {
			break
		}
		data, ok := readField()
		if !ok {
			break
		}
		entries = append(entries, authEntry{
			family:  family,
			address: string(address),
			display: string(display),
			name:    string(name),
			data:    append([]byte(nil), data...),
		})
	}
	return entries, nil
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd agent && go test ./internal/remote/desktop/x11/ -run TestFindMitMagicCookie -v`
Expected: PASS (all subtests).

- [ ] **Step 6: Commit**

```bash
cd agent && CGO_ENABLED=0 go build ./... && go test ./internal/remote/desktop/x11/
git add agent/go.mod agent/go.sum agent/internal/remote/desktop/x11/auth.go agent/internal/remote/desktop/x11/auth_test.go
git commit -m "feat(agent): add jezek/xgb dep + Xauthority cookie parser for Linux X11

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 5: Display/session resolver

**Goal:** Locate the live X display, its owner, its Xauthority file path, and session type. Pure parsers (argv `-auth` extraction, `loginctl` output) are untagged + table-tested; `/proc` and filesystem enumeration are `//go:build linux`.

**Files:**
- Create: `agent/internal/remote/desktop/x11/resolve.go` (untagged parsers)
- Create: `agent/internal/remote/desktop/x11/resolve_linux.go` (`//go:build linux` glue)
- Create: `agent/internal/remote/desktop/x11/resolve_other.go` (`//go:build !linux` stub returning `ErrNoDisplay`)
- Test: `agent/internal/remote/desktop/x11/resolve_test.go`

**Interfaces:**
- Produces:
  ```go
  type DisplayTarget struct {
  	Display     string // ":10"
  	XauthPath   string // resolved Xauthority file, may be ""
  	OwnerUID    int
  	OwnerName   string
  	SessionType string // "x11" | "wayland"
  	Active      bool   // loginctl Active=yes
  }
  var ErrNoDisplay = errors.New("no attachable X11 display session")
  // ResolveDisplayTargets enumerates candidate displays and returns them ranked
  // (active graphical X11 first, then most-recently-active, then lowest number).
  // Wayland-only sessions are returned with SessionType "wayland" and no XauthPath.
  func ResolveDisplayTargets() ([]DisplayTarget, error)
  // SelectX11Target returns the first attachable x11 target, or ErrNoDisplay.
  // If a wayland session exists but no x11 target, returns ErrWaylandUnsupported.
  func SelectX11Target() (DisplayTarget, error)
  var ErrWaylandUnsupported = errors.New("wayland session present but X11 capture unsupported")
  // Pure helpers (untagged, tested directly):
  func parseAuthArg(argv []string) string          // returns the -auth value or ""
  func parseLoginctlSessions(out string) []loginctlSession
  ```

- [ ] **Step 1: Write failing parser tests**

Create `agent/internal/remote/desktop/x11/resolve_test.go`:

```go
package x11

import "testing"

func TestParseAuthArg(t *testing.T) {
	cases := []struct {
		name string
		argv []string
		want string
	}{
		{"xorg with -auth", []string{"/usr/lib/xorg/Xorg", ":10", "-auth", "/run/user/1001/gdm/Xauthority", "-nolisten", "tcp"}, "/run/user/1001/gdm/Xauthority"},
		{"xrdp Xorg auth", []string{"Xorg", ":10", "-auth", ".Xauthority", "-config", "xrdp/xorg.conf"}, ".Xauthority"},
		{"no auth arg", []string{"Xorg", ":0", "-nolisten", "tcp"}, ""},
		{"auth is last with no value", []string{"Xorg", ":0", "-auth"}, ""},
		{"empty argv", nil, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := parseAuthArg(tc.argv); got != tc.want {
				t.Fatalf("parseAuthArg = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestParseLoginctlSessions(t *testing.T) {
	// `loginctl list-sessions --no-legend` style, plus we resolve details per
	// session; here we test the summary parser tolerant of the columnar output.
	out := "  c39 1001 todd  seat0 tty2\n" +
		"  c87    0 root       tty1\n"
	got := parseLoginctlSessions(out)
	if len(got) != 2 {
		t.Fatalf("expected 2 sessions, got %d (%v)", len(got), got)
	}
	if got[0].id != "c39" || got[0].uid != 1001 || got[0].user != "todd" {
		t.Fatalf("first session mismatch: %+v", got[0])
	}
	if got[1].uid != 0 || got[1].user != "root" {
		t.Fatalf("second session mismatch: %+v", got[1])
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd agent && go test ./internal/remote/desktop/x11/ -run 'TestParseAuthArg|TestParseLoginctlSessions' -v`
Expected: FAIL — undefined `parseAuthArg`, `parseLoginctlSessions`.

- [ ] **Step 3: Implement the untagged parsers**

Create `agent/internal/remote/desktop/x11/resolve.go`:

```go
package x11

import (
	"errors"
	"strconv"
	"strings"
)

var (
	// ErrNoDisplay is returned when no attachable X11 display session exists.
	ErrNoDisplay = errors.New("no attachable X11 display session")
	// ErrWaylandUnsupported is returned when only a Wayland session is present.
	ErrWaylandUnsupported = errors.New("wayland session present but X11 capture unsupported")
)

// DisplayTarget describes a resolved X (or Wayland) session the agent may mirror.
type DisplayTarget struct {
	Display     string
	XauthPath   string
	OwnerUID    int
	OwnerName   string
	SessionType string // "x11" | "wayland"
	Active      bool
}

type loginctlSession struct {
	id   string
	uid  int
	user string
}

// parseAuthArg returns the value of the "-auth <path>" argument in an X server
// argv, or "" if absent.
func parseAuthArg(argv []string) string {
	for i := 0; i < len(argv)-1; i++ {
		if argv[i] == "-auth" {
			return argv[i+1]
		}
	}
	return ""
}

// parseLoginctlSessions parses `loginctl list-sessions --no-legend` output. The
// column layout is: SESSION UID USER [SEAT] [TTY]. We only need session id, uid,
// and user; extra columns are ignored.
func parseLoginctlSessions(out string) []loginctlSession {
	var sessions []loginctlSession
	for _, line := range strings.Split(out, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 3 {
			continue
		}
		uid, err := strconv.Atoi(fields[1])
		if err != nil {
			continue
		}
		sessions = append(sessions, loginctlSession{id: fields[0], uid: uid, user: fields[2]})
	}
	return sessions
}
```

- [ ] **Step 4: Run to verify parser tests pass**

Run: `cd agent && go test ./internal/remote/desktop/x11/ -run 'TestParseAuthArg|TestParseLoginctlSessions' -v`
Expected: PASS.

- [ ] **Step 5: Implement the linux glue + non-linux stub**

Create `agent/internal/remote/desktop/x11/resolve_other.go`:

```go
//go:build !linux

package x11

// ResolveDisplayTargets is unsupported off Linux.
func ResolveDisplayTargets() ([]DisplayTarget, error) { return nil, ErrNoDisplay }

// SelectX11Target is unsupported off Linux.
func SelectX11Target() (DisplayTarget, error) { return DisplayTarget{}, ErrNoDisplay }
```

Create `agent/internal/remote/desktop/x11/resolve_linux.go`:

```go
//go:build linux

package x11

import (
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// ResolveDisplayTargets enumerates X sockets under /tmp/.X11-unix and Wayland
// sockets under /run/user/<uid>, resolving each X display to its owner and
// Xauthority. Results are ranked: active x11 first, then any x11, then wayland.
func ResolveDisplayTargets() ([]DisplayTarget, error) {
	sessions := loginctlDetails() // map[display]loginctlSession-ish, best-effort
	var targets []DisplayTarget

	// X11 displays from /tmp/.X11-unix/X<N>
	if entries, err := os.ReadDir("/tmp/.X11-unix"); err == nil {
		for _, e := range entries {
			name := e.Name() // "X10"
			if !strings.HasPrefix(name, "X") {
				continue
			}
			num := strings.TrimPrefix(name, "X")
			if _, err := strconv.Atoi(num); err != nil {
				continue
			}
			display := ":" + num
			t := DisplayTarget{Display: display, SessionType: "x11"}
			if pid, argv, uid, ok := findXServerProc(num); ok {
				t.OwnerUID = uid
				t.XauthPath = resolveXauthPath(parseAuthArg(argv), uid, pid)
			}
			if s, ok := sessions[display]; ok {
				t.OwnerName = s.user
				t.Active = s.active
				if t.OwnerUID == 0 {
					t.OwnerUID = s.uid
				}
			}
			if t.OwnerName == "" && t.OwnerUID > 0 {
				if u := lookupUsername(t.OwnerUID); u != "" {
					t.OwnerName = u
				}
			}
			if t.XauthPath == "" {
				t.XauthPath = defaultXauthGuess(t.OwnerUID, t.OwnerName)
			}
			targets = append(targets, t)
		}
	}

	// Wayland sockets — reported but not attachable in Phase 1.
	if userDirs, err := os.ReadDir("/run/user"); err == nil {
		for _, ud := range userDirs {
			uid, err := strconv.Atoi(ud.Name())
			if err != nil {
				continue
			}
			matches, _ := filepath.Glob(filepath.Join("/run/user", ud.Name(), "wayland-*"))
			// Exclude .lock files.
			for _, m := range matches {
				if strings.HasSuffix(m, ".lock") {
					continue
				}
				targets = append(targets, DisplayTarget{
					Display:     filepath.Base(m),
					OwnerUID:    uid,
					OwnerName:   lookupUsername(uid),
					SessionType: "wayland",
				})
				break
			}
		}
	}

	if len(targets) == 0 {
		return nil, ErrNoDisplay
	}
	sort.SliceStable(targets, func(i, j int) bool {
		return rank(targets[i]) < rank(targets[j])
	})
	return targets, nil
}

// SelectX11Target returns the best attachable X11 target.
func SelectX11Target() (DisplayTarget, error) {
	targets, err := ResolveDisplayTargets()
	if err != nil {
		return DisplayTarget{}, err
	}
	sawWayland := false
	for _, t := range targets {
		if t.SessionType == "x11" && t.XauthPath != "" {
			return t, nil
		}
		if t.SessionType == "wayland" {
			sawWayland = true
		}
	}
	if sawWayland {
		return DisplayTarget{}, ErrWaylandUnsupported
	}
	return DisplayTarget{}, ErrNoDisplay
}

func rank(t DisplayTarget) int {
	switch {
	case t.SessionType == "x11" && t.Active:
		return 0
	case t.SessionType == "x11":
		return 1
	default:
		return 2
	}
}

// findXServerProc scans /proc for the Xorg/X/Xwayland process owning display :N,
// returning its pid, argv, and uid.
func findXServerProc(displayNum string) (pid int, argv []string, uid int, ok bool) {
	procs, err := os.ReadDir("/proc")
	if err != nil {
		return 0, nil, 0, false
	}
	want := ":" + displayNum
	for _, p := range procs {
		pidN, err := strconv.Atoi(p.Name())
		if err != nil {
			continue
		}
		cmdline, err := os.ReadFile(filepath.Join("/proc", p.Name(), "cmdline"))
		if err != nil {
			continue
		}
		args := splitCmdline(cmdline)
		if len(args) == 0 {
			continue
		}
		base := filepath.Base(args[0])
		if base != "Xorg" && base != "X" && base != "Xwayland" {
			continue
		}
		hasDisplay := false
		for _, a := range args {
			if a == want {
				hasDisplay = true
				break
			}
		}
		if !hasDisplay {
			continue
		}
		var st struct{ uid int }
		if fi, err := os.Stat(filepath.Join("/proc", p.Name())); err == nil {
			st.uid = statUID(fi)
		}
		return pidN, args, st.uid, true
	}
	return 0, nil, 0, false
}

func splitCmdline(b []byte) []string {
	parts := strings.Split(string(b), "\x00")
	out := parts[:0]
	for _, p := range parts {
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

// resolveXauthPath applies the resolution order: X server -auth arg → session
// leader environ XAUTHORITY → ~owner/.Xauthority → /run/user/<uid>/gdm/Xauthority.
func resolveXauthPath(authArg string, uid, pid int) string {
	if authArg != "" && filepath.IsAbs(authArg) {
		if _, err := os.Stat(authArg); err == nil {
			return authArg
		}
	}
	if pid > 0 {
		if x := environXAuthority(pid); x != "" {
			if _, err := os.Stat(x); err == nil {
				return x
			}
		}
	}
	return defaultXauthGuess(uid, "")
}

func environXAuthority(pid int) string {
	b, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "environ"))
	if err != nil {
		return ""
	}
	for _, kv := range strings.Split(string(b), "\x00") {
		if strings.HasPrefix(kv, "XAUTHORITY=") {
			return strings.TrimPrefix(kv, "XAUTHORITY=")
		}
	}
	return ""
}

func defaultXauthGuess(uid int, name string) string {
	candidates := []string{}
	if uid > 0 {
		candidates = append(candidates,
			filepath.Join("/run/user", strconv.Itoa(uid), "gdm", "Xauthority"),
			filepath.Join("/run/user", strconv.Itoa(uid), ".mutter-Xwaylandauth"),
		)
	}
	if name != "" {
		candidates = append(candidates, filepath.Join("/home", name, ".Xauthority"))
	}
	for _, c := range candidates {
		if _, err := os.Stat(c); err == nil {
			return c
		}
	}
	return ""
}

// loginctlDetails returns per-display session info keyed by ":N". Best-effort.
func loginctlDetails() map[string]struct {
	user   string
	uid    int
	active bool
} {
	result := map[string]struct {
		user   string
		uid    int
		active bool
	}{}
	out, err := exec.Command("loginctl", "list-sessions", "--no-legend", "--no-pager").Output()
	if err != nil {
		return result
	}
	for _, s := range parseLoginctlSessions(string(out)) {
		det, err := exec.Command("loginctl", "show-session", s.id,
			"-p", "Display", "-p", "Type", "-p", "Active", "-p", "State").Output()
		if err != nil {
			continue
		}
		var display, active string
		for _, line := range strings.Split(string(det), "\n") {
			k, v, ok := strings.Cut(line, "=")
			if !ok {
				continue
			}
			switch k {
			case "Display":
				display = v
			case "Active":
				active = v
			}
		}
		if display == "" {
			continue
		}
		result[display] = struct {
			user   string
			uid    int
			active bool
		}{user: s.user, uid: s.uid, active: active == "yes"}
	}
	return result
}
```

Add a tiny `//go:build linux` helper file `agent/internal/remote/desktop/x11/statuid_linux.go` for the syscall detail (keeps `resolve_linux.go` importless of `syscall`):

```go
//go:build linux

package x11

import (
	"io/fs"
	"os/user"
	"strconv"
	"syscall"
)

func statUID(fi fs.FileInfo) int {
	if st, ok := fi.Sys().(*syscall.Stat_t); ok {
		return int(st.Uid)
	}
	return 0
}

func lookupUsername(uid int) string {
	if u, err := user.LookupId(strconv.Itoa(uid)); err == nil {
		return u.Username
	}
	return ""
}
```

- [ ] **Step 6: Compile gate + run parser tests**

Run:
```bash
cd agent && CGO_ENABLED=0 GOOS=linux go build ./internal/remote/desktop/x11/ && go test ./internal/remote/desktop/x11/ -v
```
Expected: builds clean for linux; parser tests PASS. (The `/proc`/loginctl paths have no unit test — exercised in Task 15 on the rig.)

- [ ] **Step 7: Commit**

```bash
cd agent && CGO_ENABLED=0 GOOS=linux go build ./... && CGO_ENABLED=0 GOOS=darwin go build ./internal/remote/desktop/x11/
git add agent/internal/remote/desktop/x11/resolve.go agent/internal/remote/desktop/x11/resolve_linux.go agent/internal/remote/desktop/x11/resolve_other.go agent/internal/remote/desktop/x11/statuid_linux.go agent/internal/remote/desktop/x11/resolve_test.go
git commit -m "feat(agent): X11 display/session resolver for Linux remote desktop

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 6: x11 package — connection + MIT-SHM capture

**Goal:** A per-instance X connection that opens `:N` with an explicit cookie and grabs full-screen BGRX frames via MIT-SHM (with a core-protocol fallback). No process-global state.

**Files:**
- Create: `agent/internal/remote/desktop/x11/conn_linux.go` (`//go:build linux`)
- Create: `agent/internal/remote/desktop/x11/conn_other.go` (`//go:build !linux` stub)
- Test: `agent/internal/remote/desktop/x11/conn_linux_test.go` (skips without X)

**Interfaces:**
- Produces:
  ```go
  type Conn struct { /* holds *xgb.Conn, root xproto.Window, screen dims, shm seg + buf */ }
  // Open dials the display socket, injects the cookie, negotiates SHM.
  func Open(target DisplayTarget) (*Conn, error)
  func (c *Conn) Bounds() (w, h int)
  // CaptureBGRX returns a pointer to the current frame's BGRX bytes (stride w*4).
  // The slice is owned by the Conn and reused each call — copy before releasing.
  func (c *Conn) CaptureBGRX() (pix []byte, w, h int, err error)
  func (c *Conn) CaptureRegionBGRX(x, y, w, h int) (pix []byte, err error)
  func (c *Conn) Close() error
  // XConn exposes the underlying *xgb.Conn for input/cursor/monitor helpers.
  func (c *Conn) XConn() *xgb.Conn
  func (c *Conn) Root() xproto.Window
  ```

- [ ] **Step 1: Write the skip-guarded integration test**

Create `agent/internal/remote/desktop/x11/conn_linux_test.go`:

```go
//go:build linux

package x11

import (
	"os"
	"testing"
)

// probeTarget returns a real display target from the environment, or skips.
func probeTarget(t *testing.T) DisplayTarget {
	t.Helper()
	target, err := SelectX11Target()
	if err != nil {
		if d := os.Getenv("DISPLAY"); d != "" {
			return DisplayTarget{Display: d, XauthPath: os.Getenv("XAUTHORITY"), SessionType: "x11"}
		}
		t.Skipf("no X11 display available: %v", err)
	}
	return target
}

func TestOpenAndCapture(t *testing.T) {
	target := probeTarget(t)
	c, err := Open(target)
	if err != nil {
		t.Skipf("cannot open X display %s: %v", target.Display, err)
	}
	defer c.Close()
	w, h := c.Bounds()
	if w <= 0 || h <= 0 {
		t.Fatalf("bad bounds %dx%d", w, h)
	}
	pix, gw, gh, err := c.CaptureBGRX()
	if err != nil {
		t.Fatalf("capture: %v", err)
	}
	if len(pix) < gw*gh*4 {
		t.Fatalf("short frame: len=%d want>=%d", len(pix), gw*gh*4)
	}
}
```

- [ ] **Step 2: Run to verify it fails/skips**

Run: `cd agent && go test ./internal/remote/desktop/x11/ -run TestOpenAndCapture -v`
Expected: FAIL — `undefined: Open`. (After implementation, it SKIPS on the CI runner and PASSES on the rig.)

- [ ] **Step 3: Implement the non-linux stub**

Create `agent/internal/remote/desktop/x11/conn_other.go`:

```go
//go:build !linux

package x11

// Conn is unavailable off Linux.
type Conn struct{}

// Open is unsupported off Linux.
func Open(target DisplayTarget) (*Conn, error) { return nil, ErrNoDisplay }

func (c *Conn) Bounds() (int, int)                              { return 0, 0 }
func (c *Conn) CaptureBGRX() ([]byte, int, int, error)          { return nil, 0, 0, ErrNoDisplay }
func (c *Conn) CaptureRegionBGRX(x, y, w, h int) ([]byte, error) { return nil, ErrNoDisplay }
func (c *Conn) Close() error                                    { return nil }
```

- [ ] **Step 4: Implement the linux connection + capture**

Create `agent/internal/remote/desktop/x11/conn_linux.go`. Key facts (verified against jezek/xgb v1.1.1 source, API identical at v1.3.1): dial the unix socket yourself, hex-encode the cookie, `xgb.NewConnNetWithCookieHex`. SHM: `unix.SysvShmGet(unix.IPC_PRIVATE, size, unix.IPC_CREAT|0o777)`, `unix.SysvShmAttach`, `shm.NewSegId`, `shm.AttachChecked(...).Check()`, then `unix.SysvShmCtl(id, unix.IPC_RMID, nil)`. Per frame: `shm.GetImage(conn, xproto.Drawable(root), 0, 0, w, h, 0xffffffff, byte(xproto.ImageFormatZPixmap), seg, 0).Reply()` — pixels land in the attached segment buffer.

```go
//go:build linux

package x11

import (
	"encoding/hex"
	"fmt"
	"net"
	"os"
	"strconv"
	"strings"
	"sync"

	"github.com/jezek/xgb"
	"github.com/jezek/xgb/shm"
	"github.com/jezek/xgb/xproto"
	"golang.org/x/sys/unix"
)

// Conn is a per-instance X11 connection with an optional MIT-SHM capture path.
type Conn struct {
	mu     sync.Mutex
	x      *xgb.Conn
	root   xproto.Window
	width  int
	height int

	useShm bool
	shmID  int
	shmBuf []byte
	shmSeg shm.Seg
}

// Open dials the display's unix socket, injects the MIT-MAGIC-COOKIE-1, and
// negotiates MIT-SHM. All state lives on the returned Conn — nothing global.
func Open(target DisplayTarget) (*Conn, error) {
	num, err := displayNumber(target.Display)
	if err != nil {
		return nil, err
	}
	sock, err := net.Dial("unix", "/tmp/.X11-unix/X"+num)
	if err != nil {
		return nil, fmt.Errorf("dial X socket: %w", err)
	}

	cookieHex := ""
	if target.XauthPath != "" {
		if blob, rerr := os.ReadFile(target.XauthPath); rerr == nil {
			host, _ := os.Hostname()
			if cookie, ferr := FindMitMagicCookie(blob, num, host); ferr == nil {
				cookieHex = hex.EncodeToString(cookie)
			}
		}
	}

	x, err := xgb.NewConnNetWithCookieHex(sock, cookieHex)
	if err != nil {
		sock.Close()
		return nil, fmt.Errorf("x11 auth/connect: %w", err)
	}

	setup := xproto.Setup(x)
	screen := setup.DefaultScreen(x)
	c := &Conn{
		x:      x,
		root:   screen.Root,
		width:  int(screen.WidthInPixels),
		height: int(screen.HeightInPixels),
	}
	c.initShm()
	return c, nil
}

func displayNumber(display string) (string, error) {
	d := strings.TrimPrefix(display, ":")
	if i := strings.IndexByte(d, '.'); i >= 0 {
		d = d[:i]
	}
	if _, err := strconv.Atoi(d); err != nil {
		return "", fmt.Errorf("bad display %q", display)
	}
	return d, nil
}

func (c *Conn) initShm() {
	if err := shm.Init(c.x); err != nil {
		c.useShm = false
		return
	}
	size := c.width * c.height * 4
	id, err := unix.SysvShmGet(unix.IPC_PRIVATE, size, unix.IPC_CREAT|0o777)
	if err != nil {
		c.useShm = false
		return
	}
	buf, err := unix.SysvShmAttach(id, 0, 0)
	if err != nil {
		_, _ = unix.SysvShmCtl(id, unix.IPC_RMID, nil)
		c.useShm = false
		return
	}
	seg, err := shm.NewSegId(c.x)
	if err != nil {
		_ = unix.SysvShmDetach(buf)
		_, _ = unix.SysvShmCtl(id, unix.IPC_RMID, nil)
		c.useShm = false
		return
	}
	if err := shm.AttachChecked(c.x, seg, uint32(id), false).Check(); err != nil {
		_ = unix.SysvShmDetach(buf)
		_, _ = unix.SysvShmCtl(id, unix.IPC_RMID, nil)
		c.useShm = false
		return
	}
	// Mark for deletion now; the segment persists until both ends detach.
	_, _ = unix.SysvShmCtl(id, unix.IPC_RMID, nil)
	c.useShm = true
	c.shmID = id
	c.shmBuf = buf
	c.shmSeg = seg
}

// Bounds returns the current root-window dimensions.
func (c *Conn) Bounds() (int, int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.width, c.height
}

// XConn exposes the underlying connection for input/cursor/monitor helpers.
func (c *Conn) XConn() *xgb.Conn      { return c.x }
func (c *Conn) Root() xproto.Window   { return c.root }

// CaptureBGRX grabs a full-screen frame. With SHM the pixels land in the shared
// segment (returned slice is owned by the Conn); the fallback allocates.
func (c *Conn) CaptureBGRX() ([]byte, int, int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	w, h := c.width, c.height
	if c.useShm {
		_, err := shm.GetImage(c.x, xproto.Drawable(c.root), 0, 0, uint16(w), uint16(h),
			0xffffffff, byte(xproto.ImageFormatZPixmap), c.shmSeg, 0).Reply()
		if err != nil {
			return nil, 0, 0, fmt.Errorf("shm getimage: %w", err)
		}
		return c.shmBuf[:w*h*4], w, h, nil
	}
	reply, err := xproto.GetImage(c.x, xproto.ImageFormatZPixmap, xproto.Drawable(c.root),
		0, 0, uint16(w), uint16(h), 0xffffffff).Reply()
	if err != nil {
		return nil, 0, 0, fmt.Errorf("getimage: %w", err)
	}
	return reply.Data, w, h, nil
}

// CaptureRegionBGRX grabs a sub-region via the core protocol (always allocates).
func (c *Conn) CaptureRegionBGRX(x, y, w, h int) ([]byte, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	reply, err := xproto.GetImage(c.x, xproto.ImageFormatZPixmap, xproto.Drawable(c.root),
		int16(x), int16(y), uint16(w), uint16(h), 0xffffffff).Reply()
	if err != nil {
		return nil, fmt.Errorf("getimage region: %w", err)
	}
	return reply.Data, nil
}

// Close detaches SHM and closes the X connection. Safe to call twice.
func (c *Conn) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.useShm {
		_ = shm.Detach(c.x, c.shmSeg)
		_ = unix.SysvShmDetach(c.shmBuf)
		c.useShm = false
	}
	if c.x != nil {
		c.x.Close()
		c.x = nil
	}
	return nil
}
```

- [ ] **Step 5: Compile gate + run**

Run:
```bash
cd agent && CGO_ENABLED=0 GOOS=linux go build ./internal/remote/desktop/x11/ && go test ./internal/remote/desktop/x11/ -run TestOpenAndCapture -v
```
Expected: builds; test SKIPS on a host with no X. (Real capture proven in Task 15.)

- [ ] **Step 6: Commit**

```bash
cd agent && CGO_ENABLED=0 GOOS=linux go build ./... && CGO_ENABLED=0 GOOS=darwin go build ./internal/remote/desktop/x11/
git add agent/internal/remote/desktop/x11/conn_linux.go agent/internal/remote/desktop/x11/conn_other.go agent/internal/remote/desktop/x11/conn_linux_test.go
git commit -m "feat(agent): per-instance X11 connection + MIT-SHM capture (no CGO)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 7: Keysym table + keyboard-mapping reverse lookup

**Goal:** Translate viewer key names/characters to X keysym values (pure table, untagged), and resolve keysym → (keycode, needShift) via `xproto.GetKeyboardMapping` (linux). Replaces Xlib's `XStringToKeysym`.

**Files:**
- Create: `agent/internal/remote/desktop/x11/keysym.go` (untagged — name→keysym table + char rules)
- Create: `agent/internal/remote/desktop/x11/keymap_linux.go` (`//go:build linux` — GetKeyboardMapping reverse map)
- Test: `agent/internal/remote/desktop/x11/keysym_test.go`

**Interfaces:**
- Produces:
  ```go
  // KeysymForName maps a viewer key name (e.g. "enter","Left","a","F5","-") to an
  // X keysym value. Returns (0,false) if unknown.
  func KeysymForName(name string) (uint32, bool)
  // KeysymForRune maps a printable rune to a keysym (Latin-1 identity, else the
  // 0x01000000|codepoint Unicode convention).
  func KeysymForRune(r rune) uint32
  // (linux) KeyMap resolves keysym → keycode+shift from a live connection.
  type KeyMap struct { /* ... */ }
  func LoadKeyMap(x *xgb.Conn) (*KeyMap, error)
  func (k *KeyMap) Resolve(keysym uint32) (keycode xproto.Keycode, needShift bool, ok bool)
  func (k *KeyMap) ShiftKeycode() xproto.Keycode
  ```

- [ ] **Step 1: Write the failing table test**

Create `agent/internal/remote/desktop/x11/keysym_test.go`:

```go
package x11

import "testing"

func TestKeysymForName(t *testing.T) {
	cases := map[string]uint32{
		"enter": 0xFF0D, "Return": 0xFF0D, "tab": 0xFF09, "space": 0x20,
		"backspace": 0xFF08, "escape": 0xFF1B, "left": 0xFF51, "up": 0xFF52,
		"right": 0xFF53, "down": 0xFF54, "pageup": 0xFF55, "home": 0xFF50,
		"f1": 0xFFBE, "f12": 0xFFC9, "-": 0x2D, "a": 0x61, "A": 0x41,
		"shift": 0xFFE1, "ctrl": 0xFFE3, "alt": 0xFFE9,
	}
	for name, want := range cases {
		got, ok := KeysymForName(name)
		if !ok || got != want {
			t.Errorf("KeysymForName(%q) = 0x%X,%v; want 0x%X", name, got, ok, want)
		}
	}
	if _, ok := KeysymForName("totally-unknown-key"); ok {
		t.Errorf("unknown key should return ok=false")
	}
}

func TestKeysymForRune(t *testing.T) {
	if KeysymForRune('A') != 0x41 {
		t.Errorf("latin1 identity failed")
	}
	if KeysymForRune('é') != (0x01000000 | 0xE9) {
		t.Errorf("unicode keysym convention failed: got 0x%X", KeysymForRune('é'))
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd agent && go test ./internal/remote/desktop/x11/ -run 'TestKeysymForName|TestKeysymForRune' -v`
Expected: FAIL — undefined.

- [ ] **Step 3: Implement the keysym table**

Create `agent/internal/remote/desktop/x11/keysym.go`. Port the name set from the existing `input_linux.go:129 translateKey` switch, but emit keysym **values** (from the research: Return 0xFF0D, Tab 0xFF09, space 0x20, BackSpace 0xFF08, Escape 0xFF1B, Delete 0xFFFF, Insert 0xFF63, Home 0xFF50, Left/Up/Right/Down 0xFF51-54, Page_Up/Down 0xFF55/56, End 0xFF57, F1-F12 0xFFBE-0xFFC9, KP_0-9 0xFFB0-B9, Caps_Lock 0xFFE5, Num_Lock 0xFF7F, Print 0xFF61, Pause 0xFF13, Shift_L 0xFFE1, Control_L 0xFFE3, Alt_L 0xFFE9, Super_L 0xFFEB, and punctuation minus 0x2D, equal 0x3D, bracketleft/right 0x5B/5D, backslash 0x5C, semicolon 0x3B, apostrophe 0x27, grave 0x60, comma 0x2C, period 0x2E, slash 0x2F):

```go
package x11

import "strings"

// namedKeysyms maps lower-cased viewer key names to X keysym values.
var namedKeysyms = map[string]uint32{
	"enter": 0xFF0D, "return": 0xFF0D, "tab": 0xFF09, "space": 0x20,
	"backspace": 0xFF08, "escape": 0xFF1B, "esc": 0xFF1B, "delete": 0xFFFF,
	"insert": 0xFF63, "home": 0xFF50, "end": 0xFF57,
	"left": 0xFF51, "up": 0xFF52, "right": 0xFF53, "down": 0xFF54,
	"pageup": 0xFF55, "pagedown": 0xFF56,
	"f1": 0xFFBE, "f2": 0xFFBF, "f3": 0xFFC0, "f4": 0xFFC1, "f5": 0xFFC2,
	"f6": 0xFFC3, "f7": 0xFFC4, "f8": 0xFFC5, "f9": 0xFFC6, "f10": 0xFFC7,
	"f11": 0xFFC8, "f12": 0xFFC9,
	"num0": 0xFFB0, "num1": 0xFFB1, "num2": 0xFFB2, "num3": 0xFFB3, "num4": 0xFFB4,
	"num5": 0xFFB5, "num6": 0xFFB6, "num7": 0xFFB7, "num8": 0xFFB8, "num9": 0xFFB9,
	"capslock": 0xFFE5, "numlock": 0xFF7F, "scrolllock": 0xFF14,
	"printscreen": 0xFF61, "print": 0xFF61, "pause": 0xFF13,
	"shift": 0xFFE1, "ctrl": 0xFFE3, "control": 0xFFE3, "alt": 0xFFE9,
	"meta": 0xFFEB, "super": 0xFFEB, "cmd": 0xFFEB,
	"-": 0x2D, "=": 0x3D, "[": 0x5B, "]": 0x5D, "\\": 0x5C, ";": 0x3B,
	"'": 0x27, "`": 0x60, ",": 0x2C, ".": 0x2E, "/": 0x2F,
}

// KeysymForName maps a viewer key name to an X keysym value.
func KeysymForName(name string) (uint32, bool) {
	if name == "" {
		return 0, false
	}
	if ks, ok := namedKeysyms[strings.ToLower(name)]; ok {
		return ks, true
	}
	// Single printable character (case-sensitive): identity for Latin-1.
	r := []rune(name)
	if len(r) == 1 {
		return KeysymForRune(r[0]), true
	}
	return 0, false
}

// KeysymForRune maps a rune to a keysym: Latin-1 is identity, other Unicode uses
// the 0x01000000|codepoint convention.
func KeysymForRune(r rune) uint32 {
	if (r >= 0x20 && r <= 0x7E) || (r >= 0xA0 && r <= 0xFF) {
		return uint32(r)
	}
	return 0x01000000 | uint32(r)
}
```

- [ ] **Step 4: Implement the linux keyboard-mapping reverse lookup**

Create `agent/internal/remote/desktop/x11/keymap_linux.go`:

```go
//go:build linux

package x11

import (
	"fmt"

	"github.com/jezek/xgb"
	"github.com/jezek/xgb/xproto"
)

// KeyMap resolves keysym → (keycode, needShift) from a live server mapping.
type KeyMap struct {
	minKeycode  xproto.Keycode
	perKeycode  int
	keysyms     []xproto.Keysym
	shiftKeyc   xproto.Keycode
	reverse     map[uint32]resolved
}

type resolved struct {
	keycode xproto.Keycode
	shift   bool
}

// LoadKeyMap fetches the full keyboard mapping and builds a reverse index.
func LoadKeyMap(x *xgb.Conn) (*KeyMap, error) {
	setup := xproto.Setup(x)
	count := int(setup.MaxKeycode) - int(setup.MinKeycode) + 1
	if count <= 0 {
		return nil, fmt.Errorf("bad keycode range")
	}
	reply, err := xproto.GetKeyboardMapping(x, setup.MinKeycode, byte(count)).Reply()
	if err != nil {
		return nil, fmt.Errorf("get keyboard mapping: %w", err)
	}
	km := &KeyMap{
		minKeycode: setup.MinKeycode,
		perKeycode: int(reply.KeysymsPerKeycode),
		keysyms:    reply.Keysyms,
		reverse:    make(map[uint32]resolved),
	}
	for kc := 0; kc < count; kc++ {
		for col := 0; col < km.perKeycode; col++ {
			ks := uint32(km.keysyms[kc*km.perKeycode+col])
			if ks == 0 {
				continue
			}
			keycode := xproto.Keycode(int(setup.MinKeycode) + kc)
			if ks == 0xFFE1 { // Shift_L
				km.shiftKeyc = keycode
			}
			// Prefer the unshifted (col 0) binding; don't overwrite it.
			if existing, ok := km.reverse[ks]; ok && !existing.shift {
				continue
			}
			km.reverse[ks] = resolved{keycode: keycode, shift: col == 1}
		}
	}
	return km, nil
}

// Resolve returns the keycode and whether Shift must be held for a keysym.
func (k *KeyMap) Resolve(keysym uint32) (xproto.Keycode, bool, bool) {
	r, ok := k.reverse[keysym]
	return r.keycode, r.shift, ok
}

// ShiftKeycode returns the Shift_L keycode (0 if not found).
func (k *KeyMap) ShiftKeycode() xproto.Keycode { return k.shiftKeyc }
```

- [ ] **Step 5: Run to verify table tests pass + compile gate**

Run:
```bash
cd agent && go test ./internal/remote/desktop/x11/ -run 'TestKeysymForName|TestKeysymForRune' -v && CGO_ENABLED=0 GOOS=linux go build ./internal/remote/desktop/x11/
```
Expected: table tests PASS; linux build clean.

- [ ] **Step 6: Commit**

```bash
git add agent/internal/remote/desktop/x11/keysym.go agent/internal/remote/desktop/x11/keymap_linux.go agent/internal/remote/desktop/x11/keysym_test.go
git commit -m "feat(agent): X11 keysym table + keyboard-mapping reverse lookup

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 8: Port linuxCapturer onto the x11 package

**Goal:** Rewrite `capture_linux.go` and `cursor_linux.go` as one `//go:build linux` (no cgo) capturer backed by the `x11` package. Delete the `linux && cgo` / `linux && !cgo` split (remove `capture_linux_nocgo.go`). The capturer resolves its own display target (so standalone tool/probe paths work) and implements `ScreenCapturer` + `BGRAProvider` + `CursorProvider` + `CursorShapeProvider`. **All state per-instance** — no package globals.

**Files:**
- Rewrite: `agent/internal/remote/desktop/capture_linux.go` (new build tag `//go:build linux`)
- Delete: `agent/internal/remote/desktop/capture_linux_nocgo.go`
- Rewrite: `agent/internal/remote/desktop/cursor_linux.go` (new build tag `//go:build linux`, xfixes-based)
- Create: `agent/internal/remote/desktop/x11/cursor_linux.go` (`//go:build linux` — xfixes cursor)
- Test: `agent/internal/remote/desktop/capture_linux_test.go` (`//go:build linux`, skip-guarded)

**Interfaces:**
- Consumes: `x11.SelectX11Target`, `x11.Open`, `Conn.CaptureBGRX/CaptureRegionBGRX/Bounds/Close/XConn/Root`, `CaptureConfig`, `ScreenCapturer`, `BGRAProvider`, `CursorProvider`, `CursorShapeProvider`.
- Produces: `newPlatformCapturer(config CaptureConfig) (ScreenCapturer, error)` for `linux`. The `x11` cursor helper: `func CursorImageAndName(x *xgb.Conn) (x2, y int, name string, ok bool)`.

- [ ] **Step 1: Add the xfixes cursor helper to the x11 package**

Create `agent/internal/remote/desktop/x11/cursor_linux.go`:

```go
//go:build linux

package x11

import (
	"github.com/jezek/xgb"
	"github.com/jezek/xgb/xfixes"
)

// CursorTracker owns a dedicated X connection for 120Hz cursor polling so it
// never contends with the capture connection (mirrors the old cgo design).
type CursorTracker struct {
	x *xgb.Conn
}

// NewCursorTracker opens a second connection to the same target for cursor polls.
func NewCursorTracker(target DisplayTarget) (*CursorTracker, error) {
	c, err := Open(target)
	if err != nil {
		return nil, err
	}
	if err := xfixes.Init(c.x); err != nil {
		c.Close()
		return nil, err
	}
	// XFixes requires a version negotiation before any cursor request.
	if _, err := xfixes.QueryVersion(c.x, 4, 0).Reply(); err != nil {
		c.Close()
		return nil, err
	}
	// Stash only the raw conn; we keep the Conn alive via closure on Close.
	t := &CursorTracker{x: c.x}
	// Prevent Conn.Close's SHM path (this conn has none) from double-closing x.
	t.owner = c
	return t, nil
}

// Poll returns the cursor position, its X11 name (for CSS mapping), and validity.
func (t *CursorTracker) Poll() (x, y int, name string, ok bool) {
	reply, err := xfixes.GetCursorImageAndName(t.x).Reply()
	if err != nil {
		return 0, 0, "", false
	}
	nm := atomName(t.x, reply.CursorAtom)
	return int(reply.X), int(reply.Y), nm, true
}

func (t *CursorTracker) Close() { t.owner.Close() }
```

Add the `owner` field and the small `atomName` helper (use `xproto.GetAtomName`) — put `owner *Conn` in the struct and:

```go
func atomName(x *xgb.Conn, atom xproto.Atom) string {
	if atom == 0 {
		return ""
	}
	reply, err := xproto.GetAtomName(x, atom).Reply()
	if err != nil {
		return ""
	}
	return string(reply.Name)
}
```

(Add `"github.com/jezek/xgb/xproto"` import. Confirm the exact field name for the cursor's name atom on `GetCursorImageAndNameReply` when implementing — the research names the reply type; use `go doc github.com/jezek/xgb/xfixes GetCursorImageAndNameReply` to confirm `CursorAtom` vs `Name`.)

- [ ] **Step 2: Write the skip-guarded capturer test**

Create `agent/internal/remote/desktop/capture_linux_test.go`:

```go
//go:build linux

package desktop

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/remote/desktop/x11"
)

func TestLinuxCapturerImplementsInterfaces(t *testing.T) {
	var c ScreenCapturer = &linuxCapturer{}
	if _, ok := c.(BGRAProvider); !ok {
		t.Error("linuxCapturer must implement BGRAProvider")
	}
	if _, ok := c.(CursorProvider); !ok {
		t.Error("linuxCapturer must implement CursorProvider")
	}
	if _, ok := c.(CursorShapeProvider); !ok {
		t.Error("linuxCapturer must implement CursorShapeProvider")
	}
}

func TestLinuxCapturerCaptureIfDisplay(t *testing.T) {
	if _, err := x11.SelectX11Target(); err != nil {
		t.Skipf("no X display: %v", err)
	}
	cap, err := newPlatformCapturer(DefaultConfig())
	if err != nil {
		t.Skipf("cannot create capturer: %v", err)
	}
	defer cap.Close()
	img, err := cap.Capture()
	if err != nil {
		t.Fatalf("capture: %v", err)
	}
	if img.Bounds().Dx() == 0 {
		t.Fatal("zero-width frame")
	}
	if bgra, ok := cap.(BGRAProvider); !ok || !bgra.IsBGRA() {
		t.Fatal("linux capturer should report BGRA")
	}
}
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd agent && CGO_ENABLED=0 go test ./internal/remote/desktop/ -run TestLinuxCapturer -v`
Expected: FAIL (the current `capture_linux.go` is `linux && cgo` so under CGO off the nocgo stub compiles and `linuxCapturer` is undefined in the test's build).

- [ ] **Step 4: Delete the nocgo stub and rewrite the capturer**

Delete `agent/internal/remote/desktop/capture_linux_nocgo.go`.

Rewrite `agent/internal/remote/desktop/capture_linux.go`:

```go
//go:build linux

package desktop

import (
	"fmt"
	"image"
	"sync"
	"sync/atomic"

	"github.com/breeze-rmm/agent/internal/remote/desktop/x11"
)

// linuxCapturer mirrors an X11 session over the wire (no CGO). All state is
// per-instance so concurrent capturers (WS + WebRTC, screenshot borrows,
// monitor switch, cursor loop) never share or destroy each other's connection.
type linuxCapturer struct {
	config CaptureConfig

	mu   sync.Mutex
	conn *x11.Conn

	cursor      *x11.CursorTracker
	cursorShape atomic.Value // string (CSS cursor)
}

func newPlatformCapturer(config CaptureConfig) (ScreenCapturer, error) {
	target, err := x11.SelectX11Target()
	if err != nil {
		return nil, mapResolveErr(err)
	}
	conn, err := x11.Open(target)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrDisplayNotFound, err)
	}
	c := &linuxCapturer{config: config, conn: conn}
	// Cursor tracker is best-effort; capture still works without it.
	if ct, cerr := x11.NewCursorTracker(target); cerr == nil {
		c.cursor = ct
	}
	c.cursorShape.Store("default")
	return c, nil
}

func mapResolveErr(err error) error {
	switch {
	case err == x11.ErrWaylandUnsupported:
		return fmt.Errorf("%w: wayland session not supported", ErrNotSupported)
	default:
		return fmt.Errorf("%w: %v", ErrDisplayNotFound, err)
	}
}

// Capture returns a full-screen frame as image.RGBA whose Pix is BGRX (see IsBGRA).
func (c *linuxCapturer) Capture() (*image.RGBA, error) {
	c.mu.Lock()
	conn := c.conn
	c.mu.Unlock()
	if conn == nil {
		return nil, ErrNoActiveSession
	}
	pix, w, h, err := conn.CaptureBGRX()
	if err != nil {
		return nil, err
	}
	img := &image.RGBA{
		Pix:    make([]byte, len(pix)),
		Stride: w * 4,
		Rect:   image.Rect(0, 0, w, h),
	}
	copy(img.Pix, pix) // SHM buffer is reused next call — must copy
	return img, nil
}

func (c *linuxCapturer) CaptureRegion(x, y, width, height int) (*image.RGBA, error) {
	c.mu.Lock()
	conn := c.conn
	c.mu.Unlock()
	if conn == nil {
		return nil, ErrNoActiveSession
	}
	pix, err := conn.CaptureRegionBGRX(x, y, width, height)
	if err != nil {
		return nil, err
	}
	img := &image.RGBA{Pix: pix, Stride: width * 4, Rect: image.Rect(0, 0, width, height)}
	return img, nil
}

func (c *linuxCapturer) GetScreenBounds() (int, int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.conn == nil {
		return 0, 0, ErrNoActiveSession
	}
	w, h := c.conn.Bounds()
	return w, h, nil
}

func (c *linuxCapturer) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.cursor != nil {
		c.cursor.Close()
		c.cursor = nil
	}
	if c.conn != nil {
		err := c.conn.Close()
		c.conn = nil
		return err
	}
	return nil
}

// IsBGRA reports that Capture()'s Pix holds BGRX, not RGBA — the encoder skips
// the conversion. (X ZPixmap on little-endian amd64/arm64 is BGRX.)
func (c *linuxCapturer) IsBGRA() bool { return true }

// CursorPosition polls the cursor on the dedicated connection and updates shape.
func (c *linuxCapturer) CursorPosition() (x, y int32, visible bool) {
	c.mu.Lock()
	ct := c.cursor
	c.mu.Unlock()
	if ct == nil {
		return 0, 0, false
	}
	px, py, name, ok := ct.Poll()
	if !ok {
		return 0, 0, false
	}
	c.cursorShape.Store(mapX11CursorToCSS(name))
	return int32(px), int32(py), true
}

func (c *linuxCapturer) CursorShape() string {
	if v, ok := c.cursorShape.Load().(string); ok {
		return v
	}
	return "default"
}
```

Move `mapX11CursorToCSS` and its `x11CursorNameToCSS` table out of the old cgo `cursor_linux.go` into the new (rewritten) `cursor_linux.go` (still `//go:build linux`, now pure Go — it's just a string map). Rewrite `cursor_linux.go` to contain only that mapping function (the actual cursor polling now lives in `x11.CursorTracker`), preserving the ~60-entry `left_ptr→default`, `xterm→text`, `hand2→pointer`, etc. table verbatim from the original.

- [ ] **Step 5: Run to verify it passes / compiles**

Run:
```bash
cd agent && CGO_ENABLED=0 go build ./... && CGO_ENABLED=0 go test ./internal/remote/desktop/ -run TestLinuxCapturer -v
```
Expected: builds clean (no more cgo capturer); `TestLinuxCapturerImplementsInterfaces` PASSES; the capture test SKIPS on CI (no X).

- [ ] **Step 6: Commit**

```bash
git rm agent/internal/remote/desktop/capture_linux_nocgo.go
git add agent/internal/remote/desktop/capture_linux.go agent/internal/remote/desktop/cursor_linux.go agent/internal/remote/desktop/x11/cursor_linux.go agent/internal/remote/desktop/capture_linux_test.go
git commit -m "feat(agent): pure-Go X11 capturer (no CGO), per-instance state

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 9: Monitor enumeration via RandR

**Goal:** Real `ListMonitors` on Linux via `randr.GetMonitors`, mapping to `MonitorInfo{Index,Name,Width,Height,X,Y,IsPrimary}`. Retag the shared stub so it no longer shadows Linux.

**Files:**
- Create: `agent/internal/remote/desktop/monitor_linux.go` (`//go:build linux`)
- Modify: `agent/internal/remote/desktop/monitor_other.go` (change tag `//go:build !windows` → `//go:build !windows && !linux`)
- Create: `agent/internal/remote/desktop/x11/monitor_linux.go` (`//go:build linux` — randr query)
- Test: `agent/internal/remote/desktop/monitor_linux_test.go` (skip-guarded)

**Interfaces:**
- Consumes: existing `MonitorInfo` (`monitor.go:4-12`), the capturer's `x11.Conn`.
- Produces: `func ListMonitors() []MonitorInfo` for linux; `x11` helper `func Monitors(x *xgb.Conn, root xproto.Window) ([]MonitorGeom, error)`.

- [ ] **Step 1: Write the skip-guarded test**

Create `agent/internal/remote/desktop/monitor_linux_test.go`:

```go
//go:build linux

package desktop

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/remote/desktop/x11"
)

func TestListMonitorsLinux(t *testing.T) {
	if _, err := x11.SelectX11Target(); err != nil {
		t.Skipf("no X display: %v", err)
	}
	mons := ListMonitors()
	if len(mons) == 0 {
		t.Fatal("expected at least one monitor")
	}
	if mons[0].Width == 0 || mons[0].Height == 0 {
		t.Fatalf("bad monitor geometry: %+v", mons[0])
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd agent && CGO_ENABLED=0 go test ./internal/remote/desktop/ -run TestListMonitorsLinux -v`
Expected: FAIL — `ListMonitors` is currently the `!windows` stub, and there's no `monitor_linux.go`; duplicate-symbol or wrong result.

- [ ] **Step 3: Implement the x11 randr query**

Create `agent/internal/remote/desktop/x11/monitor_linux.go`:

```go
//go:build linux

package x11

import (
	"fmt"

	"github.com/jezek/xgb"
	"github.com/jezek/xgb/randr"
	"github.com/jezek/xgb/xproto"
)

// MonitorGeom is a display monitor's geometry (RandR 1.5).
type MonitorGeom struct {
	Name    string
	X, Y    int
	Width   int
	Height  int
	Primary bool
}

// Monitors queries RandR 1.5 GetMonitors, falling back to the root screen size.
func Monitors(x *xgb.Conn, root xproto.Window, screenW, screenH int) ([]MonitorGeom, error) {
	if err := randr.Init(x); err != nil {
		return []MonitorGeom{{Name: "default", Width: screenW, Height: screenH, Primary: true}}, nil
	}
	reply, err := randr.GetMonitors(x, root, true).Reply()
	if err != nil || len(reply.Monitors) == 0 {
		return []MonitorGeom{{Name: "default", Width: screenW, Height: screenH, Primary: true}}, nil
	}
	out := make([]MonitorGeom, 0, len(reply.Monitors))
	for _, m := range reply.Monitors {
		name := atomName(x, xproto.Atom(m.Name))
		out = append(out, MonitorGeom{
			Name:    name,
			X:       int(m.X),
			Y:       int(m.Y),
			Width:   int(m.Width),
			Height:  int(m.Height),
			Primary: m.Primary,
		})
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("no monitors")
	}
	return out, nil
}
```

- [ ] **Step 4: Implement ListMonitors for linux + retag the stub**

Create `agent/internal/remote/desktop/monitor_linux.go`:

```go
//go:build linux

package desktop

import "github.com/breeze-rmm/agent/internal/remote/desktop/x11"

// ListMonitors enumerates monitors on the resolved X display via RandR. Returns
// a single default monitor if no display is attachable (keeps callers safe).
func ListMonitors() []MonitorInfo {
	target, err := x11.SelectX11Target()
	if err != nil {
		return []MonitorInfo{{Index: 0, Name: "Default", Width: 1920, Height: 1080, IsPrimary: true}}
	}
	conn, err := x11.Open(target)
	if err != nil {
		return []MonitorInfo{{Index: 0, Name: "Default", Width: 1920, Height: 1080, IsPrimary: true}}
	}
	defer conn.Close()
	w, h := conn.Bounds()
	geoms, err := x11.Monitors(conn.XConn(), conn.Root(), w, h)
	if err != nil || len(geoms) == 0 {
		return []MonitorInfo{{Index: 0, Name: "Default", Width: w, Height: h, IsPrimary: true}}
	}
	mons := make([]MonitorInfo, 0, len(geoms))
	for i, g := range geoms {
		name := g.Name
		if name == "" {
			name = "Monitor"
		}
		mons = append(mons, MonitorInfo{
			Index: i, Name: name, Width: g.Width, Height: g.Height,
			X: g.X, Y: g.Y, IsPrimary: g.Primary,
		})
	}
	return mons
}
```

In `agent/internal/remote/desktop/monitor_other.go`, change the build tag from `//go:build !windows` to `//go:build !windows && !linux`.

- [ ] **Step 5: Run to verify it passes / compiles**

Run:
```bash
cd agent && CGO_ENABLED=0 go build ./... && CGO_ENABLED=0 go test ./internal/remote/desktop/ -run TestListMonitorsLinux -v
```
Expected: builds (no duplicate `ListMonitors`); test SKIPS on CI, would pass on the rig.

- [ ] **Step 6: Commit**

```bash
git add agent/internal/remote/desktop/monitor_linux.go agent/internal/remote/desktop/monitor_other.go agent/internal/remote/desktop/x11/monitor_linux.go agent/internal/remote/desktop/monitor_linux_test.go
git commit -m "feat(agent): RandR monitor enumeration on Linux

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 10: XTest input handler

**Goal:** Replace the xdotool-exec `LinuxInputHandler` with an XTEST implementation that owns its own resolved X connection (the AI `computer_action` path builds an input handler with no capturer present). Preserve the `InputHandler` interface and viewer keymap contract.

**Files:**
- Rewrite: `agent/internal/remote/desktop/input_linux.go` (still `//go:build linux`, now XTEST-based)
- Create: `agent/internal/remote/desktop/x11/input_linux.go` (`//go:build linux` — XTEST wrappers)
- Test: `agent/internal/remote/desktop/input_linux_test.go` (skip-guarded)

**Interfaces:**
- Consumes: `InputHandler` (`input.go:15-58`), `x11.SelectX11Target/Open`, `x11.LoadKeyMap`, `x11.KeysymForName`, `xtest.FakeInputChecked`.
- Produces: `NewInputHandler(desktopContext string) InputHandler` for linux (unchanged signature).

- [ ] **Step 1: Implement the x11 XTEST wrappers**

Create `agent/internal/remote/desktop/x11/input_linux.go`:

```go
//go:build linux

package x11

import (
	"fmt"

	"github.com/jezek/xgb/xproto"
	"github.com/jezek/xgb/xtest"
)

// Injector performs synthetic input on a dedicated X connection via XTEST.
type Injector struct {
	conn   *Conn
	keymap *KeyMap
	root   xproto.Window
}

// NewInjector resolves the display, opens a connection, and inits XTEST.
func NewInjector() (*Injector, error) {
	target, err := SelectX11Target()
	if err != nil {
		return nil, err
	}
	conn, err := Open(target)
	if err != nil {
		return nil, err
	}
	if err := xtest.Init(conn.x); err != nil {
		conn.Close()
		return nil, fmt.Errorf("xtest init: %w", err)
	}
	km, err := LoadKeyMap(conn.x)
	if err != nil {
		conn.Close()
		return nil, err
	}
	return &Injector{conn: conn, keymap: km, root: conn.root}, nil
}

func (in *Injector) Available() bool { return in != nil && in.conn != nil }

func (in *Injector) MoveMouse(x, y int) error {
	return xtest.FakeInputChecked(in.conn.x, xproto.MotionNotify, 0,
		xproto.TimeCurrentTime, in.root, int16(x), int16(y), 0).Check()
}

func (in *Injector) button(button byte, press bool) error {
	t := byte(xproto.ButtonPress)
	if !press {
		t = xproto.ButtonRelease
	}
	return xtest.FakeInputChecked(in.conn.x, t, button,
		xproto.TimeCurrentTime, in.root, 0, 0, 0).Check()
}

func (in *Injector) ButtonDown(button byte) error { return in.button(button, true) }
func (in *Injector) ButtonUp(button byte) error   { return in.button(button, false) }

func (in *Injector) key(keycode xproto.Keycode, press bool) error {
	t := byte(xproto.KeyPress)
	if !press {
		t = xproto.KeyRelease
	}
	return xtest.FakeInputChecked(in.conn.x, t, byte(keycode),
		xproto.TimeCurrentTime, in.root, 0, 0, 0).Check()
}

// KeyByName presses+releases a named key, holding Shift when required.
func (in *Injector) KeyByName(name string) error {
	ks, ok := KeysymForName(name)
	if !ok {
		return fmt.Errorf("unknown key %q", name)
	}
	return in.KeyBySym(ks)
}

func (in *Injector) KeyBySym(keysym uint32) error {
	kc, needShift, ok := in.keymap.Resolve(keysym)
	if !ok {
		return fmt.Errorf("keysym 0x%X not mappable on current layout", keysym)
	}
	shiftKc := in.keymap.ShiftKeycode()
	if needShift && shiftKc != 0 {
		_ = in.key(shiftKc, true)
		defer in.key(shiftKc, false)
	}
	if err := in.key(kc, true); err != nil {
		return err
	}
	return in.key(kc, false)
}

func (in *Injector) KeyDownByName(name string) error {
	ks, ok := KeysymForName(name)
	if !ok {
		return fmt.Errorf("unknown key %q", name)
	}
	kc, _, ok := in.keymap.Resolve(ks)
	if !ok {
		return fmt.Errorf("keysym 0x%X not mappable", ks)
	}
	return in.key(kc, true)
}

func (in *Injector) KeyUpByName(name string) error {
	ks, ok := KeysymForName(name)
	if !ok {
		return fmt.Errorf("unknown key %q", name)
	}
	kc, _, ok := in.keymap.Resolve(ks)
	if !ok {
		return fmt.Errorf("keysym 0x%X not mappable", ks)
	}
	return in.key(kc, false)
}

func (in *Injector) Close() {
	if in.conn != nil {
		in.conn.Close()
		in.conn = nil
	}
}
```

- [ ] **Step 2: Rewrite input_linux.go**

Rewrite `agent/internal/remote/desktop/input_linux.go` (keep `//go:build linux`; drop all xdotool exec). Preserve the modifier-name conventions from the old `SendKeyPress` (`ctrl`,`alt`,`shift`,`super`). Scroll uses XTEST buttons 4/5 (vertical) and 6/7 (horizontal). Lazy-open the injector on first use so constructing a handler never blocks/fails when no display exists yet:

```go
//go:build linux

package desktop

import (
	"sync"

	"github.com/breeze-rmm/agent/internal/remote/desktop/x11"
)

// LinuxInputHandler injects input via XTEST on a lazily-opened X connection.
type LinuxInputHandler struct {
	mu       sync.Mutex
	inj      *x11.Injector
	offX     int
	offY     int
	tried    bool
}

func NewInputHandler(_ string) InputHandler { return &LinuxInputHandler{} }

func (h *LinuxInputHandler) injector() *x11.Injector {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.inj != nil {
		return h.inj
	}
	if h.tried {
		return nil
	}
	h.tried = true
	if inj, err := x11.NewInjector(); err == nil {
		h.inj = inj
	}
	return h.inj
}

func (h *LinuxInputHandler) InputAvailable() bool { return h.injector().Available() }
func (h *LinuxInputHandler) SetAtLoginWindow(_ bool) {}

func (h *LinuxInputHandler) SetDisplayOffset(x, y int) {
	h.mu.Lock()
	h.offX, h.offY = x, y
	h.mu.Unlock()
}

func (h *LinuxInputHandler) SendMouseMove(x, y int) error {
	inj := h.injector()
	if inj == nil {
		return ErrNoActiveSession
	}
	return inj.MoveMouse(x+h.offX, y+h.offY)
}

func (h *LinuxInputHandler) SendMouseDown(x, y int, button string) error {
	if err := h.SendMouseMove(x, y); err != nil {
		return err
	}
	return h.injector().ButtonDown(mouseButtonCode(button))
}

func (h *LinuxInputHandler) SendMouseUp(x, y int, button string) error {
	if err := h.SendMouseMove(x, y); err != nil {
		return err
	}
	return h.injector().ButtonUp(mouseButtonCode(button))
}

func (h *LinuxInputHandler) SendMouseClick(x, y int, button string) error {
	if err := h.SendMouseDown(x, y, button); err != nil {
		return err
	}
	return h.SendMouseUp(x, y, button)
}

func (h *LinuxInputHandler) SendMouseScroll(x, y int, delta int) error {
	inj := h.injector()
	if inj == nil {
		return ErrNoActiveSession
	}
	btn := byte(4) // up
	if delta < 0 {
		btn = 5 // down
	}
	n := delta
	if n < 0 {
		n = -n
	}
	for i := 0; i < n; i++ {
		if err := inj.ButtonDown(btn); err != nil {
			return err
		}
		if err := inj.ButtonUp(btn); err != nil {
			return err
		}
	}
	return nil
}

func (h *LinuxInputHandler) SendKeyPress(key string, modifiers []string) error {
	inj := h.injector()
	if inj == nil {
		return ErrNoActiveSession
	}
	for _, m := range modifiers {
		_ = inj.KeyDownByName(m)
	}
	err := inj.KeyByName(key)
	for i := len(modifiers) - 1; i >= 0; i-- {
		_ = inj.KeyUpByName(modifiers[i])
	}
	return err
}

func (h *LinuxInputHandler) SendKeyDown(key string) error {
	inj := h.injector()
	if inj == nil {
		return ErrNoActiveSession
	}
	return inj.KeyDownByName(key)
}

func (h *LinuxInputHandler) SendKeyUp(key string) error {
	inj := h.injector()
	if inj == nil {
		return ErrNoActiveSession
	}
	return inj.KeyUpByName(key)
}

func mouseButtonCode(button string) byte {
	switch button {
	case "right":
		return 3
	case "middle":
		return 2
	default:
		return 1
	}
}

// HandleEvent dispatches an InputEvent (mirrors the old switch).
func (h *LinuxInputHandler) HandleEvent(event InputEvent) error {
	switch event.Type {
	case "mouse_move":
		return h.SendMouseMove(event.X, event.Y)
	case "mouse_click":
		return h.SendMouseClick(event.X, event.Y, event.Button)
	case "mouse_down":
		return h.SendMouseDown(event.X, event.Y, event.Button)
	case "mouse_up":
		return h.SendMouseUp(event.X, event.Y, event.Button)
	case "mouse_scroll":
		return h.SendMouseScroll(event.X, event.Y, event.Delta)
	case "key_press":
		return h.SendKeyPress(event.Key, event.Modifiers)
	case "key_down":
		return h.SendKeyDown(event.Key)
	case "key_up":
		return h.SendKeyUp(event.Key)
	}
	return nil
}
```

(Confirm `InputEvent`'s field names — `Delta`, `Modifiers`, `Button`, `Key` — against `input.go` when implementing; adjust if they differ.)

- [ ] **Step 3: Write + run a skip-guarded smoke test**

Create `agent/internal/remote/desktop/input_linux_test.go`:

```go
//go:build linux

package desktop

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/remote/desktop/x11"
)

func TestLinuxInputAvailable(t *testing.T) {
	var _ InputHandler = &LinuxInputHandler{} // compile-time interface check
	if _, err := x11.SelectX11Target(); err != nil {
		t.Skipf("no X display: %v", err)
	}
	h := NewInputHandler("user_session")
	if !h.InputAvailable() {
		t.Skip("XTEST not available on this display")
	}
	if err := h.SendMouseMove(5, 5); err != nil {
		t.Fatalf("move: %v", err)
	}
}
```

Run: `cd agent && CGO_ENABLED=0 go build ./... && CGO_ENABLED=0 go test ./internal/remote/desktop/ -run TestLinuxInput -v`
Expected: builds (xdotool gone); interface check compiles; smoke test SKIPS on CI.

- [ ] **Step 4: Commit**

```bash
git add agent/internal/remote/desktop/input_linux.go agent/internal/remote/desktop/x11/input_linux.go agent/internal/remote/desktop/input_linux_test.go
git commit -m "feat(agent): XTEST input handler for Linux (drop xdotool)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 11: Agent routing — dynamic headless, state-based stop, OnSessionStopped, watchdog

**Goal:** Remove the interim Task-3 guard; route Linux desktop off the live resolver; fix the four verified routing hazards (data race, stop-routing flip, missing disconnect callback, static-screen watchdog); recompute the heartbeat `IsHeadless` per tick on Linux.

**Files:**
- Modify: `agent/internal/heartbeat/handlers_desktop.go` (remove interim guard; stop routing; stream gates)
- Modify: `agent/internal/heartbeat/heartbeat.go` (dynamic payload IsHeadless; unconditional OnSessionStopped on Linux; remove/annotate dead `:542` branch)
- Modify: `agent/internal/remote/desktop/session_capture.go` (static-screen heartbeat on differ-skip for Linux)
- Test: `agent/internal/heartbeat/handlers_desktop_test.go`, `agent/internal/remote/desktop/session_capture_test.go`

**Interfaces:**
- Consumes: `x11.SelectX11Target`, `Heartbeat.desktopOwners`, `Heartbeat.desktopMgr`, `Heartbeat.currentHeadless()` (new).
- Produces: `func (h *Heartbeat) currentHeadless() bool` (Linux: resolver-backed with ≤30s cache; else boot `h.isHeadless`).

- [ ] **Step 1: Add currentHeadless() with a cached resolver probe**

Add to `heartbeat.go` (near the payload assembly). Use `atomic` to avoid the data race the verifier flagged:

```go
// currentHeadless reports whether the device currently lacks an attachable
// graphical session. On Linux it is resolver-backed (cached ≤30s) so xrdp
// session churn is reflected without an agent restart; elsewhere it returns the
// boot-time flag. The result is stored in an atomic so heartbeat and
// command-handler goroutines never race on a plain bool.
func (h *Heartbeat) currentHeadless() bool {
	if runtime.GOOS != "linux" {
		return h.isHeadless
	}
	now := time.Now()
	if cached := h.headlessCachedAt.Load(); cached != nil {
		if c, ok := cached.(headlessCache); ok && now.Sub(c.at) < 30*time.Second {
			return c.headless
		}
	}
	_, err := x11.SelectX11Target()
	headless := err != nil
	h.headlessCachedAt.Store(headlessCache{headless: headless, at: now})
	return headless
}

type headlessCache struct {
	headless bool
	at       time.Time
}
```

Add the field `headlessCachedAt atomic.Value` to the `Heartbeat` struct and import `"github.com/breeze-rmm/agent/internal/remote/desktop/x11"`.

In `sendHeartbeat` payload assembly (`heartbeat.go:3016`), change `IsHeadless: h.isHeadless,` to `IsHeadless: h.currentHeadless(),`.

- [ ] **Step 2: Remove the interim Task-3 guard and route off the resolver**

In `handlers_desktop.go` `handleStartDesktop`, delete the interim `if runtime.GOOS == "linux" { ...not yet supported... }` block added in Task 3. The existing direct path (`h.desktopMgr.StartSession`) now works on Linux because `newPlatformCapturer` resolves the display. Also delete the Task-3 test `TestHandleStartDesktopLinuxNotSupportedYet`.

- [ ] **Step 3: Make stop routing state-based**

In `handleStopDesktop` (`handlers_desktop.go:259`), replace the flag-gated routing:

```go
	if (h.isService || h.isHeadless) && h.sessionBroker != nil {
		session := h.desktopOwnerSession(sessionID)
		...
	}
	...
	h.desktopMgr.StopSession(sessionID)
```

with state-based routing that tries the helper owner first, else the direct manager (both are safe no-ops for unknown IDs), so a headless flip between start and stop can't strand a session:

```go
	// State-based routing: if a helper owns this session, stop it over IPC;
	// otherwise stop the direct desktopMgr session. Never gate on the (possibly
	// flipped) headless flag — that strands a live capture session.
	if h.sessionBroker != nil {
		if session := h.desktopOwnerSession(sessionID); session != nil {
			// ... existing IPC TypeDesktopStop path, unchanged ...
			return /* existing result */
		}
	}
	if h.desktopMgr != nil {
		h.desktopMgr.StopSession(sessionID)
	}
	return tools.NewSuccessResult(map[string]any{"sessionId": sessionID}, time.Since(start).Milliseconds())
```

(Preserve the exact existing IPC stop body inside the `session != nil` branch — only the gate and the fallthrough change.)

Similarly, for `desktop_stream_stop` (`:382`), `desktop_input` (`:400`), `desktop_config` (`:434`): change the `if h.isService || h.isHeadless {` gates to check session existence in `h.wsDesktopMgr` rather than the flag (add a `HasSession(id)` accessor to `WsSessionManager` if absent). On Linux these WS-path commands remain effectively unused (WebRTC is the path), but the gate must not spuriously flip.

- [ ] **Step 4: Register OnSessionStopped unconditionally on Linux**

In `heartbeat.go:629`, the current code:

```go
	if !cfg.IsService && !cfg.IsHeadless {
		h.desktopMgr.OnSessionStopped = func(sessionID string) {
			h.sendDesktopDisconnectNotification(sessionID)
		}
	}
```

Change the condition so Linux always registers it (the callback is nil-checked at every fire site and inert in helper mode):

```go
	if (!cfg.IsService && !cfg.IsHeadless) || runtime.GOOS == "linux" {
		h.desktopMgr.OnSessionStopped = func(sessionID string) {
			h.sendDesktopDisconnectNotification(sessionID)
		}
	}
```

While here, fix or delete the dead `heartbeat.go:542` branch (`} else if cfg.IsHeadless && h.sessionBroker != nil {` — `h.sessionBroker` is nil at that point, assigned later at `:592`). Deleting the dead `else if` arm is the minimal safe change; add a one-line comment noting the broker isn't constructed until `:592`.

- [ ] **Step 5: Fix the static-screen watchdog for Linux**

In `session_capture.go`, the CRC-unchanged skip path (`:855-861`) never bumps `lastVideoWriteUnixNano`, so a fully static X screen is killed by the no-video watchdog after ~3s+5×5s. On the non-DXGI (ticker) path, bump the capture-alive heartbeat when a frame is intentionally skipped as unchanged. Locate the differ-skip branch and add a `noteVideoWrite()`-style call (use the existing heartbeat helper that DXGI's idle-resend uses; if the only such path is `maybeResendCachedFrameOnIdle`, invoke the underlying timestamp bump directly). Add:

```go
	// Linux/X11 has no damage events; a genuinely static screen produces
	// identical frames. Bump the capture-alive heartbeat on an unchanged frame
	// so the no-video watchdog does not terminate a healthy static session.
	s.noteVideoWrite()
```

immediately in the "unchanged, skipping" branch (adjust to the actual method name; grep `lastVideoWriteUnixNano` for the setter).

- [ ] **Step 6: Write/adjust tests**

Add to `handlers_desktop_test.go` a state-based stop test (headless flag irrelevant): start a fake direct session, flip nothing, assert `handleStopDesktop` calls `desktopMgr.StopSession` even when `h.isHeadless` is toggled true. Add to `session_capture_test.go` (untagged — runs under `-race` on darwin) a test that an unchanged frame bumps the video-write timestamp so the watchdog does not fire. Use the existing session test scaffolding.

- [ ] **Step 7: Run tests + compile gate**

Run:
```bash
cd agent && CGO_ENABLED=0 go build ./... && go test ./internal/heartbeat/ ./internal/remote/desktop/
```
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add agent/internal/heartbeat/handlers_desktop.go agent/internal/heartbeat/handlers_desktop_test.go agent/internal/heartbeat/heartbeat.go agent/internal/remote/desktop/session_capture.go agent/internal/remote/desktop/session_capture_test.go
git commit -m "feat(agent): Linux desktop routing — dynamic headless, state-based stop, disconnect notify, static-screen watchdog

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 12: desktop_access_linux.go + call-site + capability reason

**Goal:** Emit a real `desktopAccess` for Linux so the UI reflects reality. `mode: 'user_session'` when capturable, else `mode: 'unavailable'` with a typed reason.

**Files:**
- Create: `agent/internal/heartbeat/desktop_access_linux.go` (`//go:build linux`)
- Modify: `agent/internal/heartbeat/desktop_access_other.go` (tag → `//go:build !darwin && !linux`)
- Modify: `agent/internal/heartbeat/heartbeat.go` (call-site Linux arm at `:3083`)
- Test: `agent/internal/heartbeat/desktop_access_linux_test.go` (`//go:build linux`, skip-guarded)

**Interfaces:**
- Consumes: `x11.SelectX11Target`, `x11.ErrWaylandUnsupported`, `x11.ErrNoDisplay`, `DesktopAccessState`.
- Produces: `func (h *Heartbeat) computeDesktopAccess(*collectors.SystemInfo) *DesktopAccessState` for linux.

- [ ] **Step 1: Implement the linux computeDesktopAccess**

Create `agent/internal/heartbeat/desktop_access_linux.go`:

```go
//go:build linux

package heartbeat

import (
	"time"

	"github.com/breeze-rmm/agent/internal/collectors"
	"github.com/breeze-rmm/agent/internal/remote/desktop/x11"
)

// computeDesktopAccess probes the X display resolver and reports capture
// capability. mode is 'user_session' (capturable) or 'unavailable' with a
// typed reason. Never emits 'available' — the API zod mode enum has no .catch
// and would silently drop the whole object on deployed servers.
func (h *Heartbeat) computeDesktopAccess(_ *collectors.SystemInfo) *DesktopAccessState {
	now := time.Now().UTC()
	_, err := x11.SelectX11Target()
	if err == nil {
		return &DesktopAccessState{Mode: "user_session", CheckedAt: now}
	}
	reason := "no_display_session"
	switch err {
	case x11.ErrWaylandUnsupported:
		reason = "wayland_unsupported"
	case x11.ErrNoDisplay:
		reason = "no_display_session"
	default:
		reason = "x11_connect_failed"
	}
	return &DesktopAccessState{Mode: "unavailable", Reason: reason, CheckedAt: now}
}
```

Change `desktop_access_other.go` build tag from `//go:build !darwin` to `//go:build !darwin && !linux`.

- [ ] **Step 2: Add the Linux arm at the call site**

In `heartbeat.go:3083`, the current gate is:

```go
	if runtime.GOOS == "darwin" && h.sessionBroker != nil {
		...
		payload.DesktopAccess = h.computeDesktopAccess(sysInfo)
	}
```

Add a Linux arm that does NOT require the broker (Linux desktop boots have a nil broker):

```go
	if runtime.GOOS == "darwin" && h.sessionBroker != nil {
		// existing darwin block (TCC + desktopAccess) unchanged
		...
		payload.DesktopAccess = h.computeDesktopAccess(sysInfo)
	} else if runtime.GOOS == "linux" {
		payload.DesktopAccess = h.computeDesktopAccess(sysInfo)
	}
```

(The linux impl does not touch `h.sessionBroker`, so no nil-guard is needed inside it — but do not share the darwin block's broker dereference.)

- [ ] **Step 3: Write + run a skip-guarded test**

Create `agent/internal/heartbeat/desktop_access_linux_test.go`:

```go
//go:build linux

package heartbeat

import "testing"

func TestComputeDesktopAccessLinuxShape(t *testing.T) {
	h := &Heartbeat{}
	state := h.computeDesktopAccess(nil)
	if state == nil {
		t.Fatal("linux computeDesktopAccess must never return nil")
	}
	if state.Mode != "user_session" && state.Mode != "unavailable" {
		t.Fatalf("mode must be user_session|unavailable, got %q", state.Mode)
	}
	if state.Mode == "unavailable" && state.Reason == "" {
		t.Fatal("unavailable must carry a reason")
	}
}
```

Run: `cd agent && CGO_ENABLED=0 go build ./... && CGO_ENABLED=0 go test ./internal/heartbeat/ -run TestComputeDesktopAccessLinuxShape -v`
Expected: PASS (runs on CI — no live X needed; both branches are valid shapes).

- [ ] **Step 4: Commit**

```bash
git add agent/internal/heartbeat/desktop_access_linux.go agent/internal/heartbeat/desktop_access_other.go agent/internal/heartbeat/heartbeat.go agent/internal/heartbeat/desktop_access_linux_test.go
git commit -m "feat(agent): report Linux desktopAccess capability to the server

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 13: API + shared reason enum

**Files:**
- Modify: `apps/api/src/routes/agents/schemas.ts:22-29`
- Modify: `packages/shared/src/types/index.ts` (`DesktopAccessReason`)
- Test: `apps/api/src/routes/agents/schemas.heartbeatTolerance.test.ts`

**Interfaces:**
- Produces: extended `desktopAccessReasonSchema` and `DesktopAccessReason` union with `no_display_session | wayland_unsupported | x11_connect_failed | x11_auth_failed`.

- [ ] **Step 1: Write the failing forward-compat test**

Add to `apps/api/src/routes/agents/schemas.heartbeatTolerance.test.ts`:

```ts
import { heartbeatSchema } from './schemas';

describe('desktopAccess Linux reasons', () => {
  const base = {
    mode: 'unavailable' as const,
    loginUiReachable: false,
    virtualDisplayReady: false,
    checkedAt: '2026-07-17T00:00:00.000Z',
  };

  it.each(['no_display_session', 'wayland_unsupported', 'x11_connect_failed', 'x11_auth_failed'])(
    'accepts Linux reason %s',
    (reason) => {
      const parsed = heartbeatSchema.parse({
        agentId: 'a', desktopAccess: { ...base, reason },
      });
      expect(parsed.desktopAccess?.reason).toBe(reason);
    },
  );

  it('keeps the object but drops an unknown reason (forward-compat)', () => {
    const parsed = heartbeatSchema.parse({
      agentId: 'a', desktopAccess: { ...base, reason: 'totally_new_reason' },
    });
    expect(parsed.desktopAccess).toBeDefined();
    expect(parsed.desktopAccess?.reason).toBeUndefined();
  });
});
```

(Adjust the minimal required `heartbeatSchema` fields — `agentId` etc. — to whatever the schema requires; the point is the desktopAccess sub-object.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && pnpm vitest run src/routes/agents/schemas.heartbeatTolerance.test.ts`
Expected: FAIL — the four new reasons are rejected (dropped to undefined) by the current enum.

- [ ] **Step 3: Extend the enum + shared type**

In `apps/api/src/routes/agents/schemas.ts:22-29`:

```ts
const desktopAccessReasonSchema = z.enum([
  'missing_permission',
  'missing_entitlement',
  'helper_not_connected',
  'virtual_display_unavailable',
  'unsupported_os',
  'manual_install',
  'no_display_session',
  'wayland_unsupported',
  'x11_connect_failed',
  'x11_auth_failed',
]);
```

In `packages/shared/src/types/index.ts` (`DesktopAccessReason` union), add the same four members:

```ts
export type DesktopAccessReason =
  | 'missing_permission'
  | 'missing_entitlement'
  | 'helper_not_connected'
  | 'virtual_display_unavailable'
  | 'unsupported_os'
  | 'manual_install'
  | 'no_display_session'
  | 'wayland_unsupported'
  | 'x11_connect_failed'
  | 'x11_auth_failed';
```

- [ ] **Step 4: Run to verify it passes + typecheck**

Run:
```bash
cd apps/api && pnpm vitest run src/routes/agents/schemas.heartbeatTolerance.test.ts
cd ../.. && pnpm --filter @breeze/shared build && pnpm --filter @breeze/api typecheck
```
Expected: PASS; shared builds; API typechecks (z.infer of the enum stays assignable to `DesktopAccessReason`).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/agents/schemas.ts packages/shared/src/types/index.ts apps/api/src/routes/agents/schemas.heartbeatTolerance.test.ts
git commit -m "feat(api): accept Linux desktopAccess reasons

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 14: Web reasons + i18n (5 locales) + DeviceInfoTab

**Files:**
- Modify: `apps/web/src/components/remote/ConnectDesktopButton.tsx` (reason switch)
- Modify: `apps/web/src/components/devices/DeviceInfoTab.tsx` (`formatDesktopAccessReason` + banner)
- Modify: `apps/web/src/locales/{en,es-419,fr-FR,de-DE,pt-BR}/remote.json`
- Modify: `apps/web/src/locales/{...}/devices.json` (if `DeviceInfoTab` reason labels live there)
- Test: `apps/web/src/components/remote/ConnectDesktopButton.test.tsx`

**Interfaces:**
- Consumes: `DesktopAccessState` (already imported), the four new reasons.
- Produces: four new `connectDesktopButton.unavailable.*` keys in all five locales.

- [ ] **Step 1: Write the failing web test**

Add to `apps/web/src/components/remote/ConnectDesktopButton.test.tsx` (uses the existing mocked-fetchWithAuth + real-en-i18n harness):

```tsx
it('shows the no-display tooltip for a Linux headless-server reason', () => {
  render(
    <ConnectDesktopButton
      deviceId="dev-1"
      desktopAccess={{
        mode: 'unavailable',
        loginUiReachable: false,
        virtualDisplayReady: false,
        reason: 'no_display_session',
        checkedAt: '2026-07-17T00:00:00.000Z',
      }}
    />,
  );
  const btn = screen.getByRole('button');
  expect(btn).toBeDisabled();
  expect(btn.getAttribute('title')).toMatch(/no active graphical session|log in/i);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/web && pnpm vitest run src/components/remote/ConnectDesktopButton.test.tsx`
Expected: FAIL — `no_display_session` hits the `default` tooltip, not the specific string.

- [ ] **Step 3: Extend the reason switch**

In `ConnectDesktopButton.tsx` `desktopAccessUnavailableReason` switch (lines ~72-88), add:

```ts
    case 'no_display_session':
      return translate?.('connectDesktopButton.unavailable.noDisplaySession') ?? null;
    case 'wayland_unsupported':
      return translate?.('connectDesktopButton.unavailable.waylandUnsupported') ?? null;
    case 'x11_connect_failed':
      return translate?.('connectDesktopButton.unavailable.x11ConnectFailed') ?? null;
    case 'x11_auth_failed':
      return translate?.('connectDesktopButton.unavailable.x11AuthFailed') ?? null;
```

Do **not** add any of these to `VNC_FALLBACK_REASONS` (that path is macOS-specific).

In `DeviceInfoTab.tsx` `formatDesktopAccessReason` (lines ~180-199), add human labels for the four reasons, and add a Linux-worded arm to the mode-unavailable banner (~1112) so Linux reasons don't fall into the macOS-worded default.

- [ ] **Step 4: Add the five-locale keys**

In each of `apps/web/src/locales/{en,es-419,fr-FR,de-DE,pt-BR}/remote.json`, add to `connectDesktopButton.unavailable`:

en:
```json
"noDisplaySession": "No active graphical session — log in via RDP or the console first",
"waylandUnsupported": "This is a Wayland desktop — remote desktop needs a newer agent",
"x11ConnectFailed": "Couldn't connect to the display server on this device",
"x11AuthFailed": "Couldn't authenticate to the display server (X authority)"
```

Provide **real** translations (not English copies — `translationCoverage.test.ts` caps duplicates) for es-419, fr-FR, de-DE, pt-BR. Mirror any `DeviceInfoTab` reason label keys into the matching `devices.json` for all five locales.

- [ ] **Step 5: Run web tests + parity + typecheck**

Run:
```bash
cd apps/web && pnpm vitest run src/components/remote/ConnectDesktopButton.test.tsx src/lib/i18n/localeParity.test.ts src/lib/i18n/translationCoverage.test.ts src/lib/i18n/keyUsage.test.ts
cd ../.. && pnpm --filter @breeze/web typecheck
```
Expected: PASS (tooltip test green; locale parity/coverage/keyUsage green; typecheck green).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/remote/ConnectDesktopButton.tsx apps/web/src/components/devices/DeviceInfoTab.tsx apps/web/src/locales apps/web/src/components/remote/ConnectDesktopButton.test.tsx
git commit -m "feat(web): localized Connect Desktop reasons for Linux devices

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 15: Rig verification + docs

**Goal:** Prove the end-to-end path on the real Ubuntu xrdp box (Tailscale, US-prod enrolled — see internal notes for the address) and update docs. This is manual verification, not a unit test — CI can't drive a live X server or a viewer.

**Files:**
- Modify: `apps/docs` remote-desktop page (supported-OS matrix, xdotool removal, Wayland status)
- Modify: `agent/internal/remote/desktop/agent-info` skill note or the remote-desktop skill's Linux row (optional)

- [ ] **Step 1: Build and dev-push to the rig**

The box is US-prod enrolled; `dev-push` against prod is 403-gated unless `DEV_PUSH_ENABLED=true`. Two options: (a) temporarily enable dev-push on a non-customer test path, or (b) build the binary and `scp` it over Tailscale SSH, replacing `/usr/local/bin/breeze-agent` and restarting the service. Prefer (b) for a prod box:

```bash
cd agent && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags "-X main.version=dev-$(date +%s)" -o bin/breeze-agent-linux ./cmd/breeze-agent
scp bin/breeze-agent-linux root@<rig-box>:/tmp/breeze-agent-new
ssh root@<rig-box> 'systemctl stop breeze-agent && cp /tmp/breeze-agent-new /usr/local/bin/breeze-agent && systemctl start breeze-agent'
```

(Confirm the `auto_update` interaction — the dev/hand-placed binary may be overwritten by the updater; disable auto-update in `agent.yaml` on the box for the test window, and restore afterward.)

- [ ] **Step 2: Verify capability reporting**

RDP into the box once (creates the xrdp XFCE session on `:10`). Then check the device in the web UI: the Connect Desktop button should become **enabled** within ~1–2 heartbeats (up to ~2 min with the 60s interval + jitter). Confirm `desktopAccess.mode === 'user_session'` via the device API or DB:

```bash
docker exec breeze-postgres psql -U breeze -d breeze -c "SELECT hostname, is_headless, desktop_access FROM devices WHERE hostname='ubuntu';"
```

Disconnect RDP but leave the session alive (`KillDisconnected=false`) — button stays enabled. Confirm that with no xrdp session since boot, `desktopAccess.mode === 'unavailable'`, `reason === 'no_display_session'`, and the button is greyed with the localized tooltip.

- [ ] **Step 3: Verify the full remote-desktop flow**

With an xrdp session alive, click Connect Desktop in the web UI and confirm through the viewer: (1) video shows the XFCE desktop, (2) mouse move/click works, (3) keyboard typing works, (4) the monitor list is correct, (5) the cursor shape updates, (6) clipboard sync (if enabled). Check agent logs for the session lifecycle:

```bash
ssh root@<rig-box> 'grep -aE "Desktop WebRTC|start_desktop|x11|capture" /var/log/breeze/agent.log | tail -40'
```

- [ ] **Step 4: Verify the X-server-death case (the reason approach B was chosen)**

While a Breeze desktop session is active, end the xrdp session (log out of XFCE, or `loginctl terminate-session <id>`). Confirm the **agent process survives** (does not exit), the desktop session ends with a typed error, and `sendDesktopDisconnectNotification` fires (the API session row transitions out of `active`). Then confirm a fresh RDP login + new Connect Desktop works without an agent restart.

```bash
ssh root@<rig-box> 'systemctl is-active breeze-agent'   # must still be "active"
```

- [ ] **Step 5: Verify a genuinely static screen is not killed**

Leave the XFCE desktop untouched (no clock, static wallpaper) for >60s during an active session — confirm the session is not terminated by the no-video watchdog (Task 11 fix).

- [ ] **Step 6: Update docs**

Update the `apps/docs` remote-desktop page: add Linux (X11/xrdp) to the supported matrix with the "session must exist; RDP/console in first" caveat; note Wayland is not yet supported (Phase 2); remove any `xdotool` prerequisite mention. Note the OpenH264 software-encode path on Linux.

- [ ] **Step 7: Restore the box + commit docs**

Restore `auto_update` in the box's `agent.yaml` (and let the fleet updater bring it back to the released version once Phase 1 ships), then:

```bash
git add apps/docs
git commit -m "docs: Linux remote desktop (X11/xrdp) supported; xdotool no longer required

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

- [ ] **Step 8: Open the PR**

```bash
cd agent && CGO_ENABLED=0 go build ./... && go test ./...
gh pr create --title "Linux remote desktop (Phase 1): X11 mirror via jezek/xgb" --body "$(cat <<'EOF'
Implements Phase 1 of docs/superpowers/specs/2026-07-16-linux-remote-desktop-design.md.

Shipped Linux agents (CGO_ENABLED=0) can now capture and control real X11
sessions (console Xorg, xrdp/XFCE) end-to-end through the existing WebRTC
pipeline, via the pure-Go X11 wire protocol (github.com/jezek/xgb) — no C
libraries, no CGO. Includes display/session/Xauthority resolution, XTEST input
(xdotool removed), XFixes cursor, RandR monitors, honest desktopAccess
capability reporting, and localized UI reasons in all five locales.

Verified end-to-end on a real Ubuntu 22.04 xrdp box, including the X-server-death
survival case that disqualified the Xlib/purego approach.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review Notes (for the executor)

- **Field-name confirmations to make while implementing** (the research verified the functions exist but flagged a few names to confirm with `go doc` against the pinned v1.3.1): `xfixes.GetCursorImageAndNameReply` cursor-name field (`CursorAtom` vs `Name`); `randr.MonitorInfo.Name` atom type; `InputEvent` field names (`Delta`/`Modifiers`/`Button`/`Key`) in `input.go`; the exact `noteVideoWrite`/timestamp-bump setter in `session_capture.go`; whether `WsSessionManager` already has a `HasSession`.
- **BGRX vs RGBA:** the new capturer reports `IsBGRA()==true` (X ZPixmap on LE is BGRX). Any older Linux test fixture assuming RGBA changes — there are none today (the cgo path never ran in CI).
- **Not in Phase 1 (Phase 2, separate plan):** the Linux desktop-helper binary + spawn branch, Wayland/PipeWire portal capture, the `userhelper` Linux capture probe, the `legacyBinaryPath()==defaultBinaryPath()` collision guard, and audio. The `x11_auth_failed` reason has no agent emitter in Phase 1 (auth failure currently surfaces as `x11_connect_failed` from `Open`) — it is added to the enum now so the UI is ready; wire a distinct auth-failure return from `x11.Open` in Phase 2 if worth splitting.
- **CI reality:** the linux-tagged X code never runs under `-race` (test-agent has no `-race`; the race leg is darwin). Keep concurrency-sensitive logic (the per-instance mutex discipline) simple and rely on the rig for real-load validation.
