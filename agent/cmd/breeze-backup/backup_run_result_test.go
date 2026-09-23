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

// TestMarshalBackupRunResultFailedSystemImageRunOmitsNullSnapshot is the D11
// wire-shape regression: a system-state-only run whose collection fails
// (backup.go's RunBackupContext) reaches here with job.Snapshot nil and
// Status "failed". apps/api/src/routes/backup/resultSchemas.ts models the
// result's `snapshot` field as `backupSnapshotResultSchema.optional()` — Zod's
// `.optional()` accepts a MISSING key but rejects an explicit `null` — so
// before BackupJob.Snapshot carried `omitempty` this body's `"snapshot":null`
// 400'd the whole result at the API and the real failure reason in Stderr
// never reached the job record. This package cannot import the API's zod
// schema, so this locks in the wire shape the API actually accepts: the key
// must be absent, not present-and-null.
func TestMarshalBackupRunResultFailedSystemImageRunOmitsNullSnapshot(t *testing.T) {
	job := &backup.BackupJob{
		ID:     "job-2",
		Status: "failed",
		// Snapshot deliberately left nil — a fail-loud system-state-only run
		// never reaches createSnapshot.
	}

	result := marshalBackupRunResult(job, errors.New(
		"system state collection missing required artifact(s) [registry] - image would not be restorable"))

	if result.Success {
		t.Fatal("a failed run must not be reported as successful")
	}
	var decoded map[string]any
	if err := json.Unmarshal([]byte(result.Stdout), &decoded); err != nil {
		t.Fatalf("failed run must carry a parseable job body, got %q: %v", result.Stdout, err)
	}
	if _, present := decoded["snapshot"]; present {
		t.Fatalf(`job body must omit "snapshot" entirely when nil, not send it as null: %s`, result.Stdout)
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

// TestMarshalBackupRunResultOmitsSecurityDescriptorTable (W06a I2): the
// snapshot's NTFS security-descriptor table belongs in the manifest
// (snapshots/<id>/manifest.json, which restore reads) and nowhere else. It
// can be large on a whole-machine run and the server discards it, so the
// backup_run result — success AND failure — must not carry the key, while the
// job's own Snapshot (the manifest source) keeps it untouched.
func TestMarshalBackupRunResultOmitsSecurityDescriptorTable(t *testing.T) {
	for _, runErr := range []error{nil, errors.New("partial upload failure")} {
		snap := &backup.Snapshot{
			ID:                  "snap-sd",
			Files:               []backup.SnapshotFile{{SourcePath: "C:/a.txt", SDIndex: 1}},
			SecurityDescriptors: []string{"AQAEgBQAAAAkAAAAAAAAADAAAAA="},
		}
		job := &backup.BackupJob{ID: "job-sd", Status: "completed", Snapshot: snap}

		result := marshalBackupRunResult(job, runErr)

		var decoded struct {
			Snapshot map[string]json.RawMessage `json:"snapshot"`
		}
		if err := json.Unmarshal([]byte(result.Stdout), &decoded); err != nil {
			t.Fatalf("err=%v: body must parse, got %q: %v", runErr, result.Stdout, err)
		}
		if string(decoded.Snapshot["id"]) != `"snap-sd"` {
			t.Fatalf("err=%v: snapshot identity lost: %s", runErr, result.Stdout)
		}
		if _, has := decoded.Snapshot["securityDescriptors"]; has {
			t.Errorf("err=%v: result snapshot still carries securityDescriptors: %s", runErr, result.Stdout)
		}
		manifest, err := json.Marshal(job.Snapshot)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(manifest), `"securityDescriptors":["AQAEgBQAAAAkAAAAAAAAADAAAAA="]`) {
			t.Errorf("err=%v: manifest lost its securityDescriptors table: %s", runErr, manifest)
		}
	}
}
