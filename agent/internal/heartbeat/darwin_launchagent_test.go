package heartbeat

import (
	"strings"
	"testing"
	"time"
)

// fakeLaunchd scripts launchctl for reviveLaunchAgent. Each verb pops its next
// exit code from a queue (the last one repeats once the queue is exhausted),
// and every call is recorded, so the tests pin both the decision and the
// exact launchctl sequence without shelling out.
type fakeLaunchd struct {
	codes  map[string][]int
	calls  []string
	sleeps []time.Duration
}

func (f *fakeLaunchd) run(args ...string) (int, string) {
	f.calls = append(f.calls, strings.Join(args, " "))
	verb := args[0]
	if verb == "kickstart" && len(args) > 1 && args[1] == "-k" {
		verb = "kickstart -k"
	}
	q := f.codes[verb]
	if len(q) == 0 {
		return 0, ""
	}
	code := q[0]
	if len(q) > 1 {
		f.codes[verb] = q[1:]
	}
	if code == 0 {
		return 0, ""
	}
	return code, verb + " failed"
}

func (f *fakeLaunchd) reviver() launchAgentReviver {
	return launchAgentReviver{
		launchctl: f.run,
		sleep:     func(d time.Duration) { f.sleeps = append(f.sleeps, d) },
	}
}

var testUserHelper = darwinUserHelperTarget("501")

const (
	svc501   = "gui/501/com.breeze.desktop-helper-user"
	plist501 = "/Library/LaunchAgents/com.breeze.desktop-helper-user.plist"
)

func assertCalls(t *testing.T, f *fakeLaunchd, want ...string) {
	t.Helper()
	if strings.Join(f.calls, "\n") != strings.Join(want, "\n") {
		t.Errorf("launchctl calls:\n  %s\nwant:\n  %s", strings.Join(f.calls, "\n  "), strings.Join(want, "\n  "))
	}
}

func TestDarwinUserHelperTarget(t *testing.T) {
	got := darwinUserHelperTarget("502")
	if got.domain != "gui/502" || got.service() != "gui/502/com.breeze.desktop-helper-user" || got.plist != plist501 || got.uid != "502" {
		t.Errorf("darwinUserHelperTarget(502) = %+v", got)
	}
}

// A loaded helper is simply restarted, as before.
func TestReviveLaunchAgentKickstartsALoadedHelper(t *testing.T) {
	f := &fakeLaunchd{}
	if got := f.reviver().revive(testUserHelper); got != launchAgentKickstarted {
		t.Fatalf("outcome = %v, want kickstarted", got)
	}
	assertCalls(t, f, "kickstart -k "+svc501)
}

// #10868: the pkg's postinstall booted the helper out and its bootstrap
// failed, so kickstart -k exits 37 and the helper stays dead until re-login.
// The revival must bootstrap it, then kickstart it.
func TestReviveLaunchAgentBootstrapsAnUnloadedHelper(t *testing.T) {
	f := &fakeLaunchd{codes: map[string][]int{"kickstart -k": {37}, "print": {113}}}
	if got := f.reviver().revive(testUserHelper); got != launchAgentBootstrapped {
		t.Fatalf("outcome = %v, want bootstrapped", got)
	}
	assertCalls(t, f,
		"kickstart -k "+svc501,
		"print "+svc501,
		"bootstrap gui/501 "+plist501,
		"kickstart "+svc501,
	)
	if len(f.sleeps) != 0 {
		t.Errorf("no retry was needed, slept %v", f.sleeps)
	}
}

// launchd's own state decides "not loaded", not kickstart's exit code: a
// helper that is loaded but will not kickstart cannot be bootstrapped (it
// would answer EIO 5), so nothing more is tried.
func TestReviveLaunchAgentDoesNotBootstrapALoadedHelper(t *testing.T) {
	f := &fakeLaunchd{codes: map[string][]int{"kickstart -k": {37}, "print": {0}}}
	if got := f.reviver().revive(testUserHelper); got != launchAgentLoadedNotStarted {
		t.Fatalf("outcome = %v, want loaded-not-started", got)
	}
	assertCalls(t, f, "kickstart -k "+svc501, "print "+svc501)
}

