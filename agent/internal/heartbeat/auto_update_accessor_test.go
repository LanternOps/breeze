package heartbeat

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

// TestAutoUpdateAccessorIsRaceFree drives the exact pair of production paths
// finding I3 of the wave-06 whole-branch review identified as concurrent:
// handleSetAutoUpdate (which runs on a command-worker goroutine) writing the
// auto-update gate while handleWatchdogUpgrade (which processHeartbeatResponse
// spawns as its own goroutine, from the SAME response that submitted the pool
// command) reads it. The interleaving is one heartbeat wide.
//
// Both ends are real seams, not hand-rolled field access:
//
//	writer — handleSetAutoUpdate, the set_auto_update command handler.
//	reader — handleWatchdogUpgrade, whose FIRST action is the auto-update read.
//	         The target is deliberately older than the running agent, so the
//	         version guard immediately after the read refuses it and the
//	         function returns before any download, dedupe or installer call.
//
// Coverage claim, stated precisely (same honesty as
// TestRequireManifestSigningKeyIDAccessorIsRaceFree): reverting
// handleWatchdogUpgrade's read, handleSetAutoUpdate's write, or either
// accessor's lock makes this fail under -race. The other reader
// (processHeartbeatResponse's upgrade branch) and the other two writers
// (applyDevUpdateAutoUpdatePolicy, doUpgrade's read-only-filesystem branch) go
// through the SAME two accessors, so their conversion is mechanical and
// grep-verifiable (`grep -rn 'h.config.AutoUpdate' agent/internal --include='*.go'
// | grep -v _test.go` must match only the two accessor bodies) rather than
// separately driven here — driving
// doUpgrade would mean standing up the whole updater pipeline.
//
// handleSetAutoUpdate's config.SetAndPersist will fail in a test environment
// with no bound config file; that is expected and already tolerated by
// handlers_autoupdate_test.go. The in-memory write under h.mu is the part
// under test.
func TestAutoUpdateAccessorIsRaceFree(t *testing.T) {
	h := &Heartbeat{
		config:       &config.Config{AutoUpdate: true},
		agentVersion: "9.9.9",
	}

	const iterations = 200
	done := make(chan struct{}, 2)

	go func() {
		defer func() { done <- struct{}{} }()
		for i := 0; i < iterations; i++ {
			handleSetAutoUpdate(h, Command{
				Type:    tools.CmdSetAutoUpdate,
				Payload: map[string]any{"enabled": i%2 == 0},
			})
		}
	}()

	go func() {
		defer func() { done <- struct{}{} }()
		for i := 0; i < iterations; i++ {
			// "0.0.1" < agentVersion "9.9.9": refused by watchdogUpgradeDecision
			// on the line after the auto-update read, so nothing downloads.
			h.handleWatchdogUpgrade("0.0.1")
			_ = h.autoUpdate()
		}
	}()

	<-done
	<-done
}

// The accessors are a plain read/write pair; assert that explicitly so a future
// refactor cannot quietly turn setAutoUpdate into a no-op while the race probe
// above stays green (it never asserts a value).
func TestAutoUpdateAccessorRoundTrips(t *testing.T) {
	h := &Heartbeat{config: &config.Config{AutoUpdate: false}}

	if h.autoUpdate() {
		t.Fatal("autoUpdate() = true for a zero-value config, want false")
	}
	h.setAutoUpdate(true)
	if !h.autoUpdate() {
		t.Fatal("autoUpdate() = false after setAutoUpdate(true)")
	}
	if !h.config.AutoUpdate {
		t.Fatal("setAutoUpdate(true) did not reach h.config.AutoUpdate")
	}
	h.setAutoUpdate(false)
	if h.autoUpdate() {
		t.Fatal("autoUpdate() = true after setAutoUpdate(false)")
	}
}
