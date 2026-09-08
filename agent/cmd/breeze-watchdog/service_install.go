package main

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"
)

// standbyHoldLogInterval bounds how often a still-holding STANDBY writes a
// heartbeat to the health journal. Long enough not to flood a journal written
// on a multi-second tick, short enough that a 30-minute hold is visibly alive
// in the diagnostics bundle rather than looking like a dead watchdog.
const standbyHoldLogInterval = 5 * time.Minute

// commandRunner runs an external command and returns its combined output.
// Production code uses execCommandRunner; tests substitute a recorder so the
// exact argv sequence an install issues can be asserted (#5252).
type commandRunner func(name string, args ...string) ([]byte, error)

// execCommandRunner is the production commandRunner.
func execCommandRunner(name string, args ...string) ([]byte, error) {
	return exec.Command(name, args...).CombinedOutput()
}

// installWatchdogUnit runs the systemd tail of `breeze-watchdog service
// install`: daemon-reload, enable, and — always — restart.
//
// Always, with no enrollment-style condition, because there is nothing for a
// watchdog to wait for: it holds no credentials of its own, and an
// installed-but-not-started watchdog is precisely the #5252 condition. On the
// reporting host the new watchdog binary sat on disk at v0.110.0 while the
// v0.104.0 PROCESS kept running, so none of the fixes in the new binary were
// live and nothing recovered the stopped agent. `restart` covers both the
// already-running case (adopt the new binary) and the stopped case.
func installWatchdogUnit(run commandRunner, serviceName string) error {
	if out, err := run("systemctl", "daemon-reload"); err != nil {
		return fmt.Errorf("failed to reload systemd: %s", strings.TrimSpace(string(out)))
	}

	// An un-enabled watchdog still runs until the next reboot, which beats
	// aborting the install half-done.
	if out, err := run("systemctl", "enable", serviceName); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: failed to enable service: %s\n", strings.TrimSpace(string(out)))
	}

	if out, err := run("systemctl", "restart", serviceName); err != nil {
		return fmt.Errorf("failed to start %s after install: %s",
			serviceName, strings.TrimSpace(string(out)))
	}
	return nil
}
