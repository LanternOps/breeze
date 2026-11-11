package helper

import (
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

// #10379: with nobody signed in, Assist was launched as SYSTEM into the
// logon-screen session, exited 101, and the watcher counted every exit until
// it gave up and reported crash_loop. "No interactive user" is a wait: no
// launch, no crash count, one DEBUG line per change, and Assist launches as
// soon as a user is signed in.

const (
	waitingForUserLog = "breeze assist waiting for a signed-in user"
	noUserTokenLog    = "breeze assist not started: no user token for the session's signed-in user"
)

// windowsWaitForUser turns on the Windows-only wait so these paths run on any
// test host.
func windowsWaitForUser(t *testing.T) {
	t.Helper()
	orig := waitForSignedInUser
	waitForSignedInUser = true
	t.Cleanup(func() { waitForSignedInUser = orig })
}

func noInteractiveUser(string, string, ...string) (int, error) {
	return 0, fmt.Errorf("spawn assist in session 1: %w", ErrNoActiveSession)
}

// The manager's side of the wait; which sessions get listed is pinned by
// TestConsoleOnlySessions.
func TestApplyWithNoListedSessionWaitsThenLaunchesOnSignIn(t *testing.T) {
	buf := captureLogs(t)
	windowsWaitForUser(t)
	mgr, _ := newNotInstalledManager(t)
	t.Cleanup(mgr.Shutdown)
	alive := false
	_, spawns := crashingAssist(t, mgr, &alive, 101)
	enum := mgr.sessionEnumerator.(*mockEnumerator)
	enum.sessions = nil // the enumerator found no session a user is signed in to

	for i := 0; i < 3; i++ {
		mgr.Apply(&Settings{Enabled: true})
	}

	if *spawns != 0 {
		t.Fatalf("spawns with nobody signed in = %d, want 0", *spawns)
	}
	if issue := mgr.InstallIssue(); issue != "" {
		t.Fatalf("InstallIssue with nobody signed in = %q, want none", issue)
	}
	waits := linesContaining(buf, waitingForUserLog)
	if len(waits) != 1 || !strings.Contains(waits[0], "level=DEBUG") {
		t.Fatalf("want one DEBUG wait line across 3 heartbeats, got %v", waits)
	}

	// A user signs in: the next heartbeat launches Assist into that session.
	var gotKey string
	mgr.mu.Lock()
	enum.sessions = []SessionInfo{{Key: "1", Username: "kit"}}
	mgr.spawnFunc = func(key, _ string, _ ...string) (int, error) {
		*spawns++
		gotKey = key
		alive = true
		return 777, nil
	}
	mgr.mu.Unlock()
	mgr.Apply(&Settings{Enabled: true})
	if *spawns != 1 || gotKey != "1" {
		t.Fatalf("after sign-in: spawns=%d key=%q, want 1 launch into session 1", *spawns, gotKey)
	}

	// Signing out again is a new wait, logged again.
	mgr.mu.Lock()
	alive = false
	enum.sessions = nil
	mgr.mu.Unlock()
	mgr.Apply(&Settings{Enabled: true})
	if waits := linesContaining(buf, waitingForUserLog); len(waits) != 2 {
		t.Fatalf("a new wait after a sign-in must be logged again, got %v", waits)
	}
}

// Off Windows the wait line stays out of the log.
func TestApplyOffWindowsLogsNoWaitForAnEmptySessionList(t *testing.T) {
	buf := captureLogs(t)
	orig := waitForSignedInUser
	waitForSignedInUser = false
	t.Cleanup(func() { waitForSignedInUser = orig })
	mgr, _ := newNotInstalledManager(t)
	t.Cleanup(mgr.Shutdown)
	alive := false
	crashingAssist(t, mgr, &alive, 0)
	mgr.sessionEnumerator.(*mockEnumerator).sessions = nil

	mgr.Apply(&Settings{Enabled: true})

	if waits := linesContaining(buf, waitingForUserLog); len(waits) != 0 {
		t.Fatalf("no wait line off Windows, got %v", waits)
	}
}

// A signed-in user whose session yields no token is not "nobody signed in". A
// short wait is normal (explorer.exe still starting), but if it lasts the
// reason must reach the server, and only warn+ ships.
func TestApplyWarnsOnceWhenASignedInUserHasNoToken(t *testing.T) {
	buf := captureLogs(t)
	mgr, _ := newNotInstalledManager(t)
	t.Cleanup(mgr.Shutdown)
	alive := false
	crashingAssist(t, mgr, &alive, 0)
	noToken := func(string, string, ...string) (int, error) {
		return 0, fmt.Errorf("session 1: %w (user (explorer): OpenProcess: access denied)", ErrNoActiveSession)
	}
	mgr.spawnFunc = noToken
	clock := time.Now()
	mgr.now = func() time.Time { return clock }
	warns := func() []string { return linesContaining(buf, noUserTokenLog) }

	mgr.Apply(&Settings{Enabled: true})
	clock = clock.Add(userTokenGrace - time.Second)
	mgr.Apply(&Settings{Enabled: true})
	if got := warns(); len(got) != 0 {
		t.Fatalf("no WARN inside the grace period, got %v", got)
	}

	clock = clock.Add(2 * time.Second)
	mgr.Apply(&Settings{Enabled: true})
	mgr.Apply(&Settings{Enabled: true})
	got := warns()
	if len(got) != 1 || !strings.Contains(got[0], "level=WARN") {
		t.Fatalf("want one WARN once the grace passed, got %v", got)
	}
	if !strings.Contains(got[0], "access denied") {
		t.Fatalf("the WARN must carry the strategy errors: %s", got[0])
	}
	if issue := mgr.InstallIssue(); issue == InstallIssueCrashLoop {
		t.Fatal("no token is not a crash loop")
	}

	// A launch ends the episode: the next one gets its own grace and WARN.
	mgr.mu.Lock()
	mgr.spawnFunc = func(string, string, ...string) (int, error) { alive = true; return 777, nil }
	mgr.mu.Unlock()
	mgr.Apply(&Settings{Enabled: true})
	if lines := linesContaining(buf, "signed-in user present; breeze assist launched"); len(lines) != 1 {
		t.Fatalf("the end of the wait must be logged once, got %v", lines)
	}
	mgr.mu.Lock()
	alive = false
	mgr.spawnFunc = noToken
	mgr.mu.Unlock()
	mgr.Apply(&Settings{Enabled: true})
	if got := warns(); len(got) != 1 {
		t.Fatalf("a new episode starts its grace over, got %v", got)
	}
	clock = clock.Add(userTokenGrace + time.Second)
	mgr.Apply(&Settings{Enabled: true})
	if got := warns(); len(got) != 2 {
		t.Fatalf("want a second WARN for the second episode, got %v", got)
	}
}

// Assist found running ends a wait even though this agent did not launch it.
func TestEnsureRunningEndsTheWaitWhenAssistIsRunning(t *testing.T) {
	mgr, _ := newNotInstalledManager(t)
	t.Cleanup(mgr.Shutdown)
	alive := true
	_, spawns := crashingAssist(t, mgr, &alive, 0)
	state := newSessionState("1", mgr.baseDir)
	state.spawnedPID = 777 // the running check that works on every test host
	state.waitingForUser = true
	state.noTokenSince = time.Now()
	state.noTokenWarned = true

	mgr.mu.Lock()
	err := mgr.ensureRunningSession(state)
	mgr.mu.Unlock()

	if err != nil {
		t.Fatal(err)
	}
	if *spawns != 0 {
		t.Fatalf("spawns = %d; this must take the already-running path", *spawns)
	}
	if state.waitingForUser || !state.noTokenSince.IsZero() || state.noTokenWarned {
		t.Fatalf("wait state not cleared: %+v", state)
	}
}

// The spawn path itself found no user token (the user signed out between the
// enumeration and the launch, or explorer.exe has not started yet): DEBUG
// once, no ERROR, no watcher, no crash_loop.
func TestApplyNoInteractiveUserIsAWaitLoggedOnce(t *testing.T) {
	buf := captureLogs(t)
	mgr, _ := newNotInstalledManager(t)
	t.Cleanup(mgr.Shutdown)
	alive := false
	crashingAssist(t, mgr, &alive, 0)
	mgr.spawnFunc = noInteractiveUser

	for i := 0; i < 3; i++ {
		mgr.Apply(&Settings{Enabled: true})
	}

	if lines := linesContaining(buf, "failed to start breeze assist"); len(lines) != 0 {
		t.Fatalf("no interactive user must not log a launch failure: %v", lines)
	}
	waits := linesContaining(buf, waitingForUserLog)
	if len(waits) != 1 || !strings.Contains(waits[0], "level=DEBUG") {
		t.Fatalf("want exactly one DEBUG wait line across 3 heartbeats, got %v", waits)
	}
	mgr.mu.Lock()
	st := mgr.sessions["1"]
	watching := st != nil && st.watcher != nil
	failures := 0
	if st != nil {
		failures = st.crashFailures
	}
	mgr.mu.Unlock()
	if watching {
		t.Fatal("no watcher may run while waiting for a user")
	}
	if failures != 0 {
		t.Fatalf("crashFailures while waiting = %d, want 0", failures)
	}
	if issue := mgr.InstallIssue(); issue != "" {
		t.Fatalf("InstallIssue while waiting = %q, want none", issue)
	}

	// The user's token is available: Assist launches, and the next wait is a
	// new state change that is logged again.
	mgr.mu.Lock()
	mgr.spawnFunc = func(string, string, ...string) (int, error) { alive = true; return 777, nil }
	mgr.mu.Unlock()
	mgr.Apply(&Settings{Enabled: true})
	mgr.mu.Lock()
	launched := mgr.sessions["1"].watcher != nil
	alive = false
	mgr.spawnFunc = noInteractiveUser
	mgr.mu.Unlock()
	if !launched {
		t.Fatal("Assist must launch and be watched once the user token is available")
	}
	mgr.Apply(&Settings{Enabled: true})
	if waits := linesContaining(buf, waitingForUserLog); len(waits) != 2 {
		t.Fatalf("a second wait after a launch must be logged again, got %v", waits)
	}
}

// The user signs out while Assist runs: the watcher finds it gone and no
// signed-in user. It waits instead of counting a crash and relaunching.
func TestWatcherWaitsWhenTheUserSignsOut(t *testing.T) {
	buf := captureLogs(t)
	fastWatcher(t)
	windowsWaitForUser(t)
	mgr, _ := newNotInstalledManager(t)
	t.Cleanup(mgr.Shutdown)
	alive := true
	_, spawns := crashingAssist(t, mgr, &alive, 0)
	enum := mgr.sessionEnumerator.(*mockEnumerator)

	mgr.Apply(&Settings{Enabled: true})
	mgr.mu.Lock()
	mgr.sessions["1"].crashFailures = 2 // earlier real crashes: the wait must not touch them
	before := *spawns
	alive = false
	enum.sessions = nil // signed out: the console is back at the logon screen
	mgr.mu.Unlock()
	waitWatcherDone(t, mgr)

	mgr.mu.Lock()
	st := mgr.sessions["1"]
	failures, gaveUp := st.crashFailures, st.watcherGaveUp
	after := *spawns
	mgr.mu.Unlock()
	if after != before {
		t.Fatalf("watcher relaunched Assist with nobody signed in (%d -> %d spawns)", before, after)
	}
	if failures != 2 {
		t.Fatalf("crashFailures = %d after the wait, want 2 (untouched)", failures)
	}
	if gaveUp {
		t.Fatal("watcher gave up on a session nobody is signed in to")
	}
	if issue := mgr.InstallIssue(); issue == InstallIssueCrashLoop {
		t.Fatal("waiting for a user must not report crash_loop")
	}
	if lines := linesContaining(buf, "restarted by watcher"); len(lines) != 0 {
		t.Fatalf("a sign-out is not a crash: %v", lines)
	}
	waits := linesContaining(buf, waitingForUserLog)
	if len(waits) != 1 || !strings.Contains(waits[0], "level=DEBUG") {
		t.Fatalf("want one DEBUG wait line, got %v", waits)
	}
}

// The heartbeat after a sign-out drops the session's state with whatever it
// held, a crash-loop give-up included, so the next user gets a fresh start.
// A running Assist there is stopped; Windows normally ends it at sign-out.
func TestApplyAfterSignOutDropsTheSessionAndItsCrashState(t *testing.T) {
	windowsWaitForUser(t)
	mgr, _ := newNotInstalledManager(t)
	t.Cleanup(mgr.Shutdown)
	alive := true
	_, spawns := crashingAssist(t, mgr, &alive, 101)
	stopped := 0
	mgr.stopIfOursFunc = func(int, string) (bool, error) { stopped++; alive = false; return true, nil }
	enum := mgr.sessionEnumerator.(*mockEnumerator)

	mgr.Apply(&Settings{Enabled: true})
	mgr.mu.Lock()
	st := mgr.sessions["1"]
	st.watcherGaveUp, st.gaveUpAt = true, time.Now()
	st.crashFailures = 3
	enum.sessions = nil
	mgr.mu.Unlock()
	if issue := mgr.InstallIssue(); issue != InstallIssueCrashLoop {
		t.Fatalf("setup: InstallIssue = %q, want crash_loop", issue)
	}

	mgr.Apply(&Settings{Enabled: true})

	mgr.mu.Lock()
	_, kept := mgr.sessions["1"]
	before := *spawns
	mgr.mu.Unlock()
	if kept {
		t.Fatal("the session's state must go with the user")
	}
	if stopped == 0 {
		t.Fatal("a running Assist must be stopped when its session goes away")
	}
	if issue := mgr.InstallIssue(); issue != "" {
		t.Fatalf("InstallIssue after sign-out = %q, want none", issue)
	}

	mgr.mu.Lock()
	enum.sessions = []SessionInfo{{Key: "1", Username: "kit", UID: 1}}
	mgr.mu.Unlock()
	mgr.Apply(&Settings{Enabled: true})
	mgr.mu.Lock()
	defer mgr.mu.Unlock()
	if *spawns != before+1 {
		t.Fatalf("spawns after the next sign-in = %d, want %d", *spawns, before+1)
	}
	if st := mgr.sessions["1"]; st.watcherGaveUp || st.crashFailures != 0 {
		t.Fatalf("the next user must start fresh: gaveUp=%v failures=%d", st.watcherGaveUp, st.crashFailures)
	}
}

// After the wait the next heartbeat relaunches into the session and a live
// watcher takes over from the one that exited.
func TestApplyRelaunchesAfterTheWatcherWaited(t *testing.T) {
	fastWatcher(t)
	windowsWaitForUser(t)
	mgr, _ := newNotInstalledManager(t)
	t.Cleanup(mgr.Shutdown)
	alive := true
	_, spawns := crashingAssist(t, mgr, &alive, 0)
	enum := mgr.sessionEnumerator.(*mockEnumerator)

	mgr.Apply(&Settings{Enabled: true})
	mgr.mu.Lock()
	alive = false
	enum.sessions = nil
	mgr.mu.Unlock()
	waitWatcherDone(t, mgr)

	mgr.mu.Lock()
	before := *spawns
	enum.sessions = []SessionInfo{{Key: "1", Username: "kit", UID: 1}}
	mgr.spawnFunc = func(string, string, ...string) (int, error) {
		*spawns++
		alive = true // the user's Assist stays up
		return 777, nil
	}
	mgr.mu.Unlock()
	mgr.Apply(&Settings{Enabled: true})

	mgr.mu.Lock()
	defer mgr.mu.Unlock()
	if *spawns != before+1 {
		t.Fatalf("spawns after sign-in = %d, want %d", *spawns, before+1)
	}
	st := mgr.sessions["1"]
	if st.waitingForUser {
		t.Fatal("the wait must end once Assist launched")
	}
	select {
	case <-st.watcher.done:
		t.Fatal("a live watcher must be watching the relaunched Assist")
	default:
	}
}

// macOS and Linux keep today's behaviour: a watcher tick that finds Assist gone
// counts and relaunches. Only Windows waits on the enumerator.
func TestWatcherOffWindowsDoesNotWaitOnTheEnumerator(t *testing.T) {
	fastWatcher(t)
	orig := waitForSignedInUser
	waitForSignedInUser = false
	t.Cleanup(func() { waitForSignedInUser = orig })
	mgr, _ := newNotInstalledManager(t)
	t.Cleanup(mgr.Shutdown)
	alive := true
	_, spawns := crashingAssist(t, mgr, &alive, 0)
	enum := mgr.sessionEnumerator.(*mockEnumerator)

	mgr.Apply(&Settings{Enabled: true})
	mgr.mu.Lock()
	before := *spawns
	alive = false
	enum.sessions = nil
	mgr.mu.Unlock()
	waitWatcherDone(t, mgr)

	mgr.mu.Lock()
	defer mgr.mu.Unlock()
	if *spawns <= before {
		t.Fatalf("spawns = %d, want relaunches past %d as before this change", *spawns, before)
	}
	if !mgr.sessions["1"].watcherGaveUp {
		t.Fatal("the crash count must still reach give-up off Windows")
	}
}

// The enumerator still lists the session but the launch finds no user token:
// the failure counted for the tick is dropped and the watcher waits.
func TestWatcherNoInteractiveUserSpawnErrorIsAWait(t *testing.T) {
	buf := captureLogs(t)
	fastWatcher(t)
	windowsWaitForUser(t)
	mgr, _ := newNotInstalledManager(t)
	t.Cleanup(mgr.Shutdown)
	alive := true
	crashingAssist(t, mgr, &alive, 0)

	mgr.Apply(&Settings{Enabled: true})
	mgr.mu.Lock()
	mgr.sessions["1"].crashFailures = watcherMaxRetries - 1
	alive = false
	mgr.spawnFunc = noInteractiveUser
	mgr.mu.Unlock()
	waitWatcherDone(t, mgr)

	mgr.mu.Lock()
	st := mgr.sessions["1"]
	failures, gaveUp := st.crashFailures, st.watcherGaveUp
	mgr.mu.Unlock()
	if failures != watcherMaxRetries-1 {
		t.Fatalf("crashFailures = %d, want %d (untouched by the wait)", failures, watcherMaxRetries-1)
	}
	if gaveUp || mgr.InstallIssue() == InstallIssueCrashLoop {
		t.Fatal("no interactive user must not give up or report crash_loop")
	}
	if lines := linesContaining(buf, "watcher failed to restart breeze assist"); len(lines) != 0 {
		t.Fatalf("no interactive user is not a restart failure: %v", lines)
	}
	if waits := linesContaining(buf, waitingForUserLog); len(waits) != 1 {
		t.Fatalf("want one wait line, got %v", waits)
	}
}

// A real exit 101 with a user signed in is still a crash (#10302): the count
// rises, the watcher gives up, and crash_loop is reported.
func TestWatcherStillCountsACrashWithAUserSignedIn(t *testing.T) {
	buf := captureLogs(t)
	fastWatcher(t)
	windowsWaitForUser(t)
	mgr, _ := newNotInstalledManager(t)
	t.Cleanup(mgr.Shutdown)
	alive := true
	crashingAssist(t, mgr, &alive, 101)

	mgr.Apply(&Settings{Enabled: true})
	mgr.mu.Lock()
	alive = false
	mgr.mu.Unlock()
	waitWatcherDone(t, mgr)

	if !mgr.sessions["1"].watcherGaveUp {
		t.Fatal("a crash loop with a user signed in must still give up")
	}
	if issue := mgr.InstallIssue(); issue != InstallIssueCrashLoop {
		t.Fatalf("InstallIssue = %q, want %q", issue, InstallIssueCrashLoop)
	}
	if lines := linesContaining(buf, "exitCode=101"); len(lines) == 0 {
		t.Fatal("the restart lines must carry exit code 101")
	}
	if waits := linesContaining(buf, waitingForUserLog); len(waits) != 0 {
		t.Fatalf("a signed-in user's crash is not a wait: %v", waits)
	}
}

// The Windows spawn path (sessionbroker) reports a missing user token as
// sessionbroker.ErrNoInteractiveUser; the manager must read it as a wait.
func TestErrNoActiveSessionIsTheBrokerError(t *testing.T) {
	wrapped := fmt.Errorf("spawn: %w", sessionbroker.ErrNoInteractiveUser)
	if !errors.Is(wrapped, ErrNoActiveSession) {
		t.Fatal("sessionbroker.ErrNoInteractiveUser must match helper.ErrNoActiveSession")
	}
}
