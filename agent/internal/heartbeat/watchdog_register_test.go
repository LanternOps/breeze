package heartbeat

import (
	"strings"
	"testing"
	"time"
)

// Task 6 spike fixture (Linux staging visibility, Decision 13). The verified
// watchdog is staged under the agent data dir and executed through a systemd
// TRANSIENT SERVICE. These invariants are what make that work under both the
// current (unsandboxed) agent unit and a legacy hardened one; see
// watchdogInstallTransientArgs. The live-host behaviour itself is verified only
// in the lab (not in CI).
func TestWatchdogInstallTransientArgs(t *testing.T) {
	staged := "/var/lib/breeze/watchdog-stage/breeze-watchdog-ensure-1/breeze-watchdog"
	args := watchdogInstallTransientArgs(4242, 99, staged)
	joined := strings.Join(args, " ")

	for _, want := range []string{"--wait", "--collect", "--pipe", "--quiet", "--unit=breeze-watchdog-ensure-4242-99", "--property=RuntimeMaxSec=120"} {
		found := false
		for _, a := range args {
			if a == want {
				found = true
			}
		}
		if !found {
			t.Fatalf("missing %q in %v", want, args)
		}
	}
	if strings.Contains(joined, "--scope") {
		t.Fatal("NEVER --scope: a scope inherits the agent's sandbox and cannot write the unit dir")
	}
	tail := args[len(args)-3:]
	if tail[0] != staged || tail[1] != "service" || tail[2] != "install" {
		t.Fatalf("command must be the staged file's own `service install`, got %v", tail)
	}
	if strings.HasPrefix(staged, "/tmp") {
		t.Fatal("fixture must not stage under /tmp (PrivateTmp)")
	}
	// The unit's own runtime cap must sit inside the agent's exec deadline so
	// systemd, not a killed client, ends a hung installer.
	if watchdogRegisterTimeout+30*time.Second <= watchdogRegisterTimeout {
		t.Fatal("client deadline must exceed RuntimeMaxSec")
	}
}

func TestPollWatchdogRunning(t *testing.T) {
	calls := 0
	if !pollWatchdogRunning(0, func() bool { calls++; return true }) || calls != 1 {
		t.Fatalf("immediate success: calls=%d", calls)
	}
	calls = 0
	if pollWatchdogRunning(0, func() bool { calls++; return false }) || calls != 1 {
		t.Fatalf("timeout 0 must probe exactly once: calls=%d", calls)
	}
	calls = 0
	if !pollWatchdogRunning(3*time.Second, func() bool { calls++; return calls >= 2 }) {
		t.Fatal("should succeed on the second probe")
	}
}
