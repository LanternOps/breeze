package main

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/backupipc"
)

// Every operator-facing degradation signal the backup path emits travels in ONE
// field: BackupJob.Warning (`warning` on the wire). appendWarning in
// internal/backup/backup.go joins them with "; " — the live-volume read note
// (#3025/#3027), the uncaptured-system-state-artifacts note (#3029), the
// partial-upload summary, the system-state-not-collected note. The server
// persists that string to the job's errorLog and the UI renders it; nothing
// else carries them.
//
// So the bounding tiers in result_bounds.go have a hard invariant: they may
// TRUNCATE the warning (the IPC frame is real and must be respected) and they
// may APPEND their own notes to it, but no tier may REPLACE it. A tier that
// replaces it converts "this restore point is degraded, here is how" into a
// clean-looking result, and it does so on exactly the runs most likely to be
// degraded — the big ones that reach the tiers at all.
//
// These tests drive a warning-carrying result through each tier and assert the
// operator signal is still there on the other side.

// operatorWarning is a stand-in for the real signals: the live-volume read note
// plus the uncaptured-artifacts note, joined the way appendWarning joins them.
const operatorWarning = "read from the live volume, not the VSS shadow copy: C:\\ProgramData\\breeze; " +
	"system state artifacts were not captured: the manifest described 7 artifacts but none reached the snapshot"

// fittedWarning runs a result through the real bounding logic and returns the
// warning the server would end up reading, plus the degradation note naming the
// tier that fired.
func fittedWarning(t *testing.T, in backupipc.BackupCommandResult) (warning string, degraded string) {
	t.Helper()
	fitted, degraded := fitBackupResultToIPC(in)
	if got := payloadSize(t, fitted); got > resultPayloadBudget {
		t.Fatalf("fitted payload is %d bytes, over the %d budget", got, resultPayloadBudget)
	}
	var out struct {
		Warning string `json:"warning"`
	}
	if err := json.Unmarshal([]byte(fitted.Stdout), &out); err != nil {
		t.Fatalf("fitted stdout is not valid JSON: %v", err)
	}
	return out.Warning, degraded
}

// TestTier2PreservesOperatorWarning is the regression guard for the tier that
// actually fires in the field (the #3001 field report: 123k files, snapshot
// index emptied). It should already pass — it pins the behaviour the other
// tiers are being brought in line with.
func TestTier2PreservesOperatorWarning(t *testing.T) {
	job := buildLargeRunJob(oversizeFileCount, fieldReportErrorCount)
	job.Warning = operatorWarning
	stdout, err := json.Marshal(job)
	if err != nil {
		t.Fatalf("marshal job: %v", err)
	}

	warning, degraded := fittedWarning(t, backupipc.BackupCommandResult{
		CommandID: "cmd-tier2-warning",
		Success:   true,
		Stdout:    string(stdout),
	})

	if !strings.Contains(degraded, "snapshot file index dropped") {
		t.Fatalf("expected tier 2 to be the tier that fired, got %q", degraded)
	}
	if !strings.Contains(warning, "read from the live volume") {
		t.Errorf("tier 2 lost the live-volume signal; warning = %.300q", warning)
	}
	if !strings.Contains(warning, "system state artifacts were not captured") {
		t.Errorf("tier 2 lost the uncaptured-artifacts signal; warning = %.300q", warning)
	}
	if !strings.Contains(warning, "snapshot file index omitted") {
		t.Errorf("tier 2 dropped its own degradation note; warning = %.300q", warning)
	}
}

// tier3Stdout builds a body that survives tier 2 but not its budget, so tier 3
// is the tier that fires:
//   - `blob` is a top-level SCALAR string, so dropBulkFields leaves it alone
//     (it only drops containers) and tier 2 stays over budget;
//   - `smallDetail` is a container UNDER bulkFieldThreshold, so tier 2 keeps it
//     too and tier 3 is the tier that drops it — which is what makes tier 3
//     append its "detail field(s) omitted" note.
//
// The warning arrives already at the tier-2 cap, which is the normal state of
// affairs by the time tier 3 runs: boundObjectWarning clamps it to
// maxResultTextBytes on the way through.
func tier3Stdout(t *testing.T) string {
	t.Helper()
	body := map[string]any{
		"id":            "job-tier3",
		"status":        "completed",
		"filesBackedUp": 42,
		"warning":       operatorWarning + "; " + strings.Repeat("filler ", maxResultTextBytes/7),
		"smallDetail":   []string{"a", "b", "c"},
		"blob":          strings.Repeat("z", 20<<20),
	}
	data, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal tier-3 body: %v", err)
	}
	return string(data)
}

