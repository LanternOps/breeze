//go:build darwin

package heartbeat

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

const darwinIsolationDataDir = "/Library/Application Support/Breeze/data"

func darwinTestScriptOptions() darwinUninstallScriptOptions {
	return darwinUninstallScriptOptions{
		Label: "com.breeze.agent", WatchdogLabel: "com.breeze.watchdog", WatchdogProcess: "breeze-watchdog",
		PlistPath: "/Library/LaunchDaemons/com.breeze.agent.plist", BinaryPath: "/usr/local/bin/breeze-agent",
		ConfigDir: "/Library/Application Support/Breeze", RemoveConfig: true, DelaySeconds: 5,
	}
}

// The detached teardown confirms the release before anything stops, and again
// once the agent has stopped: until then the agent can isolate the device again,
// and only after that may its recovery jobs go.
func TestDarwinUninstallScriptReleasesIsolationFirst(t *testing.T) {
	script := buildDarwinUninstallScript(darwinTestScriptOptions())
	assertOrder(t, script,
		"if ! breeze_release_isolation; then",
		"launchctl enable system/'com.breeze.agent'",
		"exit 1",
		"sleep 5",
		"breeze_bootout system/'com.breeze.watchdog' || exit 1",
		"breeze_stop_helpers || exit 1",
		"breeze_bootout system/'com.breeze.agent' || exit 1",
		"if ! breeze_release_isolation || ! breeze_remove_isolation; then",
		"breeze_restart_agent 'com.breeze.agent' '/Library/LaunchDaemons/com.breeze.agent.plist'",
		"rm -f '/Library/LaunchDaemons/com.breeze.agent.plist'",
		"rm -rf '/Library/Application Support/Breeze'",
	)
}

// runDarwinTeardownFixture runs the script with every command recorded and an
// isolation journal present. The fake agent's release succeeds `succeed` times.
func runDarwinTeardownFixture(t *testing.T, succeed int) (string, error) {
	t.Helper()
	// No symlink in the root (macOS's /var is one): the release step refuses to
	// run a binary below one.
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	calls := filepath.Join(root, "calls")
	for _, name := range []string{"launchctl", "pkill", "pkgutil", "rm", "rmdir", "ps", "sleep"} {
		body := "#!/bin/sh\nprintf '%s %s\\n' \"${0##*/}\" \"$*\" >> \"$FIXTURE_CALLS\"\n"
		if err := os.WriteFile(filepath.Join(root, name), []byte(body), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	// The test cannot chown: report every path as root's, as an installed agent's is.
	if err := os.WriteFile(filepath.Join(root, "ls"), []byte("#!/bin/sh\necho \"drwxr-xr-x  2 0  0  64 Jan  1 00:00 $2\"\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(root+darwinIsolationDataDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(root+darwinIsolationDataDir+"/isolation.json", []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	agent := root + "/Library/Breeze/bin/breeze-agent"
	if err := os.MkdirAll(filepath.Dir(agent), 0o700); err != nil {
		t.Fatal(err)
	}
	body := "#!/bin/sh\nprintf 'agent %s\\n' \"$*\" >> \"$FIXTURE_CALLS\"\nn=$(cat \"$FIXTURE_CALLS.count\" 2>/dev/null || echo 0)\necho $((n + 1)) > \"$FIXTURE_CALLS.count\"\n[ \"$n\" -lt " + strconv.Itoa(succeed) + " ]\n"
	if err := os.WriteFile(agent, []byte(body), 0o700); err != nil {
		t.Fatal(err)
	}
	script := strings.NewReplacer(
		darwinIsolationDataDir, root+darwinIsolationDataDir,
		"in /Library/Breeze/bin/breeze-agent /usr/local/bin/breeze-agent;", "in "+agent+";",
		"in /Library/Breeze/isolation-recovery/*/", "in "+root+"/none/*/",
		"/Library/Logs/Breeze/", root+"/logs/",
	).Replace(buildDarwinUninstallScript(darwinTestScriptOptions()))
	cmd := exec.Command("/bin/sh", "-c", script)
	cmd.Env = append(os.Environ(), "PATH="+root+":/usr/bin:/bin", "FIXTURE_CALLS="+calls)
	_, runErr := cmd.CombinedOutput()
	b, _ := os.ReadFile(calls)
	return string(b), runErr
}

// Phase 1 disabled the agent's own daemon so a reboot mid-teardown cannot
// restart it. A release that cannot be confirmed aborts the teardown, so the
// disable has to be undone, or the device stays isolated with no agent.
func TestDarwinUninstallScriptAbortsAndRestoresTheAgentWhenReleaseFails(t *testing.T) {
	log, err := runDarwinTeardownFixture(t, 0)
	if err == nil {
		t.Fatalf("the teardown continued without a confirmed release:\n%s", log)
	}
	if !strings.Contains(log, "agent containment release-all --reason uninstall") {
		t.Fatalf("no release attempted:\n%s", log)
	}
	if !strings.Contains(log, "launchctl enable system/com.breeze.agent") {
		t.Fatalf("the agent daemon was left disabled:\n%s", log)
	}
	for _, forbidden := range []string{"bootout", "pkill", "rm ", "sleep"} {
		if strings.Contains(log, forbidden) {
			t.Errorf("ran %q after an unconfirmed release:\n%s", forbidden, log)
		}
	}
}

// The agent isolated the Mac again before it stopped, and the second release
// cannot be confirmed. The recovery jobs must stay, and the agent must come back
// so the console can still release: the alternative is a Mac cut off with neither.
func TestDarwinUninstallScriptKeepsRecoveryWhenTheSecondReleaseFails(t *testing.T) {
	log, err := runDarwinTeardownFixture(t, 1)
	if err == nil {
		t.Fatalf("the teardown continued without a confirmed release:\n%s", log)
	}
	assertCallsInOrder(t, log,
		"agent containment release-all --reason uninstall",
		"launchctl bootout system/com.breeze.agent",
		"agent containment release-all --reason uninstall",
		"launchctl enable system/com.breeze.agent",
		"launchctl bootstrap system /Library/LaunchDaemons/com.breeze.agent.plist",
	)
	for _, forbidden := range []string{"com.breeze.isolation", "rm "} {
		if strings.Contains(log, forbidden) {
			t.Errorf("ran %q with the release unconfirmed:\n%s", forbidden, log)
		}
	}
}

func TestDarwinUninstallScriptCompletesWhenBothReleasesConfirm(t *testing.T) {
	log, err := runDarwinTeardownFixture(t, 2)
	if err != nil {
		t.Fatalf("%v\n%s", err, log)
	}
	assertCallsInOrder(t, log,
		"agent containment release-all --reason uninstall",
		"launchctl bootout system/com.breeze.agent",
		"agent containment release-all --reason uninstall",
		"launchctl bootout system/com.breeze.isolation.rollback",
		"rm -rf /Library/Breeze/isolation-recovery",
		"rm -f /Library/LaunchDaemons/com.breeze.agent.plist",
	)
}

// assertCallsInOrder finds each call after the previous one, so a call may repeat.
func assertCallsInOrder(t *testing.T, log string, calls ...string) {
	t.Helper()
	rest := log
	for _, call := range calls {
		i := strings.Index(rest, call)
		if i < 0 {
			t.Fatalf("missing %q, in order, from:\n%s", call, log)
		}
		rest = rest[i+len(call):]
	}
}
