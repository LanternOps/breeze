package helper

import (
	"context"
	"os"
	"sync"
	"testing"
	"time"
)

// #10302: a running tick reset the watcher's failure count, so an Assist that
// lived just long enough to be seen running once after each restart was
// restarted forever and crash_loop was never reported. The count now resets
// only after Assist has run for watcherHealthyUptime since its last launch.

// shortLivedAssist wires mgr so every spawn starts PID 777, which is seen
// running by exactly one liveness check and is dead from then on: a crash
// slower than the watcher's next tick. onSeenAlive runs (under mgr.mu) each
// time the process is seen running. The returned channel is closed once
// spawns reaches spawnLimit.
func shortLivedAssist(t *testing.T, mgr *Manager, spawnLimit int, onSeenAlive func()) (*int, <-chan struct{}) {
	t.Helper()
	if err := os.WriteFile(mgr.binaryPath, []byte("bin"), 0o755); err != nil {
		t.Fatal(err)
	}
	origList, origOpen := listHelperInstancesFunc, openExitProbeFunc
	t.Cleanup(func() { listHelperInstancesFunc, openExitProbeFunc = origList, origOpen })
	listHelperInstancesFunc = func(string) ([]helperInstance, error) { return nil, nil }
	openExitProbeFunc = func(int, string) (exitProbe, error) { return nil, errExitProbeUnsupported }

	// All fields below are read and written under mgr.mu (spawnFunc and
	// isOurProcessFunc are only called with it held).
	alive := false
	mgr.isOurProcessFunc = func(pid int, _ string) bool {
		if pid != 777 || !alive {
			return false
		}
		alive = false // seen once, then it crashes
		if onSeenAlive != nil {
			onSeenAlive()
		}
		return true
	}
	mgr.stopIfOursFunc = func(int, string) (bool, error) { return false, nil }
	spawns := 0
	limit := make(chan struct{})
	var once sync.Once
	mgr.spawnFunc = func(string, string, ...string) (int, error) {
		spawns++
		alive = true
		if spawns >= spawnLimit {
			once.Do(func() { close(limit) })
		}
		return 777, nil
	}
	return &spawns, limit
}

func sessionWatcherDone(t *testing.T, mgr *Manager) <-chan struct{} {
	t.Helper()
	mgr.mu.Lock()
	defer mgr.mu.Unlock()
	st := mgr.sessions["1"]
	if st == nil || st.watcher == nil {
		t.Fatal("no watcher for session 1")
	}
	return st.watcher.done
}

// The issue's second lab path: Assist lives about 2 s, so the tick after each
// restart finds it running. With the clock frozen it never reaches the
// minimum uptime, so the watcher must still give up and report crash_loop.
func TestWatcherGivesUpWhenAssistDiesAfterBeingSeenRunning(t *testing.T) {
	fastWatcher(t)
	mgr, _ := newNotInstalledManager(t)
	clock := time.Date(2026, 10, 30, 6, 0, 0, 0, time.UTC)
	mgr.now = func() time.Time { return clock } // frozen: no launch is ever healthy
	const runaway = 4 * (1 + watcherMaxRetries)
	spawns, tooMany := shortLivedAssist(t, mgr, runaway, nil)
	t.Cleanup(mgr.Shutdown) // after shortLivedAssist: joins the watcher before its hooks are restored

	mgr.Apply(&Settings{Enabled: true})
	done := sessionWatcherDone(t, mgr)

	select {
	case <-done:
	case <-tooMany:
		t.Fatalf("watcher restarted Assist %d times without giving up: a running tick reset the failure count", runaway)
	case <-time.After(10 * time.Second):
		t.Fatal("watcher neither gave up nor kept restarting")
	}

	mgr.mu.Lock()
	got := *spawns
	mgr.mu.Unlock()
	// Apply's launch plus one per watcher restart; the sixth failure gives up.
	if want := 1 + watcherMaxRetries; got != want {
		t.Fatalf("spawned %d times before giving up, want %d", got, want)
	}
	if issue := mgr.InstallIssue(); issue != InstallIssueCrashLoop {
		t.Fatalf("InstallIssue() = %q, want %q", issue, InstallIssueCrashLoop)
	}
}

