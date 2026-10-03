package installer

// Tests for how the macOS .pkg postinstall loads the launchd daemons (#7831).
// They run the real install-location.sh functions under bash with launchctl
// and sleep replaced by recorders on PATH, so nothing touches launchd and the
// coverage runs in the Linux agent test job.

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// fakeLaunchctl models the launchd behaviours behind "Bootstrap failed: 5":
//
//	disabled  the label sits in the override database (self_uninstall runs
//	          `launchctl disable`) and bootstrap fails until it is enabled
//	lag       bootout returns while the old instance is still being torn down;
//	          the label stays loaded for two more print calls and bootstrap
//	          fails until it is gone
//	raced     another bootstrapper (the watchdog's recovery) loads the label
//	          first, so our bootstrap fails because it is already loaded
//	broken    launchd refuses the plist outright and never loads it
//	ok        everything works first time
const fakeLaunchctl = `#!/bin/bash
echo "launchctl $*" >> "$FAKE_STATE/calls"
loaded() { [ -f "$FAKE_STATE/loaded" ]; }
lagging() {
  n=$(cat "$FAKE_STATE/lag" 2>/dev/null || echo 0)
  [ "$n" -gt 0 ] || return 1
  echo $((n - 1)) > "$FAKE_STATE/lag"
}
case "$1" in
  enable) touch "$FAKE_STATE/enabled"; exit 0 ;;
  bootout)
    [ "$SCENARIO" = lag ] && echo 2 > "$FAKE_STATE/lag"
    rm -f "$FAKE_STATE/loaded"; exit 0 ;;
  print)
    lagging && exit 0
    loaded && exit 0
    exit 113 ;;
  bootstrap)
    fail() { echo "Bootstrap failed: 5: Input/output error" >&2; exit 5; }
    case "$SCENARIO" in
      disabled) [ -f "$FAKE_STATE/enabled" ] || fail ;;
      lag) [ "$(cat "$FAKE_STATE/lag" 2>/dev/null || echo 0)" -gt 0 ] && fail ;;
      raced) touch "$FAKE_STATE/loaded"; fail ;;
      broken) fail ;;
    esac
    touch "$FAKE_STATE/loaded"; exit 0 ;;
  kickstart) loaded && exit 0; exit 113 ;;
  print-disabled) [ -f "$FAKE_STATE/enabled" ] || echo '"com.breeze.agent" => disabled'; exit 0 ;;
esac
exit 0
`