// TestTier3KeepsItsOwnDegradationNote pins that tier 3's record of what it
// dropped survives its own clamp. reduceToScalars appends
// "detail field(s) omitted (…)" to the warning and only THEN clamps every
// retained string to maxResultTextBytes — and truncateText keeps the HEAD, so
// the note it just appended at the tail is the first thing cut whenever the
// warning is already at the cap (which tier 2 guarantees it is). The server
// then records a truncated warning with no indication that a detail field was
// dropped at all.
func TestTier3KeepsItsOwnDegradationNote(t *testing.T) {
	warning, degraded := fittedWarning(t, backupipc.BackupCommandResult{
		CommandID: "cmd-tier3-warning",
		Success:   true,
		Stdout:    tier3Stdout(t),
	})

	if !strings.Contains(degraded, "reduced to summary scalars") {
		t.Fatalf("expected tier 3 to be the tier that fired, got %q", degraded)
	}
	if !strings.Contains(warning, "read from the live volume") {
		t.Errorf("tier 3 lost the live-volume signal; warning = %.300q", warning)
	}
	if !strings.Contains(warning, "smallDetail") {
		t.Errorf("tier 3 dropped smallDetail but its note did not survive its own clamp; warning = %.300q", warning)
	}
}

// tier4Stdout forces tier 4 the only way it can be forced: thousands of
// oversized top-level scalars. Tier 3 keeps every scalar (clamped), so a body
// with enough of them is still over budget afterwards. No body the helper
// produces today has this shape — tier 4 is a defensive tier — which is exactly
// why its behaviour has to be pinned by a test rather than by inspection.
func tier4Stdout(t *testing.T) string {
	t.Helper()
	var b strings.Builder
	b.WriteString(`{"id":"job-tier4","status":"partial","snapshotId":"snapshot-tier4"`)
	fmt.Fprintf(&b, `,"warning":%q`, operatorWarning)
	blob := strings.Repeat("z", 12*1024)
	for i := 0; i < 3000; i++ {
		fmt.Fprintf(&b, `,"note%04d":"%s"`, i, blob)
	}
	b.WriteString("}")
	return b.String()
}

// TestTier4PreservesOperatorWarning is the core assertion. lastResortStdout
// builds a fresh map from a four-key keep-list {id, jobId, status, snapshotId}
// — `warning` is not on it — and then assigns its own bounding note to
// `warning`, so whatever the run had to say about itself is overwritten rather
// than appended to. Every signal from #3025 / #3027 / #3029 dies here.
func TestTier4PreservesOperatorWarning(t *testing.T) {
	warning, degraded := fittedWarning(t, backupipc.BackupCommandResult{
		CommandID: "cmd-tier4-warning",
		Success:   true,
		Stdout:    tier4Stdout(t),
	})

	if !strings.Contains(degraded, "minimal terminal status") {
		t.Fatalf("expected tier 4 to be the tier that fired, got %q", degraded)
	}
	if !strings.Contains(warning, "read from the live volume") {
		t.Errorf("tier 4 replaced the live-volume signal instead of appending to it; warning = %.300q", warning)
	}
	if !strings.Contains(warning, "system state artifacts were not captured") {
		t.Errorf("tier 4 replaced the uncaptured-artifacts signal; warning = %.300q", warning)
	}
	// The tier still has to say what it did — a preserved warning that hides the
	// truncation would be its own kind of lie.
	if !strings.Contains(warning, "IPC limit") {
		t.Errorf("tier 4 stopped explaining itself; warning = %.300q", warning)
	}
}

// TestTier4BoundsThePreservedWarning pins that preserving the warning did not
// cost tier 4 its "always fits" postcondition: a pathological multi-megabyte
// warning must still come out bounded.
func TestTier4BoundsThePreservedWarning(t *testing.T) {
	var b strings.Builder
	b.WriteString(`{"id":"job-tier4-huge","status":"completed"`)
	fmt.Fprintf(&b, `,"warning":"%s"`, strings.Repeat("w", 4<<20))
	blob := strings.Repeat("z", 12*1024)
	for i := 0; i < 3000; i++ {
		fmt.Fprintf(&b, `,"note%04d":"%s"`, i, blob)
	}
	b.WriteString("}")

	warning, degraded := fittedWarning(t, backupipc.BackupCommandResult{
		CommandID: "cmd-tier4-huge",
		Success:   true,
		Stdout:    b.String(),
	})

	if !strings.Contains(degraded, "minimal terminal status") {
		t.Fatalf("expected tier 4 to be the tier that fired, got %q", degraded)
	}
	if len(warning) > maxResultTextBytes+512 {
		t.Errorf("tier 4 left the warning unbounded at %d bytes", len(warning))
	}
	if !strings.Contains(warning, "IPC limit") {
		t.Errorf("tier 4 stopped explaining itself; warning = %.300q", warning)
	}
}
