package installer

// Tests for how the macOS .pkg postinstall (re)loads the desktop-helper
// LaunchAgents into the logged-in users' GUI domains and the loginwindow
// domain (#10868). Like macos_bootstrap_test.go they run the real shell under
// bash with launchctl, ps and sleep replaced by recorders on PATH, so nothing
// touches launchd and the coverage runs in the Linux agent test job.

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// fakeAgentLaunchctl keeps launchd state per service (domain/label), because
// the postinstall touches several domains in one run. A bootstrap names the
// domain and a plist; the label is the plist's basename, as with the shipped
// plists. Scenarios (SCENARIO):
//
//	ok      launchd behaves
//	lag     bootout returns while the old instance is still being torn down:
//	        print keeps reporting it loaded for two more calls and bootstrap
//	        fails with EIO 5 until it is gone (the lab mini, #10868)
//	flaky   the first bootstrap fails with EIO 5 although print already
//	        reports the service gone; the second succeeds
//	raced   something else (the agent's post-update revival) loads the
//	        service while we wait for our bootout to finish
//	stale   bootout never takes the old instance out of launchd
//	broken  launchd refuses the plist outright (EIO 5, never loads)
//	broken125  bootstrap fails with a non-EIO error (no such domain)
//	kickfail   kickstart always fails, even on a loaded service
//
//	nousers    nobody is logged in: ps lists only root's loginwindow
//
// While anyone is logged in (every scenario but nousers), every launchctl
// operation on the loginwindow domain answers exit 1 "Operation not
// permitted", even as root: measured on the lab mini for print, bootstrap
// and kickstart, with real and bogus labels alike.
//
// kickstart of a service that is not loaded exits 37, as the lab agent saw.
// print of a loginwindow/ service always fails: as non-root it answers
// "Could not print domain: 1", and it is not known to work as root, so the
// shell must not depend on it there.
const fakeAgentLaunchctl = `#!/bin/bash
echo "launchctl $*" >> "$FAKE_STATE/calls"
key() { printf '%s' "$1" | tr '/' '_'; }
loaded() { [ -f "$FAKE_STATE/loaded.$(key "$1")" ]; }
lag_left() { cat "$FAKE_STATE/lag.$(key "$1")" 2>/dev/null || echo 0; }
eio() { echo "Bootstrap failed: 5: Input/output error" >&2; exit 5; }
lw_eperm() {
  [ "$SCENARIO" != nousers ] || return 1
  case "$*" in *loginwindow*) echo "Operation not permitted" >&2; exit 1 ;; esac
}
[ -n "$LW_DIRECT" ] || lw_eperm "$@"
case "$1" in
  bootout)
    svc="$2"
    loaded "$svc" || { echo "Boot-out failed: 3: No such process" >&2; exit 3; }
    [ "$SCENARIO" = stale ] && exit 0
    [ "$SCENARIO" = lag ] && echo 2 > "$FAKE_STATE/lag.$(key "$svc")"
    [ "$SCENARIO" = raced ] && touch "$FAKE_STATE/race.$(key "$svc")"
    rm -f "$FAKE_STATE/loaded.$(key "$svc")"; exit 0 ;;
  print)
    svc="$2"
    case "$svc" in loginwindow/*) echo "Could not print domain: 1: Operation not permitted" >&2; exit 1 ;; esac
    n=$(lag_left "$svc")
    if [ "$n" -gt 0 ]; then echo $((n - 1)) > "$FAKE_STATE/lag.$(key "$svc")"; echo "state = running"; exit 0; fi
    if [ -f "$FAKE_STATE/race.$(key "$svc")" ]; then
      rm -f "$FAKE_STATE/race.$(key "$svc")"; touch "$FAKE_STATE/loaded.$(key "$svc")"
    fi
    loaded "$svc" && { echo "state = running"; exit 0; }
    echo "Could not find service \"${svc##*/}\" in domain for user gui: ${svc%/*}" >&2; exit 113 ;;
  bootstrap)
    svc="$2/$(basename "$3" .plist)"
    [ "$(lag_left "$svc")" -gt 0 ] && eio
    loaded "$svc" && eio
    [ "$SCENARIO" = broken ] && eio
    [ "$SCENARIO" = broken125 ] && { echo "Bootstrap failed: 125: Domain does not support specified action" >&2; exit 125; }
    if [ "$SCENARIO" = flaky ] && [ ! -f "$FAKE_STATE/flaked.$(key "$svc")" ]; then
      touch "$FAKE_STATE/flaked.$(key "$svc")"; eio
    fi
    touch "$FAKE_STATE/loaded.$(key "$svc")"; exit 0 ;;
  kickstart)
    svc="${!#}"
    [ "$SCENARIO" = kickfail ] && { echo "Kickstart failed: 1" >&2; exit 1; }
    loaded "$svc" && exit 0
    echo "Could not find service \"${svc##*/}\"" >&2; exit 37 ;;
esac
exit 0
`

