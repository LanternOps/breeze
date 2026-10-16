package agentapp

import (
	"strings"
	"testing"
)

// Task 6 spike fixture (#8619, Decision 13): the running agent stages the
// verified watchdog under the agent data dir (/var/lib/breeze/watchdog-stage)
// and runs its `service install` through a systemd-run transient service.
// That is visible to the transient service because the CURRENT agent unit is
// deliberately unsandboxed — no private /tmp, no read-only system, no mount
// namespace of its own. If someone re-adds a sandbox directive, this test
// fails so the staging location is revisited (a PrivateTmp unit would hide an
// OS-temp-dir download from the transient service; ProtectSystem would make
// /var/lib/breeze need ReadWritePaths).
func TestWatchdogStagingSpike_AgentUnitHasNoMountSandbox(t *testing.T) {
	for _, directive := range []string{
		"PrivateTmp=", "ProtectSystem=", "ReadOnlyPaths=", "InaccessiblePaths=",
		"TemporaryFileSystem=", "PrivateMounts=", "RootDirectory=",
	} {
		for _, line := range strings.Split(linuxUnit, "\n") {
			l := strings.TrimSpace(line)
			if strings.HasPrefix(l, "#") {
				continue
			}
			if strings.HasPrefix(l, directive) {
				t.Fatalf("agent unit gained %q: re-check watchdog staging visibility (watchdogInstallTransientArgs)", l)
			}
		}
	}
}