// EIO 5 on a helper launchd still reports unloaded is launchd settling: one
// retry after a short wait.
func TestReviveLaunchAgentRetriesBootstrapOnceOnEIO(t *testing.T) {
	f := &fakeLaunchd{codes: map[string][]int{"kickstart -k": {37}, "print": {113}, "bootstrap": {5, 0}}}
	if got := f.reviver().revive(testUserHelper); got != launchAgentBootstrapped {
		t.Fatalf("outcome = %v, want bootstrapped", got)
	}
	assertCalls(t, f,
		"kickstart -k "+svc501,
		"print "+svc501,
		"bootstrap gui/501 "+plist501,
		"print "+svc501,
		"bootstrap gui/501 "+plist501,
		"kickstart "+svc501,
	)
	if len(f.sleeps) != 1 || f.sleeps[0] != time.Second {
		t.Errorf("want one 1s wait before the retry, got %v", f.sleeps)
	}
}

// The agent's revival runs while the pkg's postinstall is still loading
// helpers. If the installer won, the bootstrap fails because the helper is
// loaded now: that is success, kickstart it, do not retry.
func TestReviveLaunchAgentAcceptsAHelperTheInstallerLoaded(t *testing.T) {
	f := &fakeLaunchd{codes: map[string][]int{"kickstart -k": {37}, "print": {113, 0}, "bootstrap": {5}}}
	if got := f.reviver().revive(testUserHelper); got != launchAgentLoadedElsewhere {
		t.Fatalf("outcome = %v, want loaded-elsewhere", got)
	}
	assertCalls(t, f,
		"kickstart -k "+svc501,
		"print "+svc501,
		"bootstrap gui/501 "+plist501,
		"print "+svc501,
		"kickstart "+svc501,
	)
	if len(f.sleeps) != 0 {
		t.Errorf("no retry was needed, slept %v", f.sleeps)
	}
}

func TestReviveLaunchAgentGivesUpAfterOneRetry(t *testing.T) {
	f := &fakeLaunchd{codes: map[string][]int{"kickstart -k": {37}, "print": {113}, "bootstrap": {5}}}
	if got := f.reviver().revive(testUserHelper); got != launchAgentFailed {
		t.Fatalf("outcome = %v, want failed", got)
	}
	if n := strings.Count(strings.Join(f.calls, "\n"), "bootstrap "); n != 2 {
		t.Errorf("want exactly 2 bootstrap attempts, got %d: %v", n, f.calls)
	}
	if f.calls[len(f.calls)-1] == "kickstart "+svc501 {
		t.Errorf("nothing was loaded, so nothing should be kickstarted: %v", f.calls)
	}
}

// Only EIO 5 is retried; any other bootstrap failure (no such domain, bad
// plist) will not improve in a second.
func TestReviveLaunchAgentDoesNotRetryOtherBootstrapErrors(t *testing.T) {
	f := &fakeLaunchd{codes: map[string][]int{"kickstart -k": {37}, "print": {113}, "bootstrap": {125}}}
	if got := f.reviver().revive(testUserHelper); got != launchAgentFailed {
		t.Fatalf("outcome = %v, want failed", got)
	}
	if n := strings.Count(strings.Join(f.calls, "\n"), "bootstrap "); n != 1 || len(f.sleeps) != 0 {
		t.Errorf("want a single bootstrap and no wait, got calls %v sleeps %v", f.calls, f.sleeps)
	}
}

// Once bootstrapped, RunAtLoad has the helper starting; a failed follow-up
// kickstart does not undo the load.
func TestReviveLaunchAgentBootstrapStandsWhenTheFollowUpKickstartFails(t *testing.T) {
	f := &fakeLaunchd{codes: map[string][]int{"kickstart -k": {37}, "print": {113}, "kickstart": {1}}}
	if got := f.reviver().revive(testUserHelper); got != launchAgentBootstrapped {
		t.Fatalf("outcome = %v, want bootstrapped", got)
	}
}

// Every GUI user gets its own domain; one user's failure does not stop the
// next user's revival.
func TestReviveDarwinUserHelpersCoversEveryUID(t *testing.T) {
	f := &fakeLaunchd{codes: map[string][]int{"kickstart -k": {37, 0}, "print": {113}, "bootstrap": {125}}}
	reviveDarwinUserHelpers(f.reviver(), []string{"501", "502"})
	assertCalls(t, f,
		"kickstart -k "+svc501,
		"print "+svc501,
		"bootstrap gui/501 "+plist501,
		"print "+svc501,
		"kickstart -k gui/502/com.breeze.desktop-helper-user",
	)
}
