package backup

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func TestClassifyCompletionStatus(t *testing.T) {
	tests := []struct {
		name           string
		protectedBytes int64
		scannedBytes   int64
		failedFiles    int
		attemptedFiles int
		want           string
	}{
		{
			name:           "clean run is completed",
			protectedBytes: 3_200_000,
			scannedBytes:   3_200_000,
			failedFiles:    0,
			attemptedFiles: 22,
			want:           jobStatusCompleted,
		},
		{
			// The deliberate existing design: a handful of failures out of a
			// large run is a warning, not a status change. This is the second
			// field case from #3000 (errorCount 317 of 123,600 files).
			name:           "field case 317 of 123600 stays completed",
			protectedBytes: 99_500_000,
			scannedBytes:   100_000_000,
			failedFiles:    317,
			attemptedFiles: 123_600,
			want:           jobStatusCompleted,
		},
		{
			// The headline field case from #3000: 21 of 22 files failed and
			// 85 bytes of 3.2 MB were stored, yet the job landed green.
			name:           "field case 21 of 22 files is partial",
			protectedBytes: 85,
			scannedBytes:   3_200_000,
			failedFiles:    21,
			attemptedFiles: 22,
			want:           jobStatusPartial,
		},
		{
			// Bytes are the primary denominator: one huge failed file matters
			// more than a hundred tiny ones. Only 1 of 100 files failed (well
			// under the file-count gate) but it carried 90% of the bytes.
			name:           "one huge failed file trips the byte gate alone",
			protectedBytes: 10_000_000,
			scannedBytes:   100_000_000,
			failedFiles:    1,
			attemptedFiles: 100,
			want:           jobStatusPartial,
		},
		{
			// The converse: the file-count gate catches a run whose byte
			// ratio is uninformative. Scan-failed files have no known size
			// (os.Stat itself failed) so they contribute nothing to
			// scannedBytes — without this gate they would be invisible.
			name:           "many zero-byte scan failures trip the file gate alone",
			protectedBytes: 1_000_000,
			scannedBytes:   1_000_000,
			failedFiles:    50,
			attemptedFiles: 100,
			want:           jobStatusPartial,
		},
		{
			// Boundary: exactly at the threshold is NOT a downgrade. The
			// comparison is strictly-greater-than so a round 10% run keeps
			// the status it has today.
			name:           "exactly at the byte threshold stays completed",
			protectedBytes: 900,
			scannedBytes:   1000,
			failedFiles:    1,
			attemptedFiles: 1000,
			want:           jobStatusCompleted,
		},
		{
			name:           "one byte past the byte threshold is partial",
			protectedBytes: 899,
			scannedBytes:   1000,
			failedFiles:    1,
			attemptedFiles: 1000,
			want:           jobStatusPartial,
		},
		{
			name:           "exactly at the file threshold stays completed",
			protectedBytes: 1000,
			scannedBytes:   1000,
			failedFiles:    10,
			attemptedFiles: 100,
			want:           jobStatusCompleted,
		},
		{
			name:           "one file past the file threshold is partial",
			protectedBytes: 1000,
			scannedBytes:   1000,
			failedFiles:    11,
			attemptedFiles: 100,
			want:           jobStatusPartial,
		},
		{
			// Zero failures short-circuits regardless of the byte arithmetic.
			// A dedupe/reference run can legitimately protect fewer bytes than
			// were scanned in edge cases; with no recorded failure there is
			// nothing to be proportional about and the run is clean.
			name:           "no failures is completed even if bytes look short",
			protectedBytes: 0,
			scannedBytes:   1_000_000,
			failedFiles:    0,
			attemptedFiles: 10,
			want:           jobStatusCompleted,
		},
		{
			name:           "zero denominators do not divide by zero",
			protectedBytes: 0,
			scannedBytes:   0,
			failedFiles:    0,
			attemptedFiles: 0,
			want:           jobStatusCompleted,
		},
		{
			// Defensive: protected must never exceed scanned, but if it does
			// the byte gate must not produce a negative ratio that silently
			// suppresses the file gate.
			name:           "protected exceeding scanned still honours the file gate",
			protectedBytes: 2_000_000,
			scannedBytes:   1_000_000,
			failedFiles:    90,
			attemptedFiles: 100,
			want:           jobStatusPartial,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := classifyCompletionStatus(tt.protectedBytes, tt.scannedBytes, tt.failedFiles, tt.attemptedFiles)
			if got != tt.want {
				t.Fatalf("classifyCompletionStatus(%d, %d, %d, %d) = %q, want %q",
					tt.protectedBytes, tt.scannedBytes, tt.failedFiles, tt.attemptedFiles, got, tt.want)
			}
		})
	}
}

