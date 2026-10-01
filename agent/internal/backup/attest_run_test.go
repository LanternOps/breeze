package backup

import (
	"context"
	"encoding/json"
	"os"
	"path"
	pathpkg "path/filepath"
	"strings"
	"testing"
	"time"
)

const (
	testJobID   = "0b7f3c2e-5a1d-4c8e-9f60-2d4b8a1e7c35"
	testAgentID = "a1b2c3d4e5f60718293a4b5c6d7e8f90"
)

func decodeAttestation(t *testing.T, job *BackupJob) AttestationStatement {
	t.Helper()
	if job.Attestation == nil {
		t.Fatalf("no attestation on the result (warning: %q)", job.Warning)
	}
	s, err := decodeStatementStrict(job.Attestation.Statement)
	if err != nil {
		t.Fatalf("decode statement: %v", err)
	}
	// Whatever the helper reports must be the canonical form.
	again, err := EncodeAttestationStatement(s)
	if err != nil || again != job.Attestation.Statement {
		t.Fatalf("reported statement is not canonical: %v", err)
	}
	return s
}

func assertObjectsMatchStorage(t *testing.T, m *mockProvider, s AttestationStatement) {
	t.Helper()
	for _, o := range s.Objects {
		d := storedDigest(t, m, o.Key)
		if o.SHA256 != d.SHA256 || o.Size != d.Size {
			t.Fatalf("%s attested as %s/%d, stored %s/%d", o.Role, o.SHA256, o.Size, d.SHA256, d.Size)
		}
	}
}

func serverOwnedManager(t *testing.T, provider *mockProvider, paths []string, baseID string) *BackupManager {
	t.Helper()
	return NewBackupManager(BackupConfig{
		Provider:              provider,
		Paths:                 paths,
		StagingDir:            t.TempDir(),
		AgentID:               testAgentID,
		JobID:                 testJobID,
		BaseSnapshotID:        &baseID,
		PublishLeaseExpiresAt: time.Now().Add(4 * time.Hour),
	})
}

func TestRunBackupContext_FullServerOwnedRunIsAttested(t *testing.T) {
	src := t.TempDir()
	createTempFile(t, src, "a.txt", "alpha")
	provider := newMockProvider()
	mgr := serverOwnedManager(t, provider, []string{src}, "")

	job, err := mgr.RunBackupContext(context.Background(), nil)
	if err != nil {
		t.Fatalf("RunBackupContext: %v", err)
	}
	s := decodeAttestation(t, job)
	if s.SnapshotID != job.Snapshot.ID || s.JobID != testJobID || s.AgentID != testAgentID {
		t.Fatalf("statement bindings %+v do not match the run", s)
	}
	if s.DispatchedBaseSnapshotID != nil || s.ParentSnapshotID != nil {
		t.Fatalf("a full dispatch must attest no base, got dispatched=%v parent=%v", s.DispatchedBaseSnapshotID, s.ParentSnapshotID)
	}
	if len(s.Objects) != 1 || s.Objects[0].Role != AttestationRoleManifest {
		t.Fatalf("a file run attests its manifest only, got %+v", s.Objects)
	}
	assertObjectsMatchStorage(t, provider, s)

	// The attestation rides the result JSON the server reads.
	data, err := json.Marshal(job)
	if err != nil {
		t.Fatal(err)
	}
	var wire struct {
		Attestation struct {
			Statement string `json:"statement"`
		} `json:"attestation"`
	}
	if err := json.Unmarshal(data, &wire); err != nil || wire.Attestation.Statement != job.Attestation.Statement {
		t.Fatalf("attestation missing from the result JSON: %s", data)
	}
}

// seedAttestedBase stores a base manifest that references an unchanged file
// of src and returns the server's attestation of it.
func seedAttestedBase(t *testing.T, provider *mockProvider, mgr *BackupManager, baseID, file string) *BaseAttestation {
	t.Helper()
	info, err := os.Stat(file)
	if err != nil {
		t.Fatal(err)
	}
	sum, err := sha256File(file)
	if err != nil {
		t.Fatal(err)
	}
	storeManifest(t, provider, &Snapshot{
		ID:             baseID,
		Timestamp:      time.Now().Add(-time.Hour).UTC(),
		BackupIdentity: mgr.runBackupIdentity(),
		Files: []SnapshotFile{{
			SourcePath: file,
			BackupPath: path.Join(snapshotRootDir, baseID, "files", "path_0", pathpkg.Base(file)+".gz"),
			Size:       info.Size(),
			ModTime:    info.ModTime(),
			Checksum:   sum,
		}},
	})
	return attestationOfStored(t, provider, baseID)
}