// runBootstrap runs bootstrap_system_daemon for the agent label against the
// fake launchctl and returns (stdout+stderr, exit code, recorded calls).
func runBootstrap(t *testing.T, scenario string) (string, int, string) {
	t.Helper()
	bash, err := exec.LookPath("bash")
	if err != nil {
		t.Skip("bash not available")
	}
	lib, err := filepath.Abs(installLocationLib)
	if err != nil {
		t.Fatal(err)
	}
	bin := t.TempDir()
	state := t.TempDir()
	if err := os.WriteFile(filepath.Join(bin, "launchctl"), []byte(fakeLaunchctl), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(bin, "sleep"), []byte("#!/bin/sh\necho \"sleep $*\" >> \"$FAKE_STATE/calls\"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	plist := filepath.Join(t.TempDir(), "com.breeze.agent.plist")
	if err := os.WriteFile(plist, []byte("<plist/>"), 0o644); err != nil {
		t.Fatal(err)
	}
	// Mirrors postinstall: sourced under `set -e`.
	script := "set -e\n. '" + lib + "'\nbootstrap_system_daemon com.breeze.agent '" + plist + "'\n"
	cmd := exec.Command(bash, "-c", script)
	cmd.Env = append(os.Environ(), "PATH="+bin+":"+os.Getenv("PATH"), "FAKE_STATE="+state, "SCENARIO="+scenario)
	out, err := cmd.CombinedOutput()
	code := 0
	if ee, ok := err.(*exec.ExitError); ok {
		code = ee.ExitCode()
	} else if err != nil {
		t.Fatalf("bash: %v", err)
	}
	calls, _ := os.ReadFile(filepath.Join(state, "calls"))
	if _, statErr := os.Stat(filepath.Join(state, "loaded")); (statErr == nil) != (code == 0) {
		t.Errorf("exit %d does not match whether the daemon ended up loaded (%v)\noutput:\n%s\ncalls:\n%s", code, statErr == nil, out, calls)
	}
	return string(out), code, string(calls)
}

func TestBootstrapSystemDaemonLoadsTheDaemon(t *testing.T) {
	for _, scenario := range []string{"ok", "disabled", "lag", "raced"} {
		t.Run(scenario, func(t *testing.T) {
			out, code, calls := runBootstrap(t, scenario)
			if code != 0 {
				t.Fatalf("exit %d, want 0\noutput:\n%s\ncalls:\n%s", code, out, calls)
			}
			// enable must precede the first bootstrap: a disabled label
			// refuses bootstrap with the same EIO 5 the reporter saw.
			en := strings.Index(calls, "launchctl enable system/com.breeze.agent")
			bs := strings.Index(calls, "launchctl bootstrap system ")
			if en < 0 || bs < 0 || en > bs {
				t.Errorf("want enable before bootstrap, calls:\n%s", calls)
			}
		})
	}
}

// A bootout that has not finished tearing the old instance down must be
// waited out, not raced: bootstrapping a label that is still loaded is one of
// the ways launchctl answers EIO 5.
func TestBootstrapSystemDaemonWaitsForBootoutToFinish(t *testing.T) {
	_, code, calls := runBootstrap(t, "lag")
	if code != 0 {
		t.Fatalf("exit %d", code)
	}
	if strings.Count(calls, "launchctl bootstrap system ") != 1 {
		t.Errorf("bootstrap should run once, after the old instance is gone; calls:\n%s", calls)
	}
}

// When the watchdog's recovery loaded the agent between our bootout and our
// bootstrap, the failed bootstrap is not an install failure: the daemon is
// loaded, and a plain kickstart (no -k) confirms it is running.
func TestBootstrapSystemDaemonAcceptsALabelLoadedByARacer(t *testing.T) {
	_, code, calls := runBootstrap(t, "raced")
	if code != 0 {
		t.Fatalf("exit %d", code)
	}
	if !strings.Contains(calls, "launchctl kickstart system/com.breeze.agent") || strings.Contains(calls, "kickstart -k") {
		t.Errorf("want a plain kickstart of the already-loaded label, calls:\n%s", calls)
	}
}

// A genuine failure still fails the install, and says what to do next rather
// than leaving the operator with a bare "Input/output error".
func TestBootstrapSystemDaemonExplainsAFailure(t *testing.T) {
	out, code, calls := runBootstrap(t, "broken")
	if code == 0 {
		t.Fatalf("a daemon launchd refuses must fail the install; calls:\n%s", calls)
	}
	if n := strings.Count(calls, "launchctl bootstrap system "); n < 2 {
		t.Errorf("want the bootstrap retried before giving up, got %d attempts", n)
	}
	for _, want := range []string{
		"com.breeze.agent",
		"Bootstrap failed: 5: Input/output error",
		"sudo launchctl enable system/com.breeze.agent",
		"sudo launchctl bootstrap system ",
		"/var/log/install.log",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("failure output missing %q:\n%s", want, out)
		}
	}
}

// The fallback to /Library/Breeze/bin is supported, but the operator should
// learn why it happened and how to get /usr/local/bin back without guessing
// (#7831: chown on /usr/local itself fails, it is SIP-restricted).
func TestExplainUnsafeLegacyDirNamesTheOffendingDirectory(t *testing.T) {
	if isRoot() {
		t.Skip("fixture relies on the test process not being root")
	}
	dir := filepath.Join(t.TempDir(), "bin")
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	out, code := runLib(t, "", "explain_unsafe_legacy_dir '"+dir+"'")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, out)
	}
	for _, want := range []string{dir, "owner uid " + strconv.Itoa(os.Geteuid()), "sudo chown root:wheel " + dir, "/Library/Breeze/bin"} {
		if !strings.Contains(out, want) {
			t.Errorf("explanation missing %q:\n%s", want, out)
		}
	}
}

// The postinstall must load the agent through the hardened helper, and load
// it BEFORE the watchdog: a watchdog started first finds no agent and, within
// one process tick, bootstraps the agent itself — racing the postinstall's own
// bootout/bootstrap pair. `breeze-agent service install` already orders them
// agent-first.
func TestPostinstallLoadsAgentBeforeWatchdogViaHelper(t *testing.T) {
	data, err := os.ReadFile("macos/postinstall")
	if err != nil {
		t.Fatal(err)
	}
	s := string(data)
	agent := strings.Index(s, `bootstrap_system_daemon com.breeze.agent "$DAEMON_PLIST"`)
	watchdog := strings.Index(s, `bootstrap_system_daemon com.breeze.watchdog "$WATCHDOG_PLIST"`)
	if agent < 0 || watchdog < 0 {
		t.Fatalf("postinstall must load both daemons via bootstrap_system_daemon")
	}
	if agent > watchdog {
		t.Error("postinstall must load the agent before the watchdog")
	}
	if strings.Contains(s, `launchctl bootstrap system "$DAEMON_PLIST"`) || strings.Contains(s, `launchctl bootstrap system "$WATCHDOG_PLIST"`) {
		t.Error("postinstall still bootstraps a daemon directly instead of via the helper")
	}
	if !strings.Contains(s, `explain_unsafe_legacy_dir "$LEGACY_BIN_DIR"`) {
		t.Error("postinstall must explain why it fell back to the trusted directory")
	}
}
