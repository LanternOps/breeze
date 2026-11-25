package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backup"
)

// The backup_restore payload's `allowOverwriteOriginals` reaches the restore (#12638): absent
// (as every older server sends it), a target that is the files' own volume
// root is refused and the original is left alone; true restores in place.
func TestExecBackupRestore_AllowOverwriteOriginalsFlag(t *testing.T) {
	originalWorkRoot := backupRestoreWorkRoot
	backupRestoreWorkRoot = func() string { return t.TempDir() }
	t.Cleanup(func() { backupRestoreWorkRoot = originalWorkRoot })

	for _, tc := range []struct {
		name string
		flag any // nil: the field is absent
		want string
	}{
		{name: "absent", flag: nil, want: "live"},
		{name: "false", flag: false, want: "live"},
		{name: "true", flag: true, want: "backed up"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir, err := filepath.EvalSymlinks(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			original := filepath.Join(dir, "testfile1.dat")
			if err := os.WriteFile(original, []byte("backed up"), 0o644); err != nil {
				t.Fatal(err)
			}
			provider := privateTestLocalProvider(t, t.TempDir())
			const snapshotID = "inplace-cmd"
			prefix := filepath.ToSlash(filepath.Join("snapshots", snapshotID))
			key := prefix + "/files/f.gz"
			if err := provider.Upload(original, key); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(original, []byte("live"), 0o644); err != nil {
				t.Fatal(err)
			}
			manifest, err := json.Marshal(backup.Snapshot{ID: snapshotID, Timestamp: time.Now().UTC(), Size: 9,
				Files: []backup.SnapshotFile{{SourcePath: original, BackupPath: key, Size: 9, ModTime: time.Now().UTC()}}})
			if err != nil {
				t.Fatal(err)
			}
			manifestPath := filepath.Join(t.TempDir(), "manifest.json")
			if err := os.WriteFile(manifestPath, manifest, 0o644); err != nil {
				t.Fatal(err)
			}
			if err := provider.Upload(manifestPath, prefix+"/manifest.json"); err != nil {
				t.Fatal(err)
			}
			mgr := backup.NewBackupManager(backup.BackupConfig{Provider: provider, Paths: []string{dir}})

			fields := map[string]any{"snapshotId": snapshotID, "targetPath": filepath.VolumeName(original) + string(filepath.Separator)}
			if tc.flag != nil {
				fields["allowOverwriteOriginals"] = tc.flag
			}
			payload, err := json.Marshal(fields)
			if err != nil {
				t.Fatal(err)
			}
			result := execBackupRestoreWithProgress(context.Background(), "c1", payload, mgr, nil, nil)
			if got, _ := os.ReadFile(original); string(got) != tc.want {
				t.Fatalf("original holds %q, want %q (result %+v)", got, tc.want, result)
			}
			if tc.want == "live" {
				var body backup.RestoreResult
				if err := json.Unmarshal([]byte(result.Stdout), &body); err != nil {
					t.Fatalf("refusal is not a result body: %v (%+v)", err, result)
				}
				if result.Success || body.Status != "failed" || body.Code != backup.ResultCodeRestoreWouldOverwriteOriginals || body.Error == "" {
					t.Fatalf("result %+v body %+v; want a failed result carrying %s and its reason", result, body, backup.ResultCodeRestoreWouldOverwriteOriginals)
				}
			}
		})
	}
}
