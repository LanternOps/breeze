package main

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	backupipc "github.com/breeze-rmm/agent/internal/backupipc"
)

// The `partial` terminal status (#3000) is only useful if it reaches the
// server, and the backup result payload is degraded in tiers when it exceeds
// the IPC frame (#3001 / PR #3004). A `partial` status that degraded into
// something else would be WORSE than no change at all: the run would report a
// clean `completed` over an incomplete restore point, which is precisely the
// bug #3000 exists to fix.
//
// result_bounds.go preserves fields by SHAPE, not by an enumerated value list,
// so `partial` should ride through for free — but "should" is not evidence.
// These tests drive a real partial result through the real tiers.

// fitPartial runs the payload through the real bounding logic and returns the
// status the server would end up reading, plus the degradation note naming the
// tier that fired.
func fitPartial(t *testing.T, in backupipc.BackupCommandResult) (status string, degraded string, fitted backupipc.BackupCommandResult) {
	t.Helper()
	fitted, degraded = fitBackupResultToIPC(in)
	if got := payloadSize(t, fitted); got > resultPayloadBudget {
		t.Fatalf("fitted payload is %d bytes, over the %d budget", got, resultPayloadBudget)
	}
	var out struct {
		Status string `json:"status"`
	}
	if err := json.Unmarshal([]byte(fitted.Stdout), &out); err != nil {
		t.Fatalf("fitted stdout is not valid JSON: %v", err)
	}
	return out.Status, degraded, fitted
}

// Tier 1: a normal-sized partial result is not degraded at all and arrives
// verbatim, counters included.
func TestFitBackupResultPreservesPartialStatus_Undegraded(t *testing.T) {
	job := buildLargeRunJob(3, 2)
	job.Status = "partial"
	job.ErrorCount = 2

	status, degraded, fitted := fitPartial(t, mustRunResult(t, job))

	if status != "partial" {
		t.Fatalf("expected the partial status to survive untouched, got %q", status)
	}
	if degraded != "" {
		t.Fatalf("a small result must not be degraded at all, got note %q", degraded)
	}
	// Success must stay true: a partial run DID produce a restorable snapshot,
	// and heartbeat.go turns Success=false into an outer `failed` command
	// status, which the API records as a failed job.
	if !fitted.Success {
		t.Fatal("a partial run must keep Success=true — the snapshot is real")
	}
	var out struct {
		ErrorCount int `json:"errorCount"`
	}
	if err := json.Unmarshal([]byte(fitted.Stdout), &out); err != nil {
		t.Fatalf("unmarshal fitted stdout: %v", err)
	}
	if out.ErrorCount != 2 {
		t.Fatalf("expected errorCount 2 to ride along, got %d", out.ErrorCount)
	}
}

// Tiers 2-3: the real field shape — an oversize manifest that forces the
// snapshot file index to be dropped and the body reduced to scalars. The
// status and the counters must both come out the far side.
func TestFitBackupResultPreservesPartialStatus_OversizeManifest(t *testing.T) {
	job := buildLargeRunJob(oversizeFileCount, fieldReportErrorCount)
	job.Status = "partial"

	status, degraded, fitted := fitPartial(t, mustRunResult(t, job))

	if status != "partial" {
		t.Fatalf("expected partial to survive manifest degradation, got %q (tier note: %q)", status, degraded)
	}
	if degraded == "" {
		t.Fatal("an oversize manifest must have been degraded — the fixture is not exercising the tiers")
	}
	// The counters survive tiers 1-3 (they are scalars); assert it so a future
	// change that drops them alongside the manifest is caught here.
	var out struct {
		ErrorCount    int   `json:"errorCount"`
		FilesBackedUp int   `json:"filesBackedUp"`
		BytesBackedUp int64 `json:"bytesBackedUp"`
	}
	if err := json.Unmarshal([]byte(fitted.Stdout), &out); err != nil {
		t.Fatalf("unmarshal fitted stdout: %v", err)
	}
	if out.ErrorCount != fieldReportErrorCount {
		t.Errorf("expected errorCount %d to survive, got %d", fieldReportErrorCount, out.ErrorCount)
	}
	if out.FilesBackedUp != oversizeFileCount {
		t.Errorf("expected filesBackedUp %d to survive, got %d", oversizeFileCount, out.FilesBackedUp)
	}
	if out.BytesBackedUp == 0 {
		t.Error("expected bytesBackedUp to survive degradation")
	}
}

// Tier 4: the last-resort salvage. Its payload is a map[string]string built
// from the keep-list {id, jobId, status, snapshotId}, so `status` is carried by
// name — this pins that `partial` is not special-cased out of it. A body of
// thousands of oversized scalars survives tier 3 (which keeps every scalar) and
// so forces tier 4, which is otherwise unreachable.
func TestFitBackupResultPreservesPartialStatus_LastResort(t *testing.T) {
	var b strings.Builder
	b.WriteString(`{"id":"job-partial-1","status":"partial","snapshotId":"snapshot-partial-1"`)
	blob := strings.Repeat("z", 12*1024)
	for i := 0; i < 3000; i++ {
		fmt.Fprintf(&b, `,"note%04d":"%s"`, i, blob)
	}
	b.WriteString("}")
	in := backupipc.BackupCommandResult{CommandID: "cmd-partial-lastresort", Success: true, Stdout: b.String()}

	status, degraded, fitted := fitPartial(t, in)

	if !strings.Contains(degraded, "minimal terminal status") {
		t.Fatalf("expected tier 4 to be the tier that fired, got %q", degraded)
	}
	if status != "partial" {
		t.Fatalf("tier 4 must recover the partial status verbatim, got %q", status)
	}
	var out struct {
		ID         string `json:"id"`
		SnapshotID string `json:"snapshotId"`
	}
	if err := json.Unmarshal([]byte(fitted.Stdout), &out); err != nil {
		t.Fatalf("unmarshal fitted stdout: %v", err)
	}
	if out.ID != "job-partial-1" || out.SnapshotID != "snapshot-partial-1" {
		t.Fatalf("tier 4 must still identify the run: id=%q snapshotId=%q", out.ID, out.SnapshotID)
	}
	// Tier 4 must not flip Success — the job is partial, not failed.
	if !fitted.Success {
		t.Fatal("tier 4 must not turn a partial run into a failure")
	}
}
