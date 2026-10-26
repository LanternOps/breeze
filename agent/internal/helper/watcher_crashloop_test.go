package helper

import (
	"bytes"
	"errors"
	"os"
	"strings"
	"testing"
	"time"
)

// #10183: the watcher records how Assist exited, reports crash_loop once it
// gives up, and retries after watcherGiveUpRetry or on a new Assist version
// instead of never.

// fakeExitProbe is one watched Assist process. It reports an exit once *alive
// turns false.
type fakeExitProbe struct {
	alive  *bool
	code   uint32
	closed bool
}

func (p *fakeExitProbe) exitCode() (uint32, bool, error) {
	if *p.alive {
		return 0, false, nil
	}
	return p.code, true, nil
}

func (p *fakeExitProbe) close() { p.closed = true }

// crashingAssist wires mgr so Assist "runs" as PID 777 while *alive and every
// spawn reports PID 777. With *alive false each spawned process is dead at
// once (a crash loop). Exit probes open only on a live PID, as on Windows.
// *alive must only be changed with mgr.mu held: the watcher reads it.
func crashingAssist(t *testing.T, mgr *Manager, alive *bool, code uint32) (*[]*fakeExitProbe, *int) {
	t.Helper()
	if err := os.WriteFile(mgr.binaryPath, []byte("bin"), 0o755); err != nil {
		t.Fatal(err)
	}
	origList, origOpen := listHelperInstancesFunc, openExitProbeFunc
	t.Cleanup(func() { listHelperInstancesFunc, openExitProbeFunc = origList, origOpen })
	listHelperInstancesFunc = func(string) ([]helperInstance, error) {
		if !*alive {
			return nil, nil
		}
		return []helperInstance{{PID: 777, SessionKey: "1"}}, nil
	}
	probes := &[]*fakeExitProbe{}
	openExitProbeFunc = func(pid int, _ string) (exitProbe, error) {
		if pid != 777 || !*alive {
			return nil, errors.New("no such process")
		}
		p := &fakeExitProbe{alive: alive, code: code}
		*probes = append(*probes, p)
		return p, nil
	}
	mgr.isOurProcessFunc = func(pid int, _ string) bool { return pid == 777 && *alive }
	mgr.stopIfOursFunc = func(int, string) (bool, error) { return false, nil }
	spawns := 0
	mgr.spawnFunc = func(string, string, ...string) (int, error) {
		spawns++
		return 777, nil
	}
	return probes, &spawns
}

func fastWatcher(t *testing.T) {
	t.Helper()
	origInterval, origCap := watcherBaseInterval, watcherBackoffCap
	watcherBaseInterval, watcherBackoffCap = 5*time.Millisecond, 5*time.Millisecond
	t.Cleanup(func() { watcherBaseInterval, watcherBackoffCap = origInterval, origCap })
}

// waitWatcherDone waits for session "1"'s watcher to exit on its own.
func waitWatcherDone(t *testing.T, mgr *Manager) {
	t.Helper()
	mgr.mu.Lock()
	var w *watcher
	if st := mgr.sessions["1"]; st != nil {
		w = st.watcher
	}
	mgr.mu.Unlock()
	if w == nil {
		t.Fatal("no watcher for session 1")
	}
	select {
	case <-w.done:
	case <-time.After(5 * time.Second):
		t.Fatal("watcher did not give up")
	}
}

func linesContaining(buf *bytes.Buffer, s string) []string {
	var out []string
	for _, line := range strings.Split(buf.String(), "\n") {
		if strings.Contains(line, s) {
			out = append(out, line)
		}
	}
	return out
}

