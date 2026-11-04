//go:build darwin

package heartbeat

import (
	"os"
	"os/exec"
	"path/filepath"
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

// The detached teardown re-confirms the release before anything stops: the
// handler released in-process, but the device can be isolated again in the
// seconds before the helper runs.
func TestDarwinUninstallScriptReleasesIsolationFirst(t *testing.T) {
	script := buildDarwinUninstallScript(darwinTestScriptOptions())
	assertOrder(t, script,
		"if ! breeze_release_isolation; then",
		"launchctl enable system/'com.breeze.agent'",
		"exit 1",
		"sleep 5",
		"breeze_bootout system/'com.breeze.watchdog' || exit 1",
		"breeze_stop_helpers || exit 1",
		"breeze_remove_isolation || exit 1",
		"breeze_bootout system/'com.breeze.agent' || exit 1",
		"rm -rf '/Library/Application Support/Breeze'",
	)
}

// Phase 1 disabled the agent's own daemon so a reboot mid-teardown cannot
// restart it. A release that cannot be confirmed aborts the teardown, so the
// disable has to be undone, or the device stays isolated with no agent.
func TestDarwinUninstallScriptAbortsAndRestoresTheAgentWhenReleaseFails(t *testing.T) {
	if _, err := os.Stat("/usr/bin/true"); err != nil {
		t.Skip("POSIX fixture")
	}
	root := t.TempDir()
	calls := filepath.Join(root, "calls")
	for _, name := range []string{"launchctl", "pkill", "pkgutil", "rm", "rmdir", "ps", "sleep"} {
		body := "#!/bin/sh\nprintf '%s %s\\n' \"${0##*/}\" \"$*\" >> \"$FIXTURE_CALLS\"\n"
		if err := os.WriteFile(filepath.Join(root, name), []byte(body), 0o700); err != nil {
			t.Fatal(err)
		}
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
	if err := os.WriteFile(agent, []byte("#!/bin/sh\nprintf 'agent %s\\n' \"$*\" >> \"$FIXTURE_CALLS\"\nexit 1\n"), 0o700); err != nil {
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
	out, err := cmd.CombinedOutput()
	if err == nil {
		t.Fatalf("the teardown continued without a confirmed release:\n%s", out)
	}
	b, _ := os.ReadFile(calls)
	log := string(b)
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
