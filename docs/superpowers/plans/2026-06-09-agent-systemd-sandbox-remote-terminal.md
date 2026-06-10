# Agent systemd Sandbox Relaxation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Linux agent's remote terminal and remote script execution behave like a root SSH session by removing the inherited systemd sandbox, and auto-heal the already-deployed fleet on next startup.

**Architecture:** Relax the `breeze-agent.service` unit (remove `CapabilityBoundingSet`/`ProtectSystem`/`ProtectHome`/`PrivateTmp`), version-stamp it, and on agent startup detect an outdated on-disk unit and rewrite it by escaping the sandbox via a `systemd-run` **transient service** (PID 1 spawns `service reconcile-unit` outside the agent's namespace/caps — NOT `--scope`, which inherits both). The watchdog unit stays hardened.

**Tech Stack:** Go (agent), systemd, cobra CLI. Tests: Go standard `testing`.

**Spec:** `docs/superpowers/specs/2026-06-09-agent-systemd-sandbox-remote-terminal-design.md`

---

## File Structure

| File | Responsibility | Build tag |
|---|---|---|
| `agent/cmd/breeze-agent/systemd_unit.go` (**new**) | Canonical relaxed unit string (`linuxUnit`), `currentUnitVersion`, `parseUnitVersion`, `unitNeedsReconcile` — pure, no OS APIs | none (compiles everywhere, so tests run on macOS dev + linux CI) |
| `agent/cmd/breeze-agent/systemd_unit_test.go` (**new**) | Table tests for the decision logic + drift / anti-re-hardening guard | none |
| `agent/cmd/breeze-agent/service_cmd_linux.go` (modify) | Remove the old embedded `const linuxUnit`; implement `reconcileServiceUnitIfNeeded()`; add `serviceReconcileUnitCmd` | linux |
| `agent/cmd/breeze-agent/service_cmd_darwin.go` (modify) | Rename hook `healLaunchdPlistsIfNeeded` → `reconcileServiceUnitIfNeeded` | darwin |
| `agent/cmd/breeze-agent/service_cmd_windows.go` (modify) | Rename no-op hook | windows |
| `agent/cmd/breeze-agent/main.go` (modify, line ~716) | Update the renamed call site + comment | none |
| `agent/service/systemd/breeze-agent.service` (modify) | Rewrite to the canonical relaxed unit (byte-identical to `linuxUnit`) | n/a |

**Canonical relaxed unit** (used verbatim in BOTH `systemd_unit.go`'s `linuxUnit` const and the static `breeze-agent.service`):

```ini
[Unit]
Description=Breeze RMM Agent
Documentation=https://github.com/breeze-rmm/breeze
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
# breeze-unit-version: 2
Type=simple
ExecStart=/usr/local/bin/breeze-agent start
WorkingDirectory=/etc/breeze
Restart=on-failure
RestartSec=30
TimeoutStopSec=15
KillMode=mixed

# INTENTIONALLY UNSANDBOXED. The remote terminal and remote script execution
# features spawn child processes that must behave like a root SSH session:
#   - `apt` drops privileges to the _apt user (needs CAP_SETUID/SETGID/CHOWN)
#   - admins write under /home, /usr, /etc, and expect a shared /tmp
# systemd sandbox directives (CapabilityBoundingSet, ProtectSystem, ProtectHome,
# PrivateTmp) are INHERITED by those children and silently break these operations.
# Do not re-add them. See docs/superpowers/specs/2026-06-09-agent-systemd-sandbox-remote-terminal-design.md

StandardOutput=journal
StandardError=journal
SyslogIdentifier=breeze-agent
LimitNOFILE=8192

[Install]
WantedBy=multi-user.target
```

> **Note on `apt` workaround (relay to the reporting user — independent of this change):**
> `sudo apt -o APT::Sandbox::User=root update` clears the errors today without any agent change.

All commands below assume:
```bash
export PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH   # repo node pin (not needed for Go, harmless)
cd agent
```

---

## Task 1: Pure unit-version decision logic (TDD)

**Files:**
- Create: `agent/cmd/breeze-agent/systemd_unit.go`
- Test: `agent/cmd/breeze-agent/systemd_unit_test.go`

- [ ] **Step 1: Write the failing test**

Create `agent/cmd/breeze-agent/systemd_unit_test.go`:

```go
package main

import "testing"

func TestParseUnitVersion(t *testing.T) {
	cases := []struct {
		name    string
		input   string
		wantVer int
		wantOK  bool
	}{
		{"present", "[Service]\n# breeze-unit-version: 2\nType=simple\n", 2, true},
		{"present higher", "# breeze-unit-version: 7\n", 7, true},
		{"missing", "[Service]\nType=simple\n", 0, false},
		{"garbage value", "# breeze-unit-version: abc\n", 0, false},
		{"empty", "", 0, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ver, ok := parseUnitVersion(tc.input)
			if ver != tc.wantVer || ok != tc.wantOK {
				t.Fatalf("parseUnitVersion(%q) = (%d,%v), want (%d,%v)", tc.input, ver, ok, tc.wantVer, tc.wantOK)
			}
		})
	}
}

func TestUnitNeedsReconcile(t *testing.T) {
	cases := []struct {
		name     string
		existing string
		want     int
		expect   bool
	}{
		{"missing marker -> reconcile", "[Service]\nType=simple\n", 2, true},
		{"older -> reconcile", "# breeze-unit-version: 1\n", 2, true},
		{"equal -> skip", "# breeze-unit-version: 2\n", 2, false},
		{"newer -> skip (no downgrade)", "# breeze-unit-version: 3\n", 2, false},
		{"garbage -> reconcile", "# breeze-unit-version: x\n", 2, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := unitNeedsReconcile(tc.existing, tc.want); got != tc.expect {
				t.Fatalf("unitNeedsReconcile(%q,%d) = %v, want %v", tc.existing, tc.want, got, tc.expect)
			}
		})
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./cmd/breeze-agent/ -run 'TestParseUnitVersion|TestUnitNeedsReconcile' -v`
Expected: FAIL — `undefined: parseUnitVersion`, `undefined: unitNeedsReconcile`.

- [ ] **Step 3: Write minimal implementation**

Create `agent/cmd/breeze-agent/systemd_unit.go`:

```go
package main

import (
	"strconv"
	"strings"
)

// currentUnitVersion is the breeze-unit-version this binary ships. Bump it
// whenever linuxUnit changes in a way the deployed fleet must pick up; the
// startup reconcile rewrites any on-disk unit older than this.
const currentUnitVersion = 2

const unitVersionPrefix = "# breeze-unit-version:"

// parseUnitVersion extracts the breeze-unit-version marker from a unit file.
// Returns (version, true) when a well-formed marker is present, else (0, false).
func parseUnitVersion(existing string) (int, bool) {
	for _, line := range strings.Split(existing, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, unitVersionPrefix) {
			continue
		}
		v, err := strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(line, unitVersionPrefix)))
		if err != nil {
			return 0, false
		}
		return v, true
	}
	return 0, false
}

// unitNeedsReconcile reports whether the on-disk unit is older than what this
// binary ships. Missing/garbage marker or a lower version => reconcile. Equal
// or higher (a newer binary wrote it) => leave it alone, never downgrade.
func unitNeedsReconcile(existing string, want int) bool {
	v, ok := parseUnitVersion(existing)
	if !ok {
		return true
	}
	return v < want
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./cmd/breeze-agent/ -run 'TestParseUnitVersion|TestUnitNeedsReconcile' -v`
Expected: PASS (8 subtests).

- [ ] **Step 5: Commit**

```bash
git add agent/cmd/breeze-agent/systemd_unit.go agent/cmd/breeze-agent/systemd_unit_test.go
git commit -m "feat(agent): unit-version marker parsing + reconcile decision"
```

---

## Task 2: Relax the unit + drift guard (TDD)

Move the embedded unit const into the tag-free file with the relaxed content, rewrite the static unit to match, and lock both with a test.

**Files:**
- Modify: `agent/cmd/breeze-agent/systemd_unit.go` (add `linuxUnit` const)
- Modify: `agent/cmd/breeze-agent/service_cmd_linux.go:32` (remove old `const linuxUnit`)
- Modify: `agent/service/systemd/breeze-agent.service` (rewrite to canonical)
- Test: `agent/cmd/breeze-agent/systemd_unit_test.go` (add drift test)

- [ ] **Step 1: Move `const linuxUnit` verbatim into the tag-free file (pure refactor)**

Cut the entire `const linuxUnit = \`...\`` block (currently `service_cmd_linux.go:32`–end of that string) and paste it into `systemd_unit.go` **unchanged for now**. Leave `linuxUserUnit` and everything else in `service_cmd_linux.go` untouched.

Run: `GOOS=linux go build ./cmd/breeze-agent/`
Expected: builds (linux file still references the now-relocated `linuxUnit`; same package).

Run: `go test ./cmd/breeze-agent/ -run 'TestParseUnitVersion|TestUnitNeedsReconcile'`
Expected: PASS (unchanged).

- [ ] **Step 2: Write the failing drift / anti-re-hardening test**

Add to `agent/cmd/breeze-agent/systemd_unit_test.go`. The file already imports
`"testing"` from Task 1 — **merge** `"os"` and `"strings"` into that existing import
block (do not paste a second one):

```go
import (
	"os"
	"strings"
	"testing"
)

func TestStaticUnitMatchesEmbedded(t *testing.T) {
	// Test runs with cwd = package dir (agent/cmd/breeze-agent).
	data, err := os.ReadFile("../../service/systemd/breeze-agent.service")
	if err != nil {
		t.Fatalf("read static unit: %v", err)
	}
	if string(data) != linuxUnit {
		t.Fatalf("static breeze-agent.service is not byte-identical to embedded linuxUnit.\n"+
			"Keep them in sync (the auto-heal writes the embedded copy).")
	}
}

func TestUnitIsNotReHardened(t *testing.T) {
	forbidden := []string{
		"ProtectSystem=strict",
		"ProtectHome=read-only",
		"CapabilityBoundingSet",
		"AmbientCapabilities",
		"PrivateTmp=true",
	}
	for _, f := range forbidden {
		if strings.Contains(linuxUnit, f) {
			t.Errorf("linuxUnit re-introduced a sandbox directive that breaks the remote "+
				"terminal/scripts: %q (see the spec — do not re-add)", f)
		}
	}
	if _, ok := parseUnitVersion(linuxUnit); !ok {
		t.Errorf("linuxUnit is missing its %q marker", unitVersionPrefix)
	}
	if v, _ := parseUnitVersion(linuxUnit); v != currentUnitVersion {
		t.Errorf("linuxUnit marker version != currentUnitVersion (%d)", currentUnitVersion)
	}
}
```

Run: `go test ./cmd/breeze-agent/ -run 'TestStaticUnitMatchesEmbedded|TestUnitIsNotReHardened' -v`
Expected: FAIL — embedded still hardened (no marker, contains `ProtectSystem=strict`), and the static file differs from the embedded copy.

- [ ] **Step 3: Replace both unit definitions with the canonical relaxed unit**

In `systemd_unit.go`, replace the `linuxUnit` const body with the **Canonical relaxed unit** from the File Structure section (backtick string). Then overwrite `agent/service/systemd/breeze-agent.service` with the **exact same** text.

> Critical: the two must be byte-for-byte identical (same trailing newline). The const is a backtick raw string starting `[Unit]\n` and ending after `WantedBy=multi-user.target\n`.

- [ ] **Step 4: Run tests + build**

Run: `go test ./cmd/breeze-agent/ -run 'TestStaticUnitMatchesEmbedded|TestUnitIsNotReHardened|TestParseUnitVersion|TestUnitNeedsReconcile' -v`
Expected: PASS.

Run: `GOOS=linux go build ./cmd/breeze-agent/ && go vet ./cmd/breeze-agent/`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add agent/cmd/breeze-agent/systemd_unit.go agent/cmd/breeze-agent/service_cmd_linux.go agent/service/systemd/breeze-agent.service agent/cmd/breeze-agent/systemd_unit_test.go
git commit -m "fix(agent): relax systemd sandbox so remote terminal/scripts run like root SSH

Removes CapabilityBoundingSet/ProtectSystem/ProtectHome/PrivateTmp which
are inherited by terminal/script children and break apt's _apt privilege
drop (CAP_SETUID/SETGID/CHOWN) and filesystem writes. Adds a version
marker + drift guard. Fixes the Ubuntu 'setgroups/seteuid Operation not
permitted' report."
```

---

## Task 3: Rename the startup hook across all platforms (refactor)

`healLaunchdPlistsIfNeeded` becomes `reconcileServiceUnitIfNeeded` — a neutral name now that Linux does real work. No behavior change in this task.

**Files:**
- Modify: `agent/cmd/breeze-agent/service_cmd_darwin.go:470`
- Modify: `agent/cmd/breeze-agent/service_cmd_linux.go:102`
- Modify: `agent/cmd/breeze-agent/service_cmd_windows.go:25`
- Modify: `agent/cmd/breeze-agent/main.go:716`

- [ ] **Step 1: Rename darwin impl**

In `service_cmd_darwin.go`, rename the outer function only (keep `healLaunchdPlists()`/`ensureDesktopHelpersLoaded()` calls):

```go
// reconcileServiceUnitIfNeeded is the darwin implementation: it self-heals
// launchd plists from older installs.
func reconcileServiceUnitIfNeeded() {
	healLaunchdPlists()
	ensureDesktopHelpersLoaded()
}
```

- [ ] **Step 2: Rename windows no-op**

In `service_cmd_windows.go`:

```go
// reconcileServiceUnitIfNeeded is a no-op on Windows.
func reconcileServiceUnitIfNeeded() {}
```

- [ ] **Step 3: Rename linux no-op (real impl comes in Task 4)**

In `service_cmd_linux.go`, replace the existing no-op:

```go
// reconcileServiceUnitIfNeeded rewrites an outdated systemd unit on startup.
// Real implementation added in the next change.
func reconcileServiceUnitIfNeeded() {}
```

- [ ] **Step 4: Update the call site**

In `main.go` (~line 716), replace:

```go
	// Self-heal the installed service unit from older installs (launchd plists on
	// macOS; systemd unit on Linux) after a binary-only auto-update.
	reconcileServiceUnitIfNeeded()
```

- [ ] **Step 5: Build all three platforms + commit**

Run:
```bash
go build ./cmd/breeze-agent/                       # darwin (host)
GOOS=linux   go build ./cmd/breeze-agent/
GOOS=windows go build ./cmd/breeze-agent/
```
Expected: all succeed (no lingering `healLaunchdPlistsIfNeeded` references).

```bash
git add agent/cmd/breeze-agent/service_cmd_darwin.go agent/cmd/breeze-agent/service_cmd_windows.go agent/cmd/breeze-agent/service_cmd_linux.go agent/cmd/breeze-agent/main.go
git commit -m "refactor(agent): rename startup heal hook to reconcileServiceUnitIfNeeded"
```

---

## Task 4: Linux auto-heal — `reconcile-unit` subcommand + sandbox escape

**Files:**
- Modify: `agent/cmd/breeze-agent/service_cmd_linux.go` (implement `reconcileServiceUnitIfNeeded`, add `serviceReconcileUnitCmd`, register it)

- [ ] **Step 1: Add the `service reconcile-unit` subcommand**

In `service_cmd_linux.go`, add a new command (model the body on `serviceInstallCmd`'s unit write + daemon-reload at lines ~166/183). It is root-gated, idempotent, writes the unit, reloads, and restarts so the relaxed sandbox takes effect:

```go
var serviceReconcileUnitCmd = &cobra.Command{
	Use:    "reconcile-unit",
	Short:  "Rewrite the systemd unit to the current version and restart (internal)",
	Hidden: true,
	RunE: func(cmd *cobra.Command, args []string) error {
		if os.Geteuid() != 0 {
			return fmt.Errorf("must run as root")
		}
		if err := os.WriteFile(linuxUnitDst, []byte(linuxUnit), 0644); err != nil {
			return fmt.Errorf("write unit: %w", err)
		}
		if out, err := exec.Command("systemctl", "daemon-reload").CombinedOutput(); err != nil {
			return fmt.Errorf("daemon-reload: %s", strings.TrimSpace(string(out)))
		}
		fmt.Printf("Reconciled %s to unit version %d; restarting service.\n", linuxUnitDst, currentUnitVersion)
		// Restart so the relaxed sandbox applies to the live process. This kills
		// the old agent; we run as a systemd-run transient service whose parent
		// is PID 1 (not the agent), so this child survives to finish the restart.
		if out, err := exec.Command("systemctl", "restart", linuxServiceName).CombinedOutput(); err != nil {
			return fmt.Errorf("restart: %s", strings.TrimSpace(string(out)))
		}
		return nil
	},
}
```

Register it in `init()` alongside the others:

```go
	serviceCmd.AddCommand(serviceReconcileUnitCmd)
```

- [ ] **Step 2: Implement `reconcileServiceUnitIfNeeded` with the sandbox escape + fallback**

Replace the Task 3 no-op in `service_cmd_linux.go`. Add `"sync"` to imports.

```go
var reconcileOnce sync.Once

// reconcileServiceUnitIfNeeded runs at startup. If the installed unit predates
// currentUnitVersion, it rewrites it. The running agent is itself sandboxed and
// cannot write /etc/systemd/system (ProtectSystem=strict on old units), so it
// escapes via a systemd-run TRANSIENT SERVICE: PID 1 spawns the reconcile in a
// fresh execution environment, outside this unit's mount namespace and
// capability bounding set. Best-effort: on failure it logs and continues.
func reconcileServiceUnitIfNeeded() {
	reconcileOnce.Do(func() {
		// Only act as the installed systemd service running as root.
		if os.Geteuid() != 0 || os.Getenv("INVOCATION_ID") == "" {
			return
		}
		data, err := os.ReadFile(linuxUnitDst)
		if err != nil {
			return // not installed via systemd / unreadable — nothing to heal
		}
		if !unitNeedsReconcile(string(data), currentUnitVersion) {
			return
		}
		if _, err := exec.LookPath("systemd-run"); err != nil {
			fmt.Fprintf(os.Stderr,
				"Warning: breeze-agent systemd unit is outdated (pre-v%d) and systemd-run is "+
					"unavailable to auto-heal it. The remote terminal/scripts may hit privilege "+
					"errors (e.g. apt). Fix: sudo breeze-agent service install\n", currentUnitVersion)
			return
		}
		// TRANSIENT SERVICE, deliberately NOT --scope: a scope child is forked
		// from this (sandboxed) process and only its cgroup moves — it would
		// inherit our read-only /etc (ProtectSystem) and restricted CapBnd and
		// fail with the same Permission denied. Without --scope, PID 1 spawns
		// the command in a fresh execution environment with full root caps and
		// an unrestricted namespace; being a child of PID 1 it also survives
		// the agent restart it triggers. --collect garbage-collects the
		// transient unit on failure so a later retry is never blocked.
		// Fire-and-forget: systemd-run returns once the service starts; the
		// child rewrites the unit, daemon-reloads, and restarts us.
		out, err := exec.Command("systemd-run", "--quiet", "--collect",
			"--unit=breeze-unit-reconcile", linuxBinaryPath, "service", "reconcile-unit").CombinedOutput()
		if err != nil {
			fmt.Fprintf(os.Stderr,
				"Warning: failed to auto-heal outdated systemd unit via systemd-run: %s. "+
					"Fix: sudo breeze-agent service install\n", strings.TrimSpace(string(out)))
		}
	})
}
```

- [ ] **Step 3: Build linux + vet**

Run:
```bash
GOOS=linux go build ./cmd/breeze-agent/ && GOOS=linux go vet ./cmd/breeze-agent/
go test ./cmd/breeze-agent/ -run 'Unit'   # existing tests still green
```
Expected: clean build/vet; tests PASS.

- [ ] **Step 4: Commit**

```bash
git add agent/cmd/breeze-agent/service_cmd_linux.go
git commit -m "feat(agent): auto-heal outdated systemd unit via systemd-run transient service"
```

---

## Task 5: Full agent build + manual verification on a Linux host

This task has no new code — it verifies the end-to-end behavior the unit tests cannot (systemctl/systemd-run side effects).

- [ ] **Step 1: Full agent compile (race) on linux**

Run: `GOOS=linux go build ./... && go test ./cmd/breeze-agent/...`
Expected: builds; package tests pass.

- [ ] **Step 2: Reproduce the bug with the OLD unit**

On a throwaway Ubuntu 24.04 VM, install an agent built from `main` (old hardened unit). In the remote terminal:
```bash
grep Cap /proc/$(pidof breeze-agent)/status   # CapBnd is the restricted set
apt update                                     # reproduces setgroups/seteuid/chown errors
```

- [ ] **Step 3: Upgrade to the new binary and observe auto-heal**

Deploy the new binary (binary-only, as the updater does) and restart once. Watch the journal:
```bash
journalctl -u breeze-agent -f
# expect: reconcile escape runs, unit rewritten, daemon-reload, service restart
systemctl cat breeze-agent | grep breeze-unit-version   # => 2
```

- [ ] **Step 4: Confirm the fix**

```bash
grep Cap /proc/$(pidof breeze-agent)/status    # CapBnd now full (0x...1ffffffffff-class)
# In the remote terminal:
apt update                                      # succeeds, no privilege errors
# Remote SCRIPT that runs `apt update` and writes under /home:
#   also succeeds
```

- [ ] **Step 5: Confirm graceful fallback**

On a host without `systemd-run` (or D-Bus unavailable), start the agent with an outdated unit and confirm it logs the one-time WARNING and keeps running (no crash, no restart loop):
```bash
journalctl -u breeze-agent | grep "systemd unit is outdated"
```

- [ ] **Step 6: Final commit / PR**

```bash
git add docs/superpowers/specs/2026-06-09-agent-systemd-sandbox-remote-terminal-design.md docs/superpowers/plans/2026-06-09-agent-systemd-sandbox-remote-terminal.md
git commit -m "docs(agent): systemd sandbox relaxation spec + plan"
# open PR from this branch
```

---

## Self-Review (completed by plan author)

**Spec coverage:**
- §5.1 relaxed unit → Task 2. §5.2 versioned marker + `unitNeedsReconcile` → Task 1. §5.3 escape + `reconcile-unit` → Task 4. §5.4 loop prevention → Task 4 (`sync.Once` guard + restart-only-after-write in the subcommand). §5.5 fallback → Task 4 Step 2 + Task 5 Step 5. §5.6 startup wiring/rename → Task 3. §6 apt workaround → File Structure note + Task 5 Step 2. §8 tests (decision + drift/anti-re-harden) → Tasks 1–2. §9 verification → Task 5. Watchdog untouched (non-goal) — no task, correct.
- Added beyond spec: rename of the **windows** no-op (Task 3 Step 2) — required or the windows build breaks; the spec only named darwin+linux.

**Placeholder scan:** none — every code/command step is concrete.

**Type/name consistency:** `linuxUnit`, `currentUnitVersion`, `unitVersionPrefix`, `parseUnitVersion`, `unitNeedsReconcile`, `reconcileServiceUnitIfNeeded`, `serviceReconcileUnitCmd`, `linuxUnitDst`, `linuxBinaryPath`, `linuxServiceName` are used identically across tasks and match the existing symbols in `service_cmd_linux.go`.
```
