package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path"
	"path/filepath"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup"
	"github.com/breeze-rmm/agent/internal/backup/mssql"
	"github.com/breeze-rmm/agent/internal/backup/providers"
)

const (
	attestTestJobID   = "0b7f3c2e-5a1d-4c8e-9f60-2d4b8a1e7c35"
	attestTestAgentID = "a1b2c3d4e5f60718293a4b5c6d7e8f90"
)

func sha256Hex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

func downloadStored(t *testing.T, p providers.BackupProvider, key string) []byte {
	t.Helper()
	dst := filepath.Join(t.TempDir(), "dl")
	if err := p.Download(key, dst); err != nil {
		t.Fatalf("download %s: %v", key, err)
	}
	b, err := os.ReadFile(dst)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// statementFromResult decodes the result's attestation and checks that it
// names exactly the stored manifest bytes.
func statementFromResult(t *testing.T, stdout string, p providers.BackupProvider, snapshotID string) backup.AttestationStatement {
	t.Helper()
	var out struct {
		Attestation *backup.AttestationEnvelope `json:"attestation"`
	}
	if err := json.Unmarshal([]byte(stdout), &out); err != nil {
		t.Fatalf("decode result: %v", err)
	}
	if out.Attestation == nil {
		t.Fatalf("no attestation in result: %s", stdout)
	}
	var s backup.AttestationStatement
	dec := json.NewDecoder(strings.NewReader(out.Attestation.Statement))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&s); err != nil {
		t.Fatalf("decode statement: %v", err)
	}
	if again, err := backup.EncodeAttestationStatement(s); err != nil || again != out.Attestation.Statement {
		t.Fatalf("statement is not canonical: %v", err)
	}
	if s.SnapshotID != snapshotID || s.JobID != attestTestJobID || s.AgentID != attestTestAgentID {
		t.Fatalf("statement bindings %+v", s)
	}
	if s.DispatchedBaseSnapshotID != nil || s.ParentSnapshotID != nil {
		t.Fatal("database and VM backups have no base")
	}
	if len(s.Objects) != 1 || s.Objects[0].Role != backup.AttestationRoleManifest {
		t.Fatalf("want the manifest only, got %+v", s.Objects)
	}
	manifest := downloadStored(t, p, s.Objects[0].Key)
	if s.Objects[0].SHA256 != sha256Hex(manifest) || s.Objects[0].Size != int64(len(manifest)) {
		t.Fatal("attested manifest digest does not describe the stored manifest")
	}
	return s
}

func TestExecMSSQLBackup_DigestsTheBackupFileAndAttestsTheManifest(t *testing.T) {
	provider := providers.NewLocalProvider(t.TempDir())
	stagingDir := t.TempDir()
	mgr := backup.NewBackupManager(backup.BackupConfig{Provider: provider, StagingDir: stagingDir, AgentID: attestTestAgentID})
	backupBytes := []byte("mssql-backup-bytes-for-digest")

	orig := runMSSQLBackup
	t.Cleanup(func() { runMSSQLBackup = orig })
	runMSSQLBackup = func(_, _, _, outputPath string) (*mssql.BackupResult, error) {
		f := filepath.Join(outputPath, "Db_full.bak")
		if err := os.WriteFile(f, backupBytes, 0o644); err != nil {
			t.Fatal(err)
		}
		return &mssql.BackupResult{InstanceName: "MSSQLSERVER", DatabaseName: "Db", BackupType: "full", BackupFile: f}, nil
	}
	payload, _ := json.Marshal(map[string]any{"jobId": attestTestJobID, "instance": "MSSQLSERVER", "database": "Db", "backupType": "full"})

	result := execMSSQLBackup(payload, mgr)
	if !result.Success {
		t.Fatalf("expected success, got %q", result.Stderr)
	}
	var decoded struct {
		SnapshotID string `json:"snapshotId"`
		Snapshot   struct {
			Files []struct {
				BackupPath string `json:"backupPath"`
				Checksum   string `json:"checksum"`
			} `json:"files"`
		} `json:"snapshot"`
	}
	if err := json.Unmarshal([]byte(result.Stdout), &decoded); err != nil {
		t.Fatal(err)
	}
	if len(decoded.Snapshot.Files) != 1 || decoded.Snapshot.Files[0].Checksum != sha256Hex(backupBytes) {
		t.Fatalf("result file entry must carry the uploaded file's checksum: %+v", decoded.Snapshot.Files)
	}
	statementFromResult(t, result.Stdout, provider, decoded.SnapshotID)

	var manifest backup.Snapshot
	if err := json.Unmarshal(downloadStored(t, provider, path.Join("snapshots", decoded.SnapshotID, "manifest.json")), &manifest); err != nil {
		t.Fatal(err)
	}
	if len(manifest.Files) != 1 || manifest.Files[0].Checksum != sha256Hex(backupBytes) || manifest.Files[0].Size != int64(len(backupBytes)) {
		t.Fatalf("manifest file entry %+v does not describe the uploaded .bak", manifest.Files)
	}
	if got := downloadStored(t, provider, manifest.Files[0].BackupPath); sha256Hex(got) != manifest.Files[0].Checksum {
		t.Fatal("stored .bak differs from its manifest checksum")
	}
}

