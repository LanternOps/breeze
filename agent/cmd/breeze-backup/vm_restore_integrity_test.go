package main

import (
	"context"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup"
	"github.com/breeze-rmm/agent/internal/backup/hyperv"
	"github.com/breeze-rmm/agent/internal/backup/integrity"
	"github.com/breeze-rmm/agent/internal/backup/providers"
	"github.com/breeze-rmm/agent/internal/backupipc"
)

// The VM restores hand the command's integrity expectation to the hyperv
// package through its config; the file placement itself is covered by the
// hyperv package's tests.
func TestVMRestoreCommands_PassIntegrityExpectation(t *testing.T) {
	const id = "snap-vm-restore-1"
	manifest := backup.PublishedObject{Key: "snapshots/" + id + "/manifest.json", SHA256: strings.Repeat("a", 64), Size: 10}
	cases := []struct {
		name     string
		block    any
		wantMode string // "" = no expectation
		wantErr  string
	}{
		{name: "attested", block: appAttestedBlock(id, manifest), wantMode: integrity.ModeAttested},
		{name: "unattested override", block: appOverrideBlock(id), wantMode: integrity.ModeUnattestedOverride},
		{name: "no integrity block", block: nil},
		{name: "invalid integrity block", block: map[string]any{"v": 1, "mode": "sometimes", "snapshotId": id}, wantErr: "invalid integrity expectation"},
		{name: "expectation for another snapshot", block: appOverrideBlock("snap-other"), wantErr: "invalid integrity expectation"},
	}
	origRestore, origBoot := hypervRestoreAsVM, hypervInstantBoot
	t.Cleanup(func() { hypervRestoreAsVM, hypervInstantBoot = origRestore, origBoot })
	var got []*integrity.Expectation
	hypervRestoreAsVM = func(_ context.Context, cfg hyperv.VMRestoreFromBackupConfig, _ providers.BackupProvider, _ func(string, int64, int64)) (*hyperv.VMRestoreFromBackupResult, error) {
		got = append(got, cfg.Integrity)
		return &hyperv.VMRestoreFromBackupResult{Status: "completed"}, nil
	}
	hypervInstantBoot = func(_ context.Context, cfg hyperv.InstantBootConfig, _ providers.BackupProvider, _ func(string, int64, int64)) (*hyperv.InstantBootResult, error) {
		got = append(got, cfg.Integrity)
		return &hyperv.InstantBootResult{Status: "completed"}, nil
	}
	mgr := backup.NewBackupManager(backup.BackupConfig{Provider: providers.NewLocalProvider(t.TempDir())})
	run := map[string]func(p map[string]any) backupipc.BackupCommandResult{
		"vm_restore_from_backup": func(p map[string]any) backupipc.BackupCommandResult {
			return execVMRestoreFromBackup(context.Background(), sessionPayloadJSON(t, p), mgr)
		},
		"vm_instant_boot": func(p map[string]any) backupipc.BackupCommandResult {
			return execInstantBoot(context.Background(), sessionPayloadJSON(t, p), mgr)
		},
	}
	for cmd, exec := range run {
		for _, tc := range cases {
			t.Run(cmd+"/"+tc.name, func(t *testing.T) {
				got = nil
				p := map[string]any{"snapshotId": id, "vmName": "vm-new"}
				if tc.block != nil {
					p["integrity"] = tc.block
				}
				result := exec(p)
				if tc.wantErr != "" {
					if result.Success || !strings.Contains(result.Stderr, tc.wantErr) {
						t.Fatalf("result = %+v, want a failure containing %q", result, tc.wantErr)
					}
					if len(got) != 0 {
						t.Fatal("the VM restore ran with an unusable integrity block")
					}
					return
				}
				if !result.Success || len(got) != 1 {
					t.Fatalf("result = %+v, calls %d", result, len(got))
				}
				if tc.wantMode == "" {
					if got[0] != nil {
						t.Fatalf("expectation = %+v, want none", got[0])
					}
					return
				}
				if got[0] == nil || got[0].Mode != tc.wantMode || got[0].SnapshotID != id {
					t.Fatalf("expectation = %+v, want mode %q for %s", got[0], tc.wantMode, id)
				}
			})
		}
	}
}
