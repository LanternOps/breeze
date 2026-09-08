package agentapp

import (
	"os"
	"strings"
	"testing"
)

// installLinuxScript is the shell installer that ships in the Linux tarball.
// It is the third copy of the "stop, rewrite, enable" sequence that #5252 was
// about (the other two are the agent and watchdog `service install` commands),
// and the only one with no compiler or type checker watching it — so it gets a
// guard here, in the job that already runs on every agent change.
const installLinuxScript = "../../scripts/install/install-linux.sh"

func readInstallScript(t *testing.T) string {
	t.Helper()
	data, err := os.ReadFile(installLinuxScript)
	if err != nil {
		t.Fatalf("failed to read %s: %v", installLinuxScript, err)
	}
	return string(data)
}

// TestInstallScriptStartsTheAgentItStopped is the regression guard for the
// shell half of #5252: the script stopped breeze-agent to replace the binary,
// enabled the unit, printed "Next steps: 1. Start" — and exited, leaving a
// remote host offline.
func TestInstallScriptStartsTheAgentItStopped(t *testing.T) {
	script := readInstallScript(t)

	if !strings.Contains(script, "systemctl stop breeze-agent") {
		t.Skip("script no longer stops the agent; the start requirement below no longer applies")
	}
	if !strings.Contains(script, "systemctl restart breeze-agent") {
		t.Error("install-linux.sh stops breeze-agent but never starts it again — " +
			"an already-enrolled remote host is left offline with no management path (#5252)")
	}
}

// TestInstallScriptSamplesRunningStateBeforeStopping — the decision to start
// again must be based on the state BEFORE the script's own stop. Sampling
// afterwards always reports "not running", which is exactly the inverted check
// that shipped in the Go command.
func TestInstallScriptSamplesRunningStateBeforeStopping(t *testing.T) {
	script := readInstallScript(t)

	sample := strings.Index(script, "systemctl is-active --quiet breeze-agent")
	stop := strings.Index(script, "systemctl stop breeze-agent")
	if sample < 0 {
		t.Fatal("install-linux.sh must record whether breeze-agent was active before it stops it (#5252)")
	}
	if stop >= 0 && sample > stop {
		t.Error("install-linux.sh samples breeze-agent's active state AFTER its own stop — " +
			"that check can only ever report 'not running' (#5252)")
	}
}

// TestInstallScriptStartsTheAgentAfterIPCPrereqs — the agent inherits its
// group list and opens its IPC socket in /var/run/breeze at startup, so a
// start issued before the breeze group and that directory exist comes up
// without a usable socket.
func TestInstallScriptStartsTheAgentAfterIPCPrereqs(t *testing.T) {
	script := readInstallScript(t)

	start := strings.Index(script, "systemctl restart breeze-agent")
	group := strings.Index(script, "groupadd --system breeze")
	ipcDir := strings.Index(script, `mkdir -p "$IPC_DIR"`)
	if start < 0 || group < 0 || ipcDir < 0 {
		t.Fatalf("install script shape changed (start=%d group=%d ipcDir=%d) — re-check the ordering guard",
			start, group, ipcDir)
	}
	if start < group || start < ipcDir {
		t.Error("install-linux.sh starts breeze-agent before creating the breeze group / IPC directory; " +
			"the agent would come up without a usable IPC socket")
	}
}

// TestInstallScriptStillRestartsTheWatchdog — the host in #5252 kept running a
// v0.104.0 watchdog process while the v0.110.0 binary sat on disk, so none of
// the watchdog's recovery behaviour was live.
func TestInstallScriptStillRestartsTheWatchdog(t *testing.T) {
	script := readInstallScript(t)
	if !strings.Contains(script, "systemctl restart breeze-watchdog") {
		t.Error("install-linux.sh must restart breeze-watchdog so a staged new binary actually takes over (#5252)")
	}
}