func TestExecMSSQLBackup_NoAttestationWithoutAJobID(t *testing.T) {
	provider := providers.NewLocalProvider(t.TempDir())
	mgr := backup.NewBackupManager(backup.BackupConfig{Provider: provider, StagingDir: t.TempDir(), AgentID: attestTestAgentID})
	orig := runMSSQLBackup
	t.Cleanup(func() { runMSSQLBackup = orig })
	runMSSQLBackup = func(_, _, _, outputPath string) (*mssql.BackupResult, error) {
		f := filepath.Join(outputPath, "Db_full.bak")
		_ = os.WriteFile(f, []byte("x"), 0o644)
		return &mssql.BackupResult{BackupFile: f}, nil
	}
	payload, _ := json.Marshal(map[string]any{"instance": "MSSQLSERVER", "database": "Db", "backupType": "full"})
	result := execMSSQLBackup(payload, mgr)
	if !result.Success || strings.Contains(result.Stdout, `"attestation"`) {
		t.Fatalf("want success without an attestation, got success=%v stdout=%s", result.Success, result.Stdout)
	}
}

func TestExecHypervBackup_DigestsEveryExportFileAndAttestsTheManifest(t *testing.T) {
	storeDir := t.TempDir()
	provider := providers.NewLocalProvider(storeDir)
	mgr := backup.NewBackupManager(backup.BackupConfig{Provider: provider, StagingDir: t.TempDir(), AgentID: attestTestAgentID})
	stubHypervSeams(t,
		func(string) (int64, error) { return 1 * gib, nil },
		constFree(100*gib),
		nil,
		fakeExport(false),
	)
	payload, _ := json.Marshal(map[string]any{"jobId": attestTestJobID, "vmName": "Accounting VM", "consistencyType": "application"})

	result := execHypervBackup(payload, mgr)
	if !result.Success {
		t.Fatalf("expected success, got %q", result.Stderr)
	}
	var out struct {
		SnapshotID string `json:"snapshotId"`
	}
	if err := json.Unmarshal([]byte(result.Stdout), &out); err != nil {
		t.Fatal(err)
	}
	statementFromResult(t, result.Stdout, provider, out.SnapshotID)

	var manifest struct {
		Files []struct {
			BackupPath string  `json:"backupPath"`
			Size       int64   `json:"size"`
			Checksum   *string `json:"checksum"`
		} `json:"files"`
	}
	if err := json.Unmarshal(downloadStored(t, provider, path.Join("snapshots", out.SnapshotID, "manifest.json")), &manifest); err != nil {
		t.Fatal(err)
	}
	if len(manifest.Files) == 0 {
		t.Fatal("manifest lists no export files")
	}
	for _, f := range manifest.Files {
		if f.Checksum == nil || *f.Checksum == "" {
			t.Fatalf("export file %s has no checksum", f.BackupPath)
		}
		stored := downloadStored(t, provider, f.BackupPath)
		if sha256Hex(stored) != *f.Checksum || int64(len(stored)) != f.Size {
			t.Fatalf("export file %s: manifest %s/%d, stored %s/%d", f.BackupPath, *f.Checksum, f.Size, sha256Hex(stored), len(stored))
		}
	}
}

// immutableRecordingProvider stores uploads in a local provider and records
// whether each data-file upload was marked as an unchanging source.
type immutableRecordingProvider struct {
	*providers.LocalProvider
	marks map[string]bool
}

func (p *immutableRecordingProvider) UploadWithDigest(ctx context.Context, l, r string) (providers.UploadDigest, error) {
	p.marks[r] = providers.IsImmutableSource(ctx)
	return p.LocalProvider.UploadWithDigest(ctx, l, r)
}

// Database and VM backup files are written by the helper and cannot change
// during the backup, so they are uploaded as unchanging sources (hashed in
// one read, no part buffering).
func TestProviderBackedBackupFilesAreUploadedAsUnchangingSources(t *testing.T) {
	p := &immutableRecordingProvider{LocalProvider: providers.NewLocalProvider(t.TempDir()), marks: map[string]bool{}}
	mgr := backup.NewBackupManager(backup.BackupConfig{Provider: p, StagingDir: t.TempDir(), AgentID: attestTestAgentID})
	orig := runMSSQLBackup
	t.Cleanup(func() { runMSSQLBackup = orig })
	runMSSQLBackup = func(_, _, _, outputPath string) (*mssql.BackupResult, error) {
		f := filepath.Join(outputPath, "Db_full.bak")
		_ = os.WriteFile(f, []byte("bak"), 0o644)
		return &mssql.BackupResult{BackupFile: f}, nil
	}
	payload, _ := json.Marshal(map[string]any{"jobId": attestTestJobID, "instance": "MSSQLSERVER", "database": "Db", "backupType": "full"})
	if r := execMSSQLBackup(payload, mgr); !r.Success {
		t.Fatalf("mssql: %s", r.Stderr)
	}
	stubHypervSeams(t, func(string) (int64, error) { return 1 * gib, nil }, constFree(100*gib), nil, fakeExport(false))
	hv, _ := json.Marshal(map[string]any{"jobId": attestTestJobID, "vmName": "VM", "consistencyType": "application"})
	if r := execHypervBackup(hv, mgr); !r.Success {
		t.Fatalf("hyperv: %s", r.Stderr)
	}
	dataFiles := 0
	for key, immutable := range p.marks {
		if strings.Contains(key, "/files/") {
			dataFiles++
			if !immutable {
				t.Fatalf("%s was not uploaded as an unchanging source", key)
			}
		}
	}
	if dataFiles < 2 {
		t.Fatalf("expected the .bak and the VM export uploads, saw %v", p.marks)
	}
}
