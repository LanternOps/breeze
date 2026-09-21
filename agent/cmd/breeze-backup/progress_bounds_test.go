package main

import (
	"encoding/json"
	"fmt"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup/bmr"
	"github.com/breeze-rmm/agent/internal/backup/rebuild"
)

// TestBoundProgressUpdate_TypedResultWithMassFailureStaysUnderBodyLimit is
// the regression test for review finding #2 (w09-part0.md R18, Global
// Constraint "Bounded reporting"). A restore that fails ~98,411 files
// produces a *rebuild.Result carrying a per-file warning for EACH one
// (restore.go appends a warning per failed placement, restore_tree.go
// forwards res.Warnings verbatim into r.warnings with no cap) — only
// FailedFilesSample is capped at construction (restore_tree.go's own
// maxFailedFilesSample=50); Warnings is not. Before the fix,
// bmr.BoundProgressUpdate's boundedFailures handling only trimmed
// FailedFilesSample (already <=50, so the trim never even fired) and never
// touched Result.Warnings, so the marshalled body blew past the 768 KiB
// cap and the last-resort fallback — which only reads from a
// map[string]any — produced a bare {"status","truncated":true}, losing
// filesFailed and the failed-file sample entirely. This drives the REAL
// production type (*rebuild.Result) through the REAL production function
// (bmr.BoundProgressUpdate), exactly as PostRecoveryProgress does.
func TestBoundProgressUpdate_TypedResultWithMassFailureStaysUnderBodyLimit(t *testing.T) {
	const n = 98411
	warnings := make([]string, n)
	sample := make([]string, 50)
	for i := 0; i < n; i++ {
		warnings[i] = fmt.Sprintf("could not restore /src/file-%d: permission denied", i)
	}
	for i := 0; i < 50; i++ {
		sample[i] = fmt.Sprintf("/src/file-%d", i)
	}

	res := &rebuild.Result{
		SnapshotID:         "snap-1",
		Status:             "failed",
		PhaseReached:       rebuild.PhaseRestore,
		Warnings:           warnings,
		FilesFailed:        n,
		FailedFilesSample:  sample,
		FailedFilesOmitted: n - 50,
		Error:              "restore files: too many failures",
	}

	u := bmr.ProgressUpdate{Status: "failed", Result: res}
	bounded := bmr.BoundProgressUpdate(u)

	body, err := json.Marshal(bounded)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if len(body) >= 768*1024 {
		t.Fatalf("serialized body = %d bytes, want < 768 KiB", len(body))
	}

	// The bounded result must still surface filesFailed and a sample of
	// failed files to the server — not degrade into a bare
	// {"status","truncated":true} that loses the failure detail entirely.
	var decoded struct {
		Result struct {
			FilesFailed       int      `json:"filesFailed"`
			FailedFilesSample []string `json:"failedFilesSample"`
			Truncated         bool     `json:"truncated"`
		} `json:"result"`
	}
	if err := json.Unmarshal(body, &decoded); err != nil {
		t.Fatalf("unmarshal bounded body: %v", err)
	}
	if decoded.Result.FilesFailed != n {
		t.Errorf("result.filesFailed = %d, want %d (lost on the fallback path)", decoded.Result.FilesFailed, n)
	}
	if len(decoded.Result.FailedFilesSample) == 0 {
		t.Error("result.failedFilesSample is empty, want the 50-entry sample preserved")
	}
	if decoded.Result.Truncated {
		t.Error("result.truncated = true: fell back to the minimal summary even though warnings/failed-files were bounded — the fix should keep the full typed result under the body limit")
	}

	// Original u/res must never be mutated.
	if len(res.Warnings) != n {
		t.Fatalf("BoundProgressUpdate mutated the caller's *rebuild.Result: len(Warnings) = %d, want %d", len(res.Warnings), n)
	}
}
