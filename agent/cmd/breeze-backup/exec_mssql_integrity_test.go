package main

import (
	"encoding/json"
	"os"
	"path"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backup"
	"github.com/breeze-rmm/agent/internal/backup/integrity"
	"github.com/breeze-rmm/agent/internal/backup/mssql"
	"github.com/breeze-rmm/agent/internal/backup/providers"
	"github.com/breeze-rmm/agent/internal/backupipc"
)

const appMSSQLBakName = "ProductionDB_full_20260930.bak"

var appMSSQLBak = []byte("mssql-full-backup-bytes")

func appMSSQLSnapshot(snapshotID string, data []byte, withoutChecksum bool) backup.Snapshot {
	f := backup.SnapshotFile{
		SourcePath: appMSSQLBakName,
		BackupPath: path.Join("snapshots", snapshotID, "files", appMSSQLBakName),
		Size:       int64(len(data)),
	}
	if !withoutChecksum {
		f.Checksum = integrity.DigestBytes(data)
	}
	return backup.Snapshot{ID: snapshotID, Timestamp: time.Now().UTC(), Files: []backup.SnapshotFile{f}, Size: f.Size}
}

// seedAppMSSQLSnapshot stores a database snapshot and returns its published
// manifest.
func seedAppMSSQLSnapshot(t *testing.T, provider providers.BackupProvider, snapshotID string, withoutChecksum bool) backup.PublishedObject {
	t.Helper()
	snap := appMSSQLSnapshot(snapshotID, appMSSQLBak, withoutChecksum)
	src := filepath.Join(t.TempDir(), appMSSQLBakName)
	if err := os.WriteFile(src, appMSSQLBak, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := provider.Upload(src, snap.Files[0].BackupPath); err != nil {
		t.Fatal(err)
	}
	obj, err := uploadMssqlSnapshotManifest(provider, "", snap)
	if err != nil {
		t.Fatalf("upload manifest: %v", err)
	}
	return obj
}

// mssqlRunnerProbe records what the SQL restore/verify runner was handed.
type mssqlRunnerProbe struct {
	targetDir string
	calls     int
	path      string
	digest    string
	staging   []string
}

func stubAppMSSQLRunners(t *testing.T) *mssqlRunnerProbe {
	t.Helper()
	probe := &mssqlRunnerProbe{targetDir: t.TempDir()}
	origResolve, origRestore, origVerify := resolveMSSQLRestoreTargetDir, runMSSQLRestore, runMSSQLVerify
	t.Cleanup(func() {
		resolveMSSQLRestoreTargetDir, runMSSQLRestore, runMSSQLVerify = origResolve, origRestore, origVerify
	})
	resolveMSSQLRestoreTargetDir = func(string) (string, error) { return probe.targetDir, nil }
	record := func(p string) {
		probe.calls++
		probe.path = p
		probe.digest, _ = integrity.FileSHA256(p)
		probe.staging = findStagingFiles(t, probe.targetDir)
	}
	runMSSQLRestore = func(_, backupFile, targetDB string, _ bool) (*mssql.RestoreResult, error) {
		record(backupFile)
		return &mssql.RestoreResult{DatabaseName: targetDB, RestoredAs: targetDB, Status: "completed", FilesRestored: 1}, nil
	}
	runMSSQLVerify = func(_, backupFile string) (*mssql.VerifyResult, error) {
		record(backupFile)
		return &mssql.VerifyResult{BackupFile: backupFile, Valid: true}, nil
	}
	return probe
}

func (p *mssqlRunnerProbe) assertTargetDirEmpty(t *testing.T) {
	t.Helper()
	entries, err := os.ReadDir(p.targetDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		names := make([]string, 0, len(entries))
		for _, e := range entries {
			names = append(names, e.Name())
		}
		t.Fatalf("SQL target directory still holds %v", names)
	}
}

func countUnattested(t *testing.T, stdout string) int {
	t.Helper()
	var body struct {
		Warnings []string `json:"warnings"`
	}
	if err := json.Unmarshal([]byte(stdout), &body); err != nil {
		t.Fatalf("result body %q: %v", stdout, err)
	}
	n := 0
	for _, w := range body.Warnings {
		if w == integrity.UnattestedRestoreWarning {
			n++
		}
	}
	return n
}

func TestExecMSSQL_Integrity(t *testing.T) {
	const id = "mssql-mssqlserver-productiondb-1-abcd"
	sameSizeOther := []byte(strings.Repeat("z", len(appMSSQLBak)))
	cases := []struct {
		name            string
		payload         func(obj backup.PublishedObject) map[string]any
		withoutChecksum bool
		storedBak       []byte
		wantErr         string
		wantUnattested  bool
	}{
		{
			name: "attested backup file is checked, then handed to SQL Server",
			payload: func(o backup.PublishedObject) map[string]any {
				return map[string]any{"snapshotId": id, "integrity": appAttestedBlock(id, o)}
			},
		},
		{
			name: "attested backup file named by its snapshot path",
			payload: func(o backup.PublishedObject) map[string]any {
				return map[string]any{"backupFile": path.Join("snapshots", id, "files", appMSSQLBakName), "integrity": appAttestedBlock(id, o)}
			},
		},
		{
			name: "same-size different bytes never reach SQL Server",
			payload: func(o backup.PublishedObject) map[string]any {
				return map[string]any{"snapshotId": id, "integrity": appAttestedBlock(id, o)}
			},
			storedBak: sameSizeOther,
			wantErr:   "differs from its attestation",
		},
		{
			name: "attested entry without a checksum fails",
			payload: func(o backup.PublishedObject) map[string]any {
				return map[string]any{"snapshotId": id, "integrity": appAttestedBlock(id, o)}
			},
			withoutChecksum: true,
			wantErr:         "no checksum",
		},
		{
			name: "manifest bytes differ from attestation",
			payload: func(o backup.PublishedObject) map[string]any {
				o.SHA256 = strings.Repeat("1", 64)
				return map[string]any{"snapshotId": id, "integrity": appAttestedBlock(id, o)}
			},
			wantErr: "differs from its attestation",
		},
		{
			name: "unattested override checks the size and warns",
			payload: func(backup.PublishedObject) map[string]any {
				return map[string]any{"snapshotId": id, "integrity": appOverrideBlock(id)}
			},
			withoutChecksum: true,
			wantUnattested:  true,
		},
		{
			name: "unattested override refuses a size mismatch",
			payload: func(backup.PublishedObject) map[string]any {
				return map[string]any{"snapshotId": id, "integrity": appOverrideBlock(id)}
			},
			withoutChecksum: true,
			storedBak:       []byte("short"),
			wantErr:         "size differs",
		},
		{
			name: "invalid integrity block fails the command",
			payload: func(backup.PublishedObject) map[string]any {
				return map[string]any{"snapshotId": id, "integrity": map[string]any{"v": 9, "mode": "attested", "snapshotId": id}}
			},
			wantErr: "invalid integrity expectation",
		},
		{
			name: "expectation for another snapshot fails the command",
			payload: func(backup.PublishedObject) map[string]any {
				return map[string]any{"snapshotId": id, "integrity": appOverrideBlock("mssql-other-1-abcd")}
			},
			wantErr: "invalid integrity expectation",
		},
		{
			name: "an expectation with a local backup file instead of a snapshot fails",
			payload: func(o backup.PublishedObject) map[string]any {
				local := filepath.Join(os.TempDir(), "breeze-integrity-test-local.bak")
				return map[string]any{"backupFile": local, "integrity": appAttestedBlock(id, o)}
			},
			wantErr: "invalid integrity expectation",
		},
	}
	for _, cmd := range []string{"mssql_restore", "mssql_verify"} {
		for _, tc := range cases {
			t.Run(cmd+"/"+tc.name, func(t *testing.T) {
				storeDir := t.TempDir()
				provider := providers.NewLocalProvider(storeDir)
				obj := seedAppMSSQLSnapshot(t, provider, id, tc.withoutChecksum)
				if tc.storedBak != nil {
					replaceStoredObject(t, storeDir, path.Join("snapshots", id, "files", appMSSQLBakName), tc.storedBak)
				}
				probe := stubAppMSSQLRunners(t)
				mgr := backup.NewBackupManager(backup.BackupConfig{Provider: provider, StagingDir: t.TempDir()})
				p := tc.payload(obj)
				p["instance"] = "MSSQLSERVER"
				p["targetDatabase"] = "ProductionDB_Restore"

				var result backupipc.BackupCommandResult
				if cmd == "mssql_restore" {
					result = execMSSQLRestore(sessionPayloadJSON(t, p), mgr)
				} else {
					result = execMSSQLVerify(sessionPayloadJSON(t, p), mgr)
				}
				assertAppMSSQLOutcome(t, result, probe, tc.wantErr, tc.wantUnattested)
			})
		}
	}
}

func assertAppMSSQLOutcome(t *testing.T, result backupipc.BackupCommandResult, probe *mssqlRunnerProbe, wantErr string, wantUnattested bool) {
	t.Helper()
	// The downloaded file is removed afterwards on every path.
	probe.assertTargetDirEmpty(t)
	if wantErr != "" {
		if result.Success || !strings.Contains(result.Stderr, wantErr) {
			t.Fatalf("result = %+v, want a failure containing %q", result, wantErr)
		}
		if probe.calls != 0 {
			t.Fatalf("the SQL runner was invoked %d times for a file that failed its checks", probe.calls)
		}
		return
	}
	if !result.Success {
		t.Fatalf("command failed: %s", result.Stderr)
	}
	if probe.calls != 1 {
		t.Fatalf("runner calls = %d, want 1", probe.calls)
	}
	if want := filepath.Join(probe.targetDir, appMSSQLBakName); probe.path != want {
		t.Fatalf("runner received %q, want the final path %q", probe.path, want)
	}
	if probe.digest != integrity.DigestBytes(appMSSQLBak) {
		t.Fatal("runner received bytes that are not the backup's")
	}
	if len(probe.staging) != 0 {
		t.Fatalf("staging files present when the runner ran: %v", probe.staging)
	}
	want := map[bool]int{true: 1, false: 0}[wantUnattested]
	if n := countUnattested(t, result.Stdout); n != want {
		t.Fatalf("unattested warning appears %d times, want %d (%s)", n, want, result.Stdout)
	}
}

func TestExecMSSQL_IntegrityBrokered(t *testing.T) {
	const id = "mssql-inst-db-7-abcd"
	cases := []struct {
		name      string
		storedBak []byte
		wantErr   string
	}{
		{name: "attested backup file through a storage session"},
		{name: "same-size different bytes through a storage session", storedBak: []byte(strings.Repeat("q", len(appMSSQLBak))), wantErr: "differs from its attestation"},
	}
	for _, cmd := range []string{"mssql_restore", "mssql_verify"} {
		for _, tc := range cases {
			t.Run(cmd+"/"+tc.name, func(t *testing.T) {
				probe := stubAppMSSQLRunners(t)
				e := newBrokeredEnv(t)
				snap := appMSSQLSnapshot(id, appMSSQLBak, false)
				raw, err := json.Marshal(snap)
				if err != nil {
					t.Fatal(err)
				}
				manifestKey := "snapshots/" + id + "/manifest.json"
				e.put(manifestKey, raw)
				stored := appMSSQLBak
				if tc.storedBak != nil {
					stored = tc.storedBak
				}
				e.put(snap.Files[0].BackupPath, stored)
				obj := backup.PublishedObject{Key: manifestKey, SHA256: integrity.DigestBytes(raw), Size: int64(len(raw))}
				p := map[string]any{
					"instance": "MSSQLSERVER", "snapshotId": id, "targetDatabase": "Db_Restored",
					"storageSession": e.session(), "integrity": appAttestedBlock(id, obj),
				}
				result := executeCommand(backupipc.BackupCommandRequest{CommandID: "m", CommandType: cmd, Payload: sessionPayloadJSON(t, p)},
					nil, nil, nil, newActiveCommandCanceller())
				assertAppMSSQLOutcome(t, result, probe, tc.wantErr, false)
			})
		}
	}
}
