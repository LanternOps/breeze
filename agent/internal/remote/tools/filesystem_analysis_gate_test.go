package tools

import (
	"encoding/json"
	"os"
	"path/filepath"
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

// The command-handler entry point must go through the agent-wide gate, not
// call AnalyzeFilesystem directly.
func TestAnalyzeFilesystemCommandUsesDefaultGate(t *testing.T) {
	release, running := defaultFilesystemScanGate.tryBegin("cmd-held", time.Now())
	if running != nil {
		t.Fatalf("default gate unexpectedly held by %+v", running)
	}
	defer release()

	got := AnalyzeFilesystemCommand("cmd-new", map[string]any{"path": t.TempDir()})
	if got.ErrorCode != wire.ErrCodeScanInProgress || !strings.Contains(got.Error, "cmd-held") {
		t.Fatalf("AnalyzeFilesystemCommand bypassed the default gate: status=%q code=%q err=%q", got.Status, got.ErrorCode, got.Error)
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

// #8509: on Windows the agent runs as SYSTEM and so walked
// `System Volume Information` — the volume shadow copy diff area — on every
// baseline scan of a volume root. The walker must not descend into it.
func TestAnalyzeFilesystemSkipsSystemVolumeInformation(t *testing.T) {
	root := t.TempDir()
	svi := filepath.Join(root, "System Volume Information")
	if err := os.MkdirAll(filepath.Join(svi, "nested"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	for _, p := range []string{
		filepath.Join(svi, "{3808876b-c176-4e48-b7ae-04046e6cc752}"),
		filepath.Join(svi, "nested", "diff.bin"),
	} {
		if err := os.WriteFile(p, make([]byte, 4096), 0o644); err != nil {
			t.Fatalf("write: %v", err)
		}
	}
	if err := os.WriteFile(filepath.Join(root, "kept.txt"), make([]byte, 16), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}

	result := AnalyzeFilesystem(map[string]any{"path": root, "timeoutSeconds": 30, "workers": 2})
	if result.Status != "completed" {
		t.Fatalf("scan failed: %s", result.Error)
	}
	var response FilesystemAnalysisResponse
	if err := json.Unmarshal([]byte(result.Stdout), &response); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if response.Summary.FilesScanned != 1 || response.Summary.BytesScanned != 16 {
		t.Fatalf("System Volume Information was walked: files=%d bytes=%d (want 1 file, 16 bytes)",
			response.Summary.FilesScanned, response.Summary.BytesScanned)
	}
	if response.Summary.DirsScanned != 1 {
		t.Fatalf("expected only the root to be scanned, got dirsScanned=%d", response.Summary.DirsScanned)
	}
}

func TestIsVolumeShadowMetadataDirIsCaseInsensitive(t *testing.T) {
	for _, name := range []string{"System Volume Information", "SYSTEM VOLUME INFORMATION", "system volume information"} {
		if !isVolumeShadowMetadataDir(name) {
			t.Fatalf("%q should be skipped", name)
		}
	}
	for _, name := range []string{"System Volume", "NTDS", "SYSVOL", "$RECYCLE.BIN", "System Volume Information.bak"} {
		if isVolumeShadowMetadataDir(name) {
			t.Fatalf("%q must not be skipped", name)
		}
	}
}