type agentRun struct {
	out   string
	code  int
	calls string
	state string
}

func (r agentRun) loaded(svc string) bool {
	_, err := os.Stat(filepath.Join(r.state, "loaded."+strings.ReplaceAll(svc, "/", "_")))
	return err == nil
}

// runAgentShell runs body after sourcing install-location.sh, under `set -e`
// as postinstall does, against fakeAgentLaunchctl. preloaded services start
// loaded (the previous install's helper).
func runAgentShell(t *testing.T, scenario, body string, preloaded ...string) agentRun {
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
	write := func(name, content string) {
		if err := os.WriteFile(filepath.Join(bin, name), []byte(content), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	write("launchctl", fakeAgentLaunchctl)
	write("sleep", "#!/bin/sh\necho \"sleep $*\" >> \"$FAKE_STATE/calls\"\n")
	// Two GUI users plus root's login-window process, which must be skipped.
	write("ps", "#!/bin/sh\n[ \"$SCENARIO\" = nousers ] && { echo '0 /System/Library/CoreServices/loginwindow.app/Contents/MacOS/loginwindow'; exit 0; }\nprintf '%s\\n' '0 /System/Library/CoreServices/loginwindow.app/Contents/MacOS/loginwindow' '501 /System/Library/CoreServices/loginwindow.app/Contents/MacOS/loginwindow' '502 /System/Library/CoreServices/loginwindow.app/Contents/MacOS/loginwindow' '501 /usr/local/bin/breeze-desktop-helper'\n")
	for _, svc := range preloaded {
		if err := os.WriteFile(filepath.Join(state, "loaded."+strings.ReplaceAll(svc, "/", "_")), nil, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	script := "set -e\n. '" + lib + "'\n" + body + "\n"
	cmd := exec.Command(bash, "-c", script)
	cmd.Env = append(os.Environ(), "PATH="+bin+":"+os.Getenv("PATH"), "FAKE_STATE="+state, "SCENARIO="+scenario)
	if strings.HasPrefix(body, "load_launch_agent loginwindow ") {
		// The direct load_launch_agent tests exercise the function's own
		// logic in a domain that answers, as at an empty login window.
		cmd.Env = append(cmd.Env, "LW_DIRECT=1")
	}
	out, err := cmd.CombinedOutput()
	code := 0
	if ee, ok := err.(*exec.ExitError); ok {
		code = ee.ExitCode()
	} else if err != nil {
		t.Fatalf("bash: %v", err)
	}
	calls, _ := os.ReadFile(filepath.Join(state, "calls"))
	return agentRun{out: string(out), code: code, calls: string(calls), state: state}
}

const (
	userLabel   = "com.breeze.desktop-helper-user"
	userPlist   = "/Library/LaunchAgents/com.breeze.desktop-helper-user.plist"
	userSvc501  = "gui/501/" + userLabel
	userSvc502  = "gui/502/" + userLabel
	lwLabel     = "com.breeze.desktop-helper-loginwindow"
	lwPlist     = "/Library/LaunchAgents/com.breeze.desktop-helper-loginwindow.plist"
	lwSvc       = "loginwindow/" + lwLabel
	reloadUser  = "reload_launch_agent gui/501 " + userLabel + " " + userPlist
	loadLoginLW = "load_launch_agent loginwindow " + lwLabel + " " + lwPlist
)

// The #10868 regression: a bootstrap issued while launchd is still tearing
// the booted-out helper down fails with EIO 5. reload_launch_agent must wait
// for the old instance to leave before bootstrapping, so it loads first time.
func TestReloadLaunchAgentWaitsForBootoutBeforeBootstrap(t *testing.T) {
	r := runAgentShell(t, "lag", reloadUser, userSvc501)
	if r.code != 0 || !r.loaded(userSvc501) {
		t.Fatalf("exit %d, loaded=%v; want the helper loaded\noutput:\n%s\ncalls:\n%s", r.code, r.loaded(userSvc501), r.out, r.calls)
	}
	if n := strings.Count(r.calls, "launchctl bootstrap gui/501 "); n != 1 {
		t.Errorf("want one bootstrap, after the old instance is gone; got %d\ncalls:\n%s", n, r.calls)
	}
	bootout := strings.Index(r.calls, "launchctl bootout "+userSvc501)
	lastPrint := strings.LastIndex(r.calls, "launchctl print "+userSvc501)
	bootstrap := strings.Index(r.calls, "launchctl bootstrap gui/501 ")
	if bootout < 0 || lastPrint < bootout || bootstrap < lastPrint {
		t.Errorf("want bootout, then print polls, then bootstrap\ncalls:\n%s", r.calls)
	}
	// Short polls, not whole seconds: the box needed one 0.5 s poll.
	if !strings.Contains(r.calls, "sleep 0.5") {
		t.Errorf("want 0.5 s polls while the old instance leaves\ncalls:\n%s", r.calls)
	}
}

func TestReloadLaunchAgentLoadsOnFirstInstall(t *testing.T) {
	r := runAgentShell(t, "ok", reloadUser)
	if r.code != 0 || !r.loaded(userSvc501) {
		t.Fatalf("exit %d, loaded=%v\noutput:\n%s\ncalls:\n%s", r.code, r.loaded(userSvc501), r.out, r.calls)
	}
	if strings.Contains(r.calls, "sleep") {
		t.Errorf("nothing was loaded, so there is nothing to wait for\ncalls:\n%s", r.calls)
	}
}

// launchd sometimes still answers EIO 5 just after print reports the service
// gone. One retry after a short wait covers it.
func TestReloadLaunchAgentRetriesBootstrapOnceOnEIO(t *testing.T) {
	r := runAgentShell(t, "flaky", reloadUser, userSvc501)
	if r.code != 0 || !r.loaded(userSvc501) {
		t.Fatalf("exit %d, loaded=%v\noutput:\n%s\ncalls:\n%s", r.code, r.loaded(userSvc501), r.out, r.calls)
	}
	if n := strings.Count(r.calls, "launchctl bootstrap gui/501 "); n != 2 {
		t.Errorf("want exactly one retry, got %d bootstraps\ncalls:\n%s", n, r.calls)
	}
	first := strings.Index(r.calls, "launchctl bootstrap gui/501 ")
	wait := strings.Index(r.calls, "sleep 1\n")
	second := strings.LastIndex(r.calls, "launchctl bootstrap gui/501 ")
	if wait < first || wait > second {
		t.Errorf("want a 1 s wait between the two bootstraps\ncalls:\n%s", r.calls)
	}
	if !strings.Contains(r.out, "Bootstrap failed: 5: Input/output error") {
		t.Errorf("the failed attempt's launchctl stderr must reach the installer log\noutput:\n%s", r.out)
	}
}

// The agent's post-update revival can load the helper while postinstall waits
// on its own bootout. A loaded helper is the goal: restart it onto the new
// binary rather than failing.
func TestReloadLaunchAgentAcceptsAHelperLoadedByTheAgent(t *testing.T) {
	r := runAgentShell(t, "raced", reloadUser, userSvc501)
	if r.code != 0 || !r.loaded(userSvc501) {
		t.Fatalf("exit %d, loaded=%v\noutput:\n%s\ncalls:\n%s", r.code, r.loaded(userSvc501), r.out, r.calls)
	}
	if !strings.Contains(r.calls, "launchctl kickstart -k "+userSvc501) || !strings.Contains(r.out, "was already loaded") {
		t.Errorf("want the already-loaded helper restarted onto the new binary\noutput:\n%s\ncalls:\n%s", r.out, r.calls)
	}
	if n := strings.Count(r.calls, "launchctl bootstrap gui/501 "); n != 1 {
		t.Errorf("a loaded helper needs no bootstrap retry, got %d bootstraps\ncalls:\n%s", n, r.calls)
	}
}

// The wait is bounded: an old instance that never leaves must not hang the
// installer, which is also the unattended self-update path.
func TestReloadLaunchAgentWaitIsBounded(t *testing.T) {
	r := runAgentShell(t, "stale", reloadUser, userSvc501)
	// 15 s: the lab mini's idle helper took 2.4-2.9 s to leave launchd, and
	// launchd allows a slow exit (a helper mid-session) up to 20 s.
	if n := strings.Count(r.calls, "sleep 0.5"); n != 30 {
		t.Errorf("want a wait bounded at 30 polls (15 s), got %d\ncalls:\n%s", n, r.calls)
	}
	if !strings.Contains(r.out, "still loaded") {
		t.Errorf("want a warning that the old instance never left\noutput:\n%s", r.out)
	}
	// The stale instance is still loaded, so it is restarted onto the new
	// binary on disk: the best the installer can do.
	if r.code != 0 || !strings.Contains(r.calls, "launchctl kickstart -k "+userSvc501) {
		t.Errorf("exit %d; want the loaded instance restarted\noutput:\n%s\ncalls:\n%s", r.code, r.out, r.calls)
	}
}

// A genuine failure is reported with launchctl's own words instead of being
// thrown away, and returns non-zero so the caller can say so.
func TestReloadLaunchAgentReportsAFailure(t *testing.T) {
	r := runAgentShell(t, "broken", reloadUser, userSvc501)
	if r.code == 0 || r.loaded(userSvc501) {
		t.Fatalf("exit %d, loaded=%v; want a failure\noutput:\n%s\ncalls:\n%s", r.code, r.loaded(userSvc501), r.out, r.calls)
	}
	if n := strings.Count(r.calls, "launchctl bootstrap gui/501 "); n != 2 {
		t.Errorf("want exactly one retry, got %d bootstraps\ncalls:\n%s", n, r.calls)
	}
	for _, want := range []string{"Bootstrap failed: 5: Input/output error", userLabel, "gui/501", "sudo launchctl bootstrap gui/501 " + userPlist} {
		if !strings.Contains(r.out, want) {
			t.Errorf("output missing %q:\n%s", want, r.out)
		}
	}
}

// Only EIO 5 is retried: a different bootstrap failure will not improve in a
// second.
func TestReloadLaunchAgentDoesNotRetryOtherBootstrapErrors(t *testing.T) {
	r := runAgentShell(t, "broken125", reloadUser)
	if r.code == 0 {
		t.Fatalf("want a failure\noutput:\n%s\ncalls:\n%s", r.out, r.calls)
	}
	if n := strings.Count(r.calls, "launchctl bootstrap gui/501 "); n != 1 || strings.Contains(r.calls, "sleep") {
		t.Errorf("want a single bootstrap and no wait, got %d\ncalls:\n%s", n, r.calls)
	}
	if !strings.Contains(r.out, "Bootstrap failed: 125") {
		t.Errorf("launchctl stderr must reach the installer log\noutput:\n%s", r.out)
	}
}

// A loaded helper that kickstart cannot restart is a failure, reported with
// kickstart's own output, and the bounded retry still ends.
func TestLoadLaunchAgentReportsALoadedHelperThatWillNotRestart(t *testing.T) {
	r := runAgentShell(t, "kickfail", loadLoginLW, lwSvc)
	if r.code == 0 {
		t.Fatalf("want a failure\noutput:\n%s\ncalls:\n%s", r.out, r.calls)
	}
	if n := strings.Count(r.calls, "launchctl bootstrap loginwindow "); n != 2 {
		t.Errorf("want exactly one retry, got %d bootstraps\ncalls:\n%s", n, r.calls)
	}
	for _, want := range []string{"launchctl kickstart -k " + lwSvc + " exited 1", "Warning: could not load " + lwLabel} {
		if !strings.Contains(r.out, want) {
			t.Errorf("output missing %q:\n%s", want, r.out)
		}
	}
}

// The loginwindow helper is not booted out (postinstall never did); an
// upgrade finds it loaded, so it is restarted onto the new binary instead of
// the bootstrap's EIO 5 being swallowed.
func TestLoadLaunchAgentRestartsAnAlreadyLoadedHelper(t *testing.T) {
	r := runAgentShell(t, "ok", loadLoginLW, lwSvc)
	if r.code != 0 || !r.loaded(lwSvc) {
		t.Fatalf("exit %d\noutput:\n%s\ncalls:\n%s", r.code, r.out, r.calls)
	}
	if strings.Contains(r.calls, "bootout") {
		t.Errorf("load_launch_agent must not boot anything out\ncalls:\n%s", r.calls)
	}
	if !strings.Contains(r.calls, "launchctl kickstart -k "+lwSvc) {
		t.Errorf("want the loaded helper restarted\ncalls:\n%s", r.calls)
	}
	if strings.Contains(r.calls, "sleep") {
		t.Errorf("an already-loaded helper needs no retry wait\ncalls:\n%s", r.calls)
	}
}

func TestLoadLaunchAgentLoadsAMissingHelper(t *testing.T) {
	r := runAgentShell(t, "ok", loadLoginLW)
	if r.code != 0 || !r.loaded(lwSvc) {
		t.Fatalf("exit %d\noutput:\n%s\ncalls:\n%s", r.code, r.out, r.calls)
	}
}

// postinstallHelperBlock returns the postinstall's LaunchAgent-loading block.
func postinstallHelperBlock(t *testing.T) string {
	t.Helper()
	data, err := os.ReadFile("macos/postinstall")
	if err != nil {
		t.Fatal(err)
	}
	s := string(data)
	start := strings.Index(s, "# Load the user helper LaunchAgent")
	end := strings.Index(s, `echo "Breeze Agent installed and started."`)
	if start < 0 || end < start {
		t.Fatal("could not find the LaunchAgent-loading block in postinstall")
	}
	return s[start:end]
}

func postinstallHelperScript(t *testing.T) string {
	return "DESKTOP_USER_PLIST=" + userPlist + "\nDESKTOP_LOGINWINDOW_PLIST=" + lwPlist + "\n" +
		postinstallHelperBlock(t) + "\nexit 0\n"
}

// The block as shipped, end to end, on the #10868 upgrade: both users' helpers
// are loaded at the end, root is skipped, and the loginwindow domain (which
// refuses every operation while a user is logged in) is left alone instead of
// producing a false "could not load" warning.
func TestPostinstallReloadsEveryUsersHelperOnUpgrade(t *testing.T) {
	r := runAgentShell(t, "lag", postinstallHelperScript(t), userSvc501, userSvc502)
	if r.code != 0 {
		t.Fatalf("exit %d\noutput:\n%s\ncalls:\n%s", r.code, r.out, r.calls)
	}
	if strings.Contains(r.calls, "loginwindow") || strings.Contains(r.out, "Warning") {
		t.Errorf("with users logged in the loginwindow domain must not be touched or warned about\noutput:\n%s\ncalls:\n%s", r.out, r.calls)
	}
	for _, svc := range []string{userSvc501, userSvc502} {
		if !r.loaded(svc) {
			t.Errorf("%s is not loaded after the install\noutput:\n%s\ncalls:\n%s", svc, r.out, r.calls)
		}
	}
	if strings.Contains(r.calls, "gui/0") {
		t.Errorf("root's loginwindow process is not a GUI user session\ncalls:\n%s", r.calls)
	}
}

// A helper that will not load must not fail the install (this is also the
// unattended self-update path, and the agent is already up), but its error
// must reach the installer log.
func TestPostinstallHelperFailureWarnsWithoutFailingTheInstall(t *testing.T) {
	r := runAgentShell(t, "broken", postinstallHelperScript(t), userSvc501)
	if r.code != 0 {
		t.Fatalf("exit %d; a helper failure must not fail the install\noutput:\n%s", r.code, r.out)
	}
	if !strings.Contains(r.out, "Bootstrap failed: 5: Input/output error") {
		t.Errorf("launchctl stderr must reach the installer log\noutput:\n%s", r.out)
	}
	// One user's failure does not stop the next user.
	if !strings.Contains(r.calls, "launchctl bootstrap gui/502 ") {
		t.Errorf("want gui/502 attempted after gui/501 failed\ncalls:\n%s", r.calls)
	}
}

// With nobody logged in (a headless Mac at the login window) the login-window
// helper is still loaded by the install.
func TestPostinstallLoadsTheLoginWindowHelperWhenNobodyIsLoggedIn(t *testing.T) {
	r := runAgentShell(t, "nousers", postinstallHelperScript(t))
	if r.code != 0 || !r.loaded(lwSvc) {
		t.Fatalf("exit %d, loaded=%v\noutput:\n%s\ncalls:\n%s", r.code, r.loaded(lwSvc), r.out, r.calls)
	}
	if strings.Contains(r.calls, "gui/") {
		t.Errorf("no GUI user, so no gui domain should be touched\ncalls:\n%s", r.calls)
	}
}
