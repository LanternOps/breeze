package helper

import (
	"bytes"
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/logging"
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

// #8138: agent logs ship to the server at warn and above by default, so a
// watcher restart logged at info never left the device. A restart means the
// helper exited unexpectedly (there is no Exit menu item any more), so it
// must be a WARN for crash loops to be visible in diagnostic logs.
func TestWatcherRestartIsLoggedAsWarn(t *testing.T) {
	var buf bytes.Buffer
	logging.Init("text", "debug", &buf)
	t.Cleanup(func() { logging.Init("text", "info", nil) })

	mgr, _ := newNotInstalledManager(t)
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

	var restartLine string
	for _, line := range strings.Split(buf.String(), "\n") {
		if strings.Contains(line, "breeze assist restarted by watcher") {
			restartLine = line
			break
		}
	}
	if restartLine == "" {
		t.Fatalf("no restart log line in:\n%s", buf.String())
	}
	if !strings.Contains(restartLine, "level=WARN") {
		t.Fatalf("restart logged below warn (not shipped to the server): %s", restartLine)
	}
}
