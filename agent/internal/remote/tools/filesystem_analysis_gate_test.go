package tools

import (
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/wire"
)

// #8509: two overlapping filesystem_analysis commands each started a full
// worker pool against the same volume. The second must be refused while the
// first runs, naming the running command, instead of starting another walker.
func TestFilesystemScanGateRefusesConcurrentScan(t *testing.T) {
	gate := &filesystemScanGate{}
	entered := make(chan struct{})
	unblock := make(chan struct{})
	firstDone := make(chan CommandResult, 1)

	blockingScan := func(map[string]any) CommandResult {
		close(entered)
		<-unblock
		return CommandResult{Status: "completed"}
	}

	go func() {
		firstDone <- runGatedFilesystemAnalysis(gate, "cmd-first", map[string]any{"path": "/"}, blockingScan)
	}()
	<-entered

	secondCalled := false
	second := runGatedFilesystemAnalysis(gate, "cmd-second", map[string]any{"path": "/"}, func(map[string]any) CommandResult {
		secondCalled = true
		return CommandResult{Status: "completed"}
	})

	if secondCalled {
		t.Fatal("second scan started a walker while the first was still running")
	}
	if second.Status != "failed" {
		t.Fatalf("second scan status = %q, want failed", second.Status)
	}
	if second.ErrorCode != wire.ErrCodeScanInProgress {
		t.Fatalf("second scan errorCode = %q, want %q", second.ErrorCode, wire.ErrCodeScanInProgress)
	}
	if !strings.Contains(second.Error, "cmd-first") {
		t.Fatalf("refusal should name the running command id, got %q", second.Error)
	}
	if !strings.Contains(second.Error, "running for") {
		t.Fatalf("refusal should state the running scan's elapsed time, got %q", second.Error)
	}

	close(unblock)
	if first := <-firstDone; first.Status != "completed" {
		t.Fatalf("first scan status = %q, want completed", first.Status)
	}

	// The slot is released once the first scan returns.
	third := runGatedFilesystemAnalysis(gate, "cmd-third", map[string]any{"path": "/"}, func(map[string]any) CommandResult {
		return CommandResult{Status: "completed"}
	})
	if third.Status != "completed" {
		t.Fatalf("scan after release status = %q (%s), want completed", third.Status, third.Error)
	}
}

// A walker that panics must not wedge the gate shut for the agent's lifetime.
func TestFilesystemScanGateReleasesOnPanic(t *testing.T) {
	gate := &filesystemScanGate{}
	func() {
		defer func() { _ = recover() }()
		runGatedFilesystemAnalysis(gate, "cmd-panics", nil, func(map[string]any) CommandResult {
			panic("boom")
		})
	}()

	got := runGatedFilesystemAnalysis(gate, "cmd-after", nil, func(map[string]any) CommandResult {
		return CommandResult{Status: "completed"}
	})
	if got.Status != "completed" {
		t.Fatalf("scan after a panicking scan status = %q (%s), want completed", got.Status, got.Error)
	}
}

func TestFilesystemScanGateReportsElapsed(t *testing.T) {
	gate := &filesystemScanGate{}
	start := time.Now().Add(-95 * time.Second)
	release, running := gate.tryBegin("cmd-old", start)
	if running != nil {
		t.Fatalf("empty gate reported a running scan: %+v", running)
	}
	defer release()

	_, running = gate.tryBegin("cmd-new", time.Now())
	if running == nil || running.CommandID != "cmd-old" {
		t.Fatalf("expected cmd-old to be reported as running, got %+v", running)
	}
	err := scanInProgressError(running, time.Now())
	if !strings.Contains(err.Error(), "running for 1m35s") {
		t.Fatalf("elapsed not reported in whole seconds: %q", err.Error())
	}
}
