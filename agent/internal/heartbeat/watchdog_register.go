package heartbeat

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"time"
)

// watchdogRegisterTimeout bounds the verified watchdog's own `service install`.
const watchdogRegisterTimeout = 120 * time.Second

// watchdogInstallTransientArgs builds the systemd-run argv that runs the
// verified watchdog's `service install` on Linux. Invariants (pinned by
// TestWatchdogInstallTransientArgs, the Task 6 spike fixture):
//   - a TRANSIENT SERVICE, never --scope: PID 1 spawns it in systemd's default
//     execution environment, outside the agent unit's mount namespace and
//     capability bounding set, so it can write /etc/systemd/system even under a
//     legacy hardened (ProtectSystem=strict) agent unit — the same escape as
//     reconcileServiceUnitIfNeeded.
//   - --wait --pipe: the agent observes the real exit status and output.
//   - --collect: a failed unit never blocks a later retry.
//   - RuntimeMaxSec: systemd kills a hung installer, so the agent never
//     releases its lease/lock over a still-live installer.
//   - unique unit name (pid + nonce): no collision with a concurrent run.
//
// The staged file lives under the agent data dir (/var/lib/breeze), which the
// transient service sees: that path is in the legacy unit's ReadWritePaths
// (a bind of the real directory) and the current unit is unsandboxed. The OS
// temp dir is NOT used, because a PrivateTmp unit's /tmp is invisible to it.
func watchdogInstallTransientArgs(pid int, nonce int64, stagedPath string) []string {
	return []string{
		"--wait", "--collect", "--pipe", "--quiet",
		fmt.Sprintf("--unit=breeze-watchdog-ensure-%d-%d", pid, nonce),
		"--property=RuntimeMaxSec=" + fmt.Sprint(int(watchdogRegisterTimeout/time.Second)),
		stagedPath, "service", "install",
	}
}

// runWatchdogInstallCommand runs name+args with a deadline. On failure the
// returned error carries only a bounded summary (exit status / timeout); the
// command's output stays in a local Debug line.
func runWatchdogInstallCommand(timeout time.Duration, name string, args ...string) error {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, name, args...).CombinedOutput()
	if err == nil {
		return nil
	}
	// The output is our own (verified) watchdog binary's installer text — no
	// download URLs — and is the only diagnostic when the install fails, so
	// its tail goes to a shipped Warn line.
	if len(out) > 512 {
		out = out[len(out)-512:]
	}
	if len(out) > 0 {
		log.Warn("watchdog service install failed", "outputTail", string(out))
	}
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return fmt.Errorf("watchdog service install timed out after %s", timeout)
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		return fmt.Errorf("watchdog service install exited with status %d", exitErr.ExitCode())
	}
	// A start failure (ENOENT, EACCES, noexec mount, wrong-arch binary) is a
	// path plus an errno — no URL — and is what an operator needs to fix it.
	return fmt.Errorf("watchdog service install could not be started: %w", err)
}
