package main

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup"
	"github.com/breeze-rmm/agent/internal/backup/vss"
)

// #3027: the generic marshalResult discards the job body whenever err != nil, so
// every hard-failed backup reached the server as Stderr and nothing else. That
// is the branch where VSS diagnostics matter MOST — "which writer wedged" is the
// question you ask about a failure — and job.VSSMetadata plus job.Warning were
// both already populated and both thrown away one frame before the wire.
func TestMarshalBackupRunResultKeepsDiagnosticsOnFailure(t *testing.T) {
	job := &backup.BackupJob{
		ID:            "job-1",
		Status:        "failed",
		FilesBackedUp: 12,
		ErrorCount:    3,
		Warning:       "VSS shadow copy could not be created",
		VSSMetadata: &vss.VSSMetadata{
			ShadowCopyID:       "{set-1}",
			UnprotectedVolumes: []string{`D:\`},
			Writers:            []vss.WriterStatus{{Name: "NTDS", State: "failed"}},
		},
	}

	result := marshalBackupRunResult(job, errors.New("upload destination unreachable"))

	// The run still fails — the body only adds detail.
	if result.Success {
		t.Fatal("a failed run must not be reported as successful")
	}
	if !strings.Contains(result.Stderr, "upload destination unreachable") {
		t.Fatalf("failure reason lost from stderr: %q", result.Stderr)
	}

	var decoded map[string]any
	if err := json.Unmarshal([]byte(result.Stdout), &decoded); err != nil {
		t.Fatalf("failed run must carry a parseable job body, got %q: %v", result.Stdout, err)
	}
	if decoded["vssMetadata"] == nil {
		t.Errorf("vssMetadata missing from a failed run's body: %s", result.Stdout)
	}
	if decoded["warning"] != "VSS shadow copy could not be created" {
		t.Errorf("warning missing from a failed run's body: %s", result.Stdout)
	}
	// The partial counters ride the same body and were lost with it.
	if decoded["errorCount"] != float64(3) {
		t.Errorf("errorCount missing from a failed run's body: %s", result.Stdout)
	}
}

// A nil job (the early returns before the job exists — no provider, no paths,
// already running) must still deliver the reason rather than an empty body.
func TestMarshalBackupRunResultWithNoJob(t *testing.T) {
	result := marshalBackupRunResult(nil, errors.New("backup provider is required"))

	if result.Success {
		t.Fatal("expected failure")
	}
	if result.Stdout != "" {
		t.Errorf("expected no body when there is no job, got %q", result.Stdout)
	}
	if !strings.Contains(result.Stderr, "backup provider is required") {
		t.Errorf("failure reason lost: %q", result.Stderr)
	}
}

func TestMarshalBackupRunResultSuccessIsUnchanged(t *testing.T) {
	job := &backup.BackupJob{ID: "job-ok", Status: "completed", FilesBackedUp: 4}

	result := marshalBackupRunResult(job, nil)

	if !result.Success {
		t.Fatal("a clean run must report success")
	}
	if result.Stderr != "" {
		t.Errorf("success must not carry stderr, got %q", result.Stderr)
	}
	var decoded map[string]any
	if err := json.Unmarshal([]byte(result.Stdout), &decoded); err != nil {
		t.Fatalf("success body must parse, got %q: %v", result.Stdout, err)
	}
	if decoded["filesBackedUp"] != float64(4) {
		t.Errorf("success body lost its counters: %s", result.Stdout)
	}
}