// Control: the same process, but each launch is seen running only after the
// minimum uptime has passed. A crash after a sustained healthy run starts the
// count over, so the watcher never gives up.
func TestWatcherKeepsRestartingAssistThatRunsHealthyBetweenCrashes(t *testing.T) {
	fastWatcher(t)
	mgr, _ := newNotInstalledManager(t)
	clock := time.Date(2026, 10, 30, 6, 0, 0, 0, time.UTC)
	mgr.now = func() time.Time { return clock }
	const enough = 4 * (1 + watcherMaxRetries)
	_, reached := shortLivedAssist(t, mgr, enough, func() {
		clock = clock.Add(time.Hour) // a healthy run before each crash
	})
	t.Cleanup(mgr.Shutdown)

	mgr.Apply(&Settings{Enabled: true})
	done := sessionWatcherDone(t, mgr)

	select {
	case <-done:
		t.Fatal("watcher gave up on an Assist that ran healthy between crashes")
	case <-reached:
	case <-time.After(10 * time.Second):
		t.Fatal("watcher stopped restarting Assist")
	}
	mgr.mu.Lock()
	gaveUp := mgr.sessions["1"].watcherGaveUp
	mgr.mu.Unlock()
	if gaveUp {
		t.Fatal("watcherGaveUp set for an Assist that ran healthy between crashes")
	}
}

// The issue's first lab path: at failures=4 the heartbeat relaunches Assist
// outside the watcher, and the watcher's 16 s tick lands just after it. That
// relaunch must restart the uptime clock, so the tick finds a fresh launch
// and keeps the count; only a run of watcherHealthyUptime clears it.
func TestHeartbeatRelaunchDoesNotLookHealthy(t *testing.T) {
	mgr, _ := newNotInstalledManager(t)
	launched := time.Date(2026, 10, 30, 6, 0, 0, 0, time.UTC)
	clock := launched
	mgr.now = func() time.Time { return clock }
	shortLivedAssist(t, mgr, 1<<30, nil)
	state := newSessionState("1", mgr.baseDir)
	state.crashFailures = 4
	state.lastSpawnAt = launched.Add(-time.Hour) // the watcher's own last restart, long ago
	mgr.sessions["1"] = state

	mgr.mu.Lock()
	defer mgr.mu.Unlock()
	if err := mgr.ensureRunningSession(state); err != nil { // Apply's relaunch
		t.Fatal(err)
	}
	if !state.lastSpawnAt.Equal(launched) {
		t.Fatalf("lastSpawnAt = %v after the heartbeat relaunch, want %v", state.lastSpawnAt, launched)
	}

	clock = launched.Add(16 * time.Second)
	if mgr.noteAssistRunningLocked(state) || state.crashFailures != 4 {
		t.Fatalf("a tick 16s after the relaunch cleared the count (failures=%d)", state.crashFailures)
	}
	clock = launched.Add(watcherHealthyUptime - time.Nanosecond)
	if mgr.noteAssistRunningLocked(state) || state.crashFailures != 4 {
		t.Fatalf("a tick just under the minimum uptime cleared the count (failures=%d)", state.crashFailures)
	}
	clock = launched.Add(watcherHealthyUptime)
	if !mgr.noteAssistRunningLocked(state) || state.crashFailures != 0 {
		t.Fatalf("a run of watcherHealthyUptime did not clear the count (failures=%d)", state.crashFailures)
	}
}

// An Assist that was already running when the agent started has no agent
// launch time and counts as healthy.
func TestUnlaunchedAssistCountsAsHealthy(t *testing.T) {
	mgr, _ := newNotInstalledManager(t)
	mgr.now = func() time.Time { return time.Date(2026, 10, 30, 6, 0, 0, 0, time.UTC) }
	state := newSessionState("1", mgr.baseDir)
	state.crashFailures = 3
	if !mgr.noteAssistRunningLocked(state) || state.crashFailures != 0 {
		t.Fatalf("an Assist with no agent launch time kept failures=%d", state.crashFailures)
	}
}