// Every watcher restart names how Assist exited.
func TestWatcherLogsExitCode(t *testing.T) {
	buf := captureLogs(t)
	fastWatcher(t)
	mgr, _ := newNotInstalledManager(t)
	t.Cleanup(mgr.Shutdown)
	alive := true
	probes, _ := crashingAssist(t, mgr, &alive, 101) // a Rust panic

	mgr.Apply(&Settings{Enabled: true}) // spawns PID 777 and starts watching its exit
	mgr.mu.Lock()
	opened := len(*probes)
	alive = false // Assist crashes; every later spawn dies at once too
	mgr.mu.Unlock()
	if opened != 1 {
		t.Fatalf("exit probes opened after spawn = %d, want 1", opened)
	}
	waitWatcherDone(t, mgr)

	restarts := linesContaining(buf, "breeze assist restarted by watcher")
	if len(restarts) < 2 {
		t.Fatalf("want several restart lines, got:\n%s", buf.String())
	}
	if !strings.Contains(restarts[0], "exitCode=101") || !strings.Contains(restarts[0], "level=WARN") {
		t.Fatalf("first restart must be a WARN carrying the exit code: %s", restarts[0])
	}
	if !strings.Contains(restarts[len(restarts)-1], "exitCode=unknown") {
		t.Fatalf("a restart with no exit observed must say so: %s", restarts[len(restarts)-1])
	}
	giveUp := linesContaining(buf, "breeze assist keeps crashing, giving up")
	if len(giveUp) != 1 || !strings.Contains(giveUp[0], "level=ERROR") || !strings.Contains(giveUp[0], "lastExitCode=101") {
		t.Fatalf("give-up line must stay one ERROR carrying the last known exit code: %v", giveUp)
	}
	if !strings.Contains(giveUp[0], "retryAfter=6h0m0s") {
		t.Fatalf("give-up line must say when it retries: %s", giveUp[0])
	}
	mgr.mu.Lock()
	closed := (*probes)[0].closed
	mgr.mu.Unlock()
	if !closed {
		t.Fatal("exit probe handle leaked after its exit was read")
	}
}

func TestExitCodeField(t *testing.T) {
	cases := []struct {
		exit  assistExit
		known bool
		want  string
	}{
		{assistExit{Code: 0}, true, "0"},
		{assistExit{Code: 101}, true, "101"},
		{assistExit{Code: 0xC0000409}, true, "0xC0000409"},
		{assistExit{}, false, "unknown"},
	}
	for _, tc := range cases {
		if got := exitCodeField(tc.exit, tc.known); got != tc.want {
			t.Fatalf("exitCodeField(%v, %v) = %q, want %q", tc.exit, tc.known, got, tc.want)
		}
	}
}

func TestWatcherGiveUpReportsCrashLoop(t *testing.T) {
	fastWatcher(t)
	mgr, _ := newNotInstalledManager(t)
	t.Cleanup(mgr.Shutdown)
	clock := time.Date(2026, 10, 26, 6, 0, 0, 0, time.UTC)
	mgr.now = func() time.Time { return clock }
	alive := false
	_, spawns := crashingAssist(t, mgr, &alive, 0)

	mgr.Apply(&Settings{Enabled: true})
	waitWatcherDone(t, mgr)

	// Apply's spawn plus one per watcher restart; the sixth failure gives up.
	if want := 1 + watcherMaxRetries; *spawns != want {
		t.Fatalf("spawned %d times before giving up, want %d", *spawns, want)
	}
	if got := mgr.InstallIssue(); got != InstallIssueCrashLoop {
		t.Fatalf("InstallIssue() after the watcher gave up = %q, want %q", got, InstallIssueCrashLoop)
	}
	mgr.mu.Lock()
	gaveUpAt := mgr.sessions["1"].gaveUpAt
	mgr.mu.Unlock()
	if !gaveUpAt.Equal(clock) {
		t.Fatalf("gaveUpAt = %v, want the manager clock %v", gaveUpAt, clock)
	}
	// Still reported on the next heartbeat (the server writes only on change).
	mgr.Apply(&Settings{Enabled: true})
	if got := mgr.InstallIssue(); got != InstallIssueCrashLoop {
		t.Fatalf("InstallIssue() on the next heartbeat = %q, want %q", got, InstallIssueCrashLoop)
	}
}

