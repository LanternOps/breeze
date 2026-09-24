package helper

import (
	"context"
	"os"
	"testing"
	"time"
)

// #6872: a watcher whose helper binary vanished must exit on the first tick
// without counting a failure or flagging watcherGaveUp; Apply restarts one
// after the install lands.
func TestWatcherExitsOnNotInstalled(t *testing.T) {
	mgr, spawns := newNotInstalledManager(t)

	origInterval := watcherBaseInterval
	watcherBaseInterval = 10 * time.Millisecond
	t.Cleanup(func() { watcherBaseInterval = origInterval })

	state := newSessionState("1", mgr.baseDir)
	mgr.sessions["1"] = state
	w := newSessionWatcher(context.Background(), mgr, state)
	t.Cleanup(func() { w.cancel(); <-w.done })
	state.watcher = w
	go w.run()

	select {
	case <-w.done:
	case <-time.After(2 * time.Second):
		t.Fatal("watcher did not exit within 2s with the binary missing")
	}
	if *spawns != 0 {
		t.Fatalf("spawnFunc called %d times, want 0", *spawns)
	}
	if state.watcherGaveUp {
		t.Fatal("watcherGaveUp set for a not-installed helper")
	}
}

// Control: with the binary present and a spawnFunc whose process is never
// "running", the watcher still counts failures as before (regression guard).
func TestWatcherStillCountsRealFailures(t *testing.T) {
	mgr, spawns := newNotInstalledManager(t)
	if err := os.WriteFile(mgr.binaryPath, []byte("bin"), 0755); err != nil {
		t.Fatal(err)
	}
	origInterval, origCap := watcherBaseInterval, watcherBackoffCap
	watcherBaseInterval, watcherBackoffCap = 5*time.Millisecond, 5*time.Millisecond
	t.Cleanup(func() { watcherBaseInterval, watcherBackoffCap = origInterval, origCap })

	state := newSessionState("1", mgr.baseDir)
	mgr.sessions["1"] = state
	w := newSessionWatcher(context.Background(), mgr, state)
	t.Cleanup(func() { w.cancel(); <-w.done })
	go w.run()

	select {
	case <-w.done:
	case <-time.After(5 * time.Second):
		t.Fatal("watcher did not give up")
	}
	if !state.watcherGaveUp {
		t.Fatal("expected watcherGaveUp after retries with the binary present")
	}
	if *spawns != watcherMaxRetries {
		t.Fatalf("spawnFunc called %d times, want %d", *spawns, watcherMaxRetries)
	}
}