// A run where nearly everything failed must NOT present as `completed`. This is
// the #3000 repro end-to-end through RunBackupContext: 21 of 22 files fail to
// upload and only a sliver of the bytes land.
func TestRunBackupContext_NearTotalFailureIsPartial(t *testing.T) {
	restore := setUploadRetryDelayForTest(0)
	defer restore()

	dir := t.TempDir()
	// One small file survives; 21 larger ones fail. Both the byte gate and the
	// file gate trip, matching the field report.
	createTempFile(t, dir, "good.txt", "85 bytes worth of content")
	for i := 0; i < 21; i++ {
		createTempFile(t, dir, fmt.Sprintf("cloud-only-%02d.dat", i), strings.Repeat("x", 4096))
	}

	provider := &failSubstringUploadProvider{mockProvider: newMockProvider(), failSubstring: "cloud-only-"}
	mgr := NewBackupManager(BackupConfig{
		Provider:   provider,
		Paths:      []string{dir},
		StagingDir: t.TempDir(),
	})

	job, err := mgr.RunBackupContext(context.Background(), nil)
	if err != nil {
		t.Fatalf("a partial run must still return without a fatal error, got: %v", err)
	}
	if job.Status != jobStatusPartial {
		t.Fatalf("expected %q for a 21-of-22 failure run, got %q", jobStatusPartial, job.Status)
	}
	// The existing partial-success design must be preserved, not replaced: the
	// snapshot is still real and its failures are still visible.
	if job.ErrorCount != 21 {
		t.Fatalf("expected ErrorCount=21, got %d", job.ErrorCount)
	}
	if job.FilesBackedUp != 1 {
		t.Fatalf("expected the one good file to still be backed up, got %d", job.FilesBackedUp)
	}
	if !strings.Contains(job.Warning, "21 of 22 files failed to upload") {
		t.Fatalf("Warning must still carry the failure summary, got: %q", job.Warning)
	}
	if job.Snapshot == nil {
		t.Fatal("a partial run must still carry its snapshot — it is a real restore point")
	}
}

// The converse guard: a proportionally small number of failures keeps the
// deliberate `completed`-with-a-warning behaviour. Without this the change
// would have made every error fail the job, which is exactly what the existing
// design comment consciously rejected.
func TestRunBackupContext_SmallFailureRatioStaysCompleted(t *testing.T) {
	restore := setUploadRetryDelayForTest(0)
	defer restore()

	dir := t.TempDir()
	// 1 tiny failure out of 40 files: 2.5% of files and well under 10% of the
	// bytes, so neither gate trips.
	createTempFile(t, dir, "bad-file.txt", "x")
	for i := 0; i < 39; i++ {
		createTempFile(t, dir, fmt.Sprintf("good-%02d.dat", i), strings.Repeat("y", 1024))
	}

	provider := &failSubstringUploadProvider{mockProvider: newMockProvider(), failSubstring: "bad-file"}
	mgr := NewBackupManager(BackupConfig{
		Provider:   provider,
		Paths:      []string{dir},
		StagingDir: t.TempDir(),
	})

	job, err := mgr.RunBackupContext(context.Background(), nil)
	if err != nil {
		t.Fatalf("small-ratio partial success must not fail the run, got: %v", err)
	}
	if job.Status != jobStatusCompleted {
		t.Fatalf("expected %q for a 1-of-40 failure run, got %q", jobStatusCompleted, job.Status)
	}
	if job.ErrorCount != 1 {
		t.Fatalf("failures must still be counted on a completed run, got ErrorCount=%d", job.ErrorCount)
	}
	if job.Warning == "" {
		t.Fatal("failures must still be surfaced as a Warning on a completed run")
	}
}