// givenUpSession puts session "1" in the watcher's give-up state.
func givenUpSession(mgr *Manager, at time.Time, version string) *sessionState {
	state := newSessionState("1", mgr.baseDir)
	state.watcherGaveUp = true
	state.gaveUpAt = at
	state.gaveUpVersion = version
	mgr.sessions["1"] = state
	return state
}

func TestWatcherRetriesAfterSixHours(t *testing.T) {
	// The watcher the retry starts must not race the spawn count. Registered
	// first, so the interval is restored only after Shutdown joins it.
	slowWatcher(t)
	mgr, _ := newNotInstalledManager(t)
	t.Cleanup(mgr.Shutdown)
	alive := false
	_, spawns := crashingAssist(t, mgr, &alive, 0)
	gaveUp := time.Date(2026, 10, 26, 6, 0, 0, 0, time.UTC)
	clock := gaveUp.Add(watcherGiveUpRetry - time.Minute)
	mgr.now = func() time.Time { return clock }
	givenUpSession(mgr, gaveUp, "")

	mgr.Apply(&Settings{Enabled: true})
	if *spawns != 0 {
		t.Fatalf("spawned %d times at 5h59m, want 0", *spawns)
	}
	if got := mgr.InstallIssue(); got != InstallIssueCrashLoop {
		t.Fatalf("InstallIssue() inside the backoff = %q, want %q", got, InstallIssueCrashLoop)
	}

	clock = gaveUp.Add(watcherGiveUpRetry)
	mgr.Apply(&Settings{Enabled: true})
	if *spawns != 1 {
		t.Fatalf("spawned %d times at 6h, want exactly 1", *spawns)
	}
	if got := mgr.InstallIssue(); got != "" {
		t.Fatalf("InstallIssue() while retrying = %q, want empty", got)
	}
}

func TestWatcherRetriesOnAssistVersionChange(t *testing.T) {
	for _, tc := range []struct {
		name      string
		installed string
		spawns    int
	}{
		{"same version stays given up", "0.124.0", 0},
		{"new version retries", "0.125.0", 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			slowWatcher(t) // registered first: restored only after Shutdown joins the watcher
			mgr, _ := newNotInstalledManager(t)
			t.Cleanup(mgr.Shutdown)
			alive := false
			_, spawns := crashingAssist(t, mgr, &alive, 0)
			clock := time.Date(2026, 10, 26, 6, 0, 0, 0, time.UTC)
			mgr.now = func() time.Time { return clock }
			mgr.binaryVersionFunc = func(string) (string, error) { return tc.installed, nil }
			givenUpSession(mgr, clock, "0.124.0")

			mgr.Apply(&Settings{Enabled: true})

			if *spawns != tc.spawns {
				t.Fatalf("spawned %d times, want %d", *spawns, tc.spawns)
			}
		})
	}
}

// A deliberate stop (config reload, update, deploy off) is not a crash: its
// exit must never be reported against the next restart.
func TestDeliberateStopDropsExitProbes(t *testing.T) {
	mgr, _ := newNotInstalledManager(t)
	t.Cleanup(mgr.Shutdown)
	alive := true
	probes, _ := crashingAssist(t, mgr, &alive, 1)
	mgr.Apply(&Settings{Enabled: true})

	mgr.mu.Lock()
	defer mgr.mu.Unlock()
	if len(*probes) != 1 {
		t.Fatalf("exit probes opened = %d, want 1", len(*probes))
	}
	state := mgr.sessions["1"]
	mgr.stopSessionWatcher(state)
	if err := mgr.ensureStoppedSession(state); err != nil {
		t.Fatal(err)
	}
	alive = false
	if _, known := mgr.takeAssistExitLocked(state); known {
		t.Fatal("an exit caused by the agent's own stop was reported as a crash")
	}
	if !(*probes)[0].closed {
		t.Fatal("ensureStoppedSession leaked the exit probe")
	}
}