func TestRunBackupContext_IncrementalRunAttestsTheDispatchedBaseAsParent(t *testing.T) {
	src := t.TempDir()
	unchanged := createTempFile(t, src, "a.txt", "alpha")
	provider := newMockProvider()
	const baseID = "snapshot-20260101T000000Z-aaaaaaaaaaaaaaaaaaaaaaaa"
	mgr := serverOwnedManager(t, provider, []string{src}, baseID)
	mgr.config.BaseAttestation = seedAttestedBase(t, provider, mgr, baseID, unchanged)

	job, err := mgr.RunBackupContext(context.Background(), nil)
	if err != nil {
		t.Fatalf("RunBackupContext: %v", err)
	}
	if job.ReferencedFiles != 1 {
		t.Fatalf("want the unchanged file referenced from the base, got %d (warning %q)", job.ReferencedFiles, job.Warning)
	}
	s := decodeAttestation(t, job)
	if s.DispatchedBaseSnapshotID == nil || *s.DispatchedBaseSnapshotID != baseID || s.ParentSnapshotID == nil || *s.ParentSnapshotID != baseID {
		t.Fatalf("incremental statement must name the base as dispatched and parent, got %v / %v", s.DispatchedBaseSnapshotID, s.ParentSnapshotID)
	}
	assertObjectsMatchStorage(t, provider, s)
}

// A base whose manifest bytes differ from the server's attestation is not
// reused: the run is full (no inherited entries), and its statement keeps the
// dispatched base with a null parent.
func TestRunBackupContext_BaseMismatchFallsBackToAnAttestedFullRun(t *testing.T) {
	src := t.TempDir()
	unchanged := createTempFile(t, src, "a.txt", "alpha")
	provider := newMockProvider()
	const baseID = "snapshot-20260101T000000Z-aaaaaaaaaaaaaaaaaaaaaaaa"
	mgr := serverOwnedManager(t, provider, []string{src}, baseID)
	att := seedAttestedBase(t, provider, mgr, baseID, unchanged)
	// Same size, different bytes.
	key := att.ManifestKey
	data := append([]byte(nil), provider.files[key]...)
	i := strings.Index(string(data), `"size":`)
	data[i+1] = 'S'
	provider.files[key] = data
	mgr.config.BaseAttestation = att

	job, err := mgr.RunBackupContext(context.Background(), nil)
	if err != nil {
		t.Fatalf("RunBackupContext: %v", err)
	}
	if !strings.Contains(job.Warning, BaseFallbackAttestationMismatch) {
		t.Fatalf("warning %q does not name %s", job.Warning, BaseFallbackAttestationMismatch)
	}
	if job.ReferencedFiles != 0 {
		t.Fatalf("a fallback run must inherit nothing, got %d referenced files", job.ReferencedFiles)
	}
	own := path.Join(snapshotRootDir, job.Snapshot.ID) + "/"
	for _, f := range job.Snapshot.Files {
		if f.HasContent() && !strings.HasPrefix(f.BackupPath, own) {
			t.Fatalf("fallback manifest entry %s lies outside its own prefix", f.BackupPath)
		}
	}
	s := decodeAttestation(t, job)
	if s.DispatchedBaseSnapshotID == nil || *s.DispatchedBaseSnapshotID != baseID {
		t.Fatalf("fallback statement must keep the dispatched base, got %v", s.DispatchedBaseSnapshotID)
	}
	if s.ParentSnapshotID != nil {
		t.Fatalf("fallback statement must have a null parent, got %v", *s.ParentSnapshotID)
	}
}

func TestRunBackupContext_NoAttestationWithoutADispatchedServerOwnedJob(t *testing.T) {
	cases := map[string]func(*BackupConfig){
		"legacy dispatch (no base pin)": func(c *BackupConfig) { c.BaseSnapshotID = nil; c.PublishLeaseExpiresAt = time.Time{} },
		"no job id":                     func(c *BackupConfig) { c.JobID = "" },
		"no agent id":                   func(c *BackupConfig) { c.AgentID = "" },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			src := t.TempDir()
			createTempFile(t, src, "a.txt", "alpha")
			provider := newMockProvider()
			mgr := serverOwnedManager(t, provider, []string{src}, "")
			mutate(&mgr.config)
			job, err := mgr.RunBackupContext(context.Background(), nil)
			if err != nil {
				t.Fatalf("RunBackupContext: %v", err)
			}
			if job.Attestation != nil {
				t.Fatalf("unexpected attestation: %s", job.Attestation.Statement)
			}
			if strings.Contains(job.Warning, warnAttestationUnavailable) {
				t.Fatalf("a run that cannot attest by design must not warn: %q", job.Warning)
			}
		})
	}
}
