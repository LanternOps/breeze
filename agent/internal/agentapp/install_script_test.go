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

// TestInstallScriptDoesNotLetTheWatchdogAbortTheAgentInstall guards a
// regression introduced while fixing #5252.
//
// `breeze-watchdog service install` now exits non-zero when it cannot restart
// the watchdog. install-linux.sh runs under `set -e` and invokes it roughly
// halfway through — BEFORE the breeze-agent restart at the bottom. Left
// unguarded, a transient watchdog restart failure aborts the installer right
// there, the agent (already stopped near the top of the script) is never
// started, and the only error printed talks about the watchdog. That is the
// exact stranding this fix exists to prevent, reached through the watchdog leg.
func TestInstallScriptDoesNotLetTheWatchdogAbortTheAgentInstall(t *testing.T) {
	script := readInstallScript(t)

	const invocation = "/usr/local/bin/breeze-watchdog service install"
	var found bool
	for _, line := range strings.Split(script, "\n") {
		trimmed := strings.TrimSpace(line)
		// Only lines that RUN the installer count. Comments and the recovery
		// hint printed on failure mention the same command text.
		if !strings.Contains(trimmed, invocation) ||
			strings.HasPrefix(trimmed, "#") ||
			strings.HasPrefix(trimmed, "echo ") {
			continue
		}
		found = true
		guarded := strings.HasPrefix(trimmed, "if ") || strings.Contains(trimmed, "||")
		if !guarded {
			t.Errorf("install-linux.sh calls %q unguarded under `set -e` (line: %q). "+
				"A watchdog failure would abort the installer before breeze-agent is "+
				"started, leaving the host offline (#5252).", invocation, trimmed)
		}
	}
	if !found {
		t.Skip("install-linux.sh no longer invokes the watchdog installer; guard not applicable")
	}
}