// The count now outlives the watcher goroutine, so a give-up must clear it:
// otherwise the retry after watcherGiveUpRetry would give up on its first
// crash instead of getting watcherMaxRetries restarts again.
func TestCrashLoopRetryGetsAFreshCount(t *testing.T) {
	fastWatcher(t)
	mgr, _ := newNotInstalledManager(t)
	clock := time.Date(2026, 10, 30, 6, 0, 0, 0, time.UTC)
	mgr.now = func() time.Time { return clock }
	spawns, _ := shortLivedAssist(t, mgr, 1<<30, nil)
	t.Cleanup(mgr.Shutdown)
	perRound := 1 + watcherMaxRetries

	mgr.Apply(&Settings{Enabled: true})
	waitWatcherDone(t, mgr)
	mgr.mu.Lock()
	first, left := *spawns, mgr.sessions["1"].crashFailures
	clock = clock.Add(watcherGiveUpRetry) // the six-hour retry is due
	mgr.mu.Unlock()
	if first != perRound || left != 0 {
		t.Fatalf("first round: spawns=%d crashFailures=%d, want %d and 0", first, left, perRound)
	}

	mgr.Apply(&Settings{Enabled: true})
	waitWatcherDone(t, mgr)
	mgr.mu.Lock()
	total := *spawns
	mgr.mu.Unlock()
	if total != 2*perRound {
		t.Fatalf("retry round spawned %d times, want %d (a full set of restarts)", total-first, perRound)
	}
	if issue := mgr.InstallIssue(); issue != InstallIssueCrashLoop {
		t.Fatalf("InstallIssue() after the retry gave up = %q, want %q", issue, InstallIssueCrashLoop)
	}
}

// #6872 path: a watcher that exits because Assist is not installed drops the
// failure it just counted, as the goroutine-local count used to.
func TestNotInstalledWatcherExitClearsCount(t *testing.T) {
	mgr, _ := newNotInstalledManager(t) // binary never written
	fastWatcher(t)
	state := newSessionState("1", mgr.baseDir)
	state.crashFailures = 3
	mgr.sessions["1"] = state
	w := newSessionWatcher(context.Background(), mgr, state)
	t.Cleanup(func() { w.cancel(); <-w.done })
	go w.run()

	select {
	case <-w.done:
	case <-time.After(5 * time.Second):
		t.Fatal("watcher did not exit with the binary missing")
	}
	mgr.mu.Lock()
	defer mgr.mu.Unlock()
	if state.crashFailures != 0 || state.watcherGaveUp {
		t.Fatalf("after a not-installed exit: crashFailures=%d watcherGaveUp=%v, want 0 and false",
			state.crashFailures, state.watcherGaveUp)
	}
}

// A rollback restart is a deliberate stop, not a crash: it starts the count
// over along with leaving the give-up state.
func TestRollbackRestartClearsCount(t *testing.T) {
	slowWatcher(t) // registered first: restored only after Shutdown joins the watcher
	mgr, _ := newNotInstalledManager(t)
	mgr.now = func() time.Time { return time.Date(2026, 10, 30, 6, 0, 0, 0, time.UTC) }
	shortLivedAssist(t, mgr, 1<<30, nil)
	t.Cleanup(mgr.Shutdown)
	state := newSessionState("1", mgr.baseDir)
	state.crashFailures = 5
	state.watcherGaveUp = true
	mgr.sessions["1"] = state

	mgr.mu.Lock()
	mgr.restartSessionsLocked([]*sessionState{state})
	failures, gaveUp := state.crashFailures, state.watcherGaveUp
	mgr.mu.Unlock()
	if failures != 0 || gaveUp {
		t.Fatalf("after a rollback restart: crashFailures=%d watcherGaveUp=%v, want 0 and false", failures, gaveUp)
	}
}