// A fully clean run is untouched by the threshold logic.
func TestRunBackupContext_CleanRunStaysCompleted(t *testing.T) {
	dir := t.TempDir()
	createTempFile(t, dir, "a.txt", "alpha")
	createTempFile(t, dir, "b.txt", "beta")

	mgr := NewBackupManager(BackupConfig{
		Provider:   newMockProvider(),
		Paths:      []string{dir},
		StagingDir: t.TempDir(),
	})

	job, err := mgr.RunBackupContext(context.Background(), nil)
	if err != nil {
		t.Fatalf("clean run must not error, got: %v", err)
	}
	if job.Status != jobStatusCompleted {
		t.Fatalf("expected %q for a clean run, got %q", jobStatusCompleted, job.Status)
	}
	if job.ErrorCount != 0 {
		t.Fatalf("clean run must have ErrorCount=0, got %d", job.ErrorCount)
	}
}

// The `partial` status has to survive the backup result payload's oversize
// degradation tiers (#3001 / PR #3004). That degradation logic lives in
// agent/cmd/breeze-backup/result_bounds.go, which is not on this branch, but it
// preserves fields by SHAPE, not by an enumerated value list:
//
//   - tier 3 (reduceToScalars) keeps every top-level key whose value is not a
//     JSON container, and
//   - tier 4 (lastResortStdout) keeps the keep-list {id, jobId, status,
//     snapshotId}, unmarshalling each into a plain Go string.
//
// So the property this change depends on is that `status` marshals as a
// TOP-LEVEL JSON STRING SCALAR carrying the value verbatim. This test pins that
// property on the producing side, where it can be enforced independently of
// merge order. It also pins that the change adds NO new numeric wire field,
// because tier 4's payload is a map[string]string and would silently drop one.
func TestBackupJobPartialStatusSurvivesResultDegradationShape(t *testing.T) {
	job := &BackupJob{
		ID:            "job-123",
		Status:        jobStatusPartial,
		FilesBackedUp: 1,
		BytesBackedUp: 85,
		ErrorCount:    21,
		Warning:       "21 of 22 files failed to upload",
	}

	encoded, err := json.Marshal(job)
	if err != nil {
		t.Fatalf("marshal backup job: %v", err)
	}

	var obj map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &obj); err != nil {
		t.Fatalf("backup job must marshal to a JSON object (tier 2-4 all require decodeStdoutObject to succeed): %v", err)
	}

	raw, ok := obj["status"]
	if !ok {
		t.Fatal(`"status" must be a TOP-LEVEL key: tier 4's keep-list only reads top-level keys`)
	}
	// Tier 3 keeps non-containers; tier 4 json.Unmarshals into a string.
	// Both fail if status is ever an object/array.
	if isJSONContainerShape(raw) {
		t.Fatalf(`"status" must be a scalar, not a JSON container, got %s`, raw)
	}
	var status string
	if err := json.Unmarshal(raw, &status); err != nil {
		t.Fatalf(`"status" must unmarshal into a plain string for tier 4, got %s: %v`, raw, err)
	}
	if status != jobStatusPartial {
		t.Fatalf("status must round-trip verbatim, got %q want %q", status, jobStatusPartial)
	}

	// Guard the "no new numeric wire field" decision: the partial signal must
	// ride the existing status string and the existing errorCount, never a new
	// counter that tier 4 would drop.
	for key := range obj {
		switch key {
		case "id", "startedAt", "completedAt", "snapshot", "filesBackedUp",
			"bytesBackedUp", "status", "error", "warning", "errorCount",
			"vssMetadata", "systemStateManifest", "referencedFiles", "referencedBytes":
		default:
			t.Fatalf("unexpected new field %q on the backup result wire payload: "+
				"a new field is not covered by the #3004 degradation-tier analysis", key)
		}
	}
}

// isJSONContainerShape mirrors result_bounds.go's isJSONContainer for the shape
// assertion above, so this test does not depend on that file existing yet.
func isJSONContainerShape(raw json.RawMessage) bool {
	for _, b := range raw {
		switch b {
		case ' ', '\t', '\r', '\n':
			continue
		case '{', '[':
			return true
		default:
			return false
		}
	}
	return false
}
