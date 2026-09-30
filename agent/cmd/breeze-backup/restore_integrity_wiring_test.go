package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup"
	"github.com/breeze-rmm/agent/internal/backup/integrity"
	"github.com/breeze-rmm/agent/internal/backup/providers"
	"github.com/breeze-rmm/agent/internal/backupipc"
)

// integrityWiringSnapshot stores a one-file snapshot and returns the manager
// serving it plus the stored manifest bytes.
func integrityWiringSnapshot(t *testing.T) (*backup.BackupManager, string, []byte) {
	t.Helper()
	provider := providers.NewLocalProvider(t.TempDir())
	snapshotID := "snap-wiring-1"
	src := filepath.Join(t.TempDir(), "a.txt")
	if err := os.WriteFile(src, []byte("alpha"), 0o600); err != nil {
		t.Fatal(err)
	}
	key := "snapshots/" + snapshotID + "/files/a.txt"
	if err := provider.Upload(src, key); err != nil {
		t.Fatal(err)
	}
	manifest, _ := json.Marshal(backup.Snapshot{ID: snapshotID, Files: []backup.SnapshotFile{{
		SourcePath: "/original/a.txt", BackupPath: key, Size: 5, Checksum: integrity.DigestBytes([]byte("alpha")),
	}}})
	mpath := filepath.Join(t.TempDir(), "manifest.json")
	if err := os.WriteFile(mpath, manifest, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := provider.Upload(mpath, "snapshots/"+snapshotID+"/manifest.json"); err != nil {
		t.Fatal(err)
	}
	return backup.NewBackupManager(backup.BackupConfig{Provider: provider}), snapshotID, manifest
}

func attestedBlock(snapshotID string, manifest []byte) map[string]any {
	return map[string]any{
		"v": 1, "mode": "attested", "trust": "server_verified", "snapshotId": snapshotID,
		"objects": []map[string]any{{
			"role": "manifest", "key": "snapshots/" + snapshotID + "/manifest.json",
			"sha256": integrity.DigestBytes(manifest), "size": len(manifest),
		}},
	}
}

func TestRestoreCommandsReadTheIntegrityBlock(t *testing.T) {
	originalWorkRoot := backupRestoreWorkRoot
	backupRestoreWorkRoot = func() string { return t.TempDir() }
	t.Cleanup(func() { backupRestoreWorkRoot = originalWorkRoot })

	type runner func(payload json.RawMessage, mgr *backup.BackupManager) backupipc.BackupCommandResult
	commands := map[string]runner{
		"backup_restore": func(p json.RawMessage, mgr *backup.BackupManager) backupipc.BackupCommandResult {
			return execBackupRestoreWithProgress(context.Background(), "c1", p, mgr, nil, nil)
		},
		"backup_verify": func(p json.RawMessage, mgr *backup.BackupManager) backupipc.BackupCommandResult {
			return execBackupVerifyContext(context.Background(), "c2", p, mgr, nil, nil)
		},
		"backup_test_restore": func(p json.RawMessage, mgr *backup.BackupManager) backupipc.BackupCommandResult {
			return execBackupTestRestoreContext(context.Background(), "c3", p, mgr, nil, nil)
		},
	}
	for name, run := range commands {
		t.Run(name, func(t *testing.T) {
			mgr, snapshotID, manifest := integrityWiringSnapshot(t)
			payload := func(block any) json.RawMessage {
				m := map[string]any{"snapshotId": snapshotID, "targetPath": t.TempDir()}
				if block != nil {
					m["integrity"] = block
				}
				b, _ := json.Marshal(m)
				return b
			}
			if res := run(payload(attestedBlock(snapshotID, manifest)), mgr); !res.Success {
				t.Fatalf("attested, matching: %+v", res)
			}
			if res := run(payload(nil), mgr); !res.Success {
				t.Fatalf("no block: %+v", res)
			}
			// An integrity block this helper cannot read fails the command.
			res := run(payload(map[string]any{"v": 2, "mode": "attested", "snapshotId": snapshotID}), mgr)
			if res.Success || !strings.Contains(res.Stderr+res.Stdout, "integrity") {
				t.Fatalf("unknown version: %+v", res)
			}
			// Manifest bytes that differ from the attestation fail the command.
			other := append([]byte(nil), manifest...)
			other[len(other)-2] ^= 1
			// backup_restore fails the command; verify and test restore report
			// a failed verification in a completed command (the server reads
			// their body only from a completed command).
			res = run(payload(attestedBlock(snapshotID, other)), mgr)
			var body struct {
				Status string `json:"status"`
			}
			_ = json.Unmarshal([]byte(res.Stdout), &body)
			if name == "backup_restore" && res.Success {
				t.Fatalf("manifest differs from attestation: %+v", res)
			}
			if name != "backup_restore" && body.Status != "failed" {
				t.Fatalf("manifest differs from attestation: %+v", res)
			}
		})
	}
}
