//go:build linux || darwin

package hyperv

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Restored files are placed with a handle-pinned walk that never follows a
// link planted in the destination tree, so a directory on the target volume
// that turns out to be a link fails the entry instead of redirecting it.
func TestRestoreManifestFiles_DoesNotFollowLinkedDirectories(t *testing.T) {
	data := []byte("payload")
	tests := []struct {
		name  string
		files []vmRestoreManifFile
		// wantFailed is the number of file entries that must fail.
		wantFailed int
	}{
		{name: "file under a linked directory", files: []vmRestoreManifFile{vssEntry(1, `C:\data\1.bin`, "k1", data)}, wantFailed: 1},
		{name: "file two levels under a linked directory", files: []vmRestoreManifFile{vssEntry(1, `C:\data\deep\2.bin`, "k1", data)}, wantFailed: 1},
		{name: "directory entry under a linked directory", files: []vmRestoreManifFile{{SourcePath: `C:\data\sub`, Kind: manifestKindDir}, vssEntry(1, `C:\ok\3.bin`, "k1", data)}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			root := t.TempDir()
			outside := t.TempDir()
			if err := os.Symlink(outside, filepath.Join(root, "data")); err != nil {
				t.Fatal(err)
			}
			store := &fakeObjectStore{objects: map[string][]byte{"k1": data}}
			tally := restoreManifestFiles(context.Background(), tt.files, store, root, t.TempDir(), nil)
			if tally.Failed != tt.wantFailed {
				t.Fatalf("tally = %+v, want %d failed", tally, tt.wantFailed)
			}
			if entries, _ := os.ReadDir(outside); len(entries) != 0 {
				t.Fatalf("the restore wrote through the link: %v", entries)
			}
		})
	}
}

// A file already at the destination path that is a link is replaced by
// name; its target is never written.
func TestRestoreManifestFiles_ReplacesLinkedFileByName(t *testing.T) {
	data := []byte("payload")
	root := t.TempDir()
	outside := filepath.Join(t.TempDir(), "target.bin")
	if err := os.WriteFile(outside, []byte("unchanged"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "data"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "data", "1.bin")); err != nil {
		t.Fatal(err)
	}
	store := &fakeObjectStore{objects: map[string][]byte{"k1": data}}
	tally := restoreManifestFiles(context.Background(), []vmRestoreManifFile{vssEntry(1, `C:\data\1.bin`, "k1", data)}, store, root, t.TempDir(), nil)
	if tally.Restored != 1 || tally.Failed != 0 {
		t.Fatalf("tally = %+v, want the file restored", tally)
	}
	if got, _ := os.ReadFile(outside); string(got) != "unchanged" {
		t.Fatalf("the link target was written: %q", got)
	}
	info, err := os.Lstat(filepath.Join(root, "data", "1.bin"))
	if err != nil || info.Mode()&os.ModeSymlink != 0 {
		t.Fatalf("the destination is still a link: %v %v", info, err)
	}
}

// Without an integrity expectation the bytes are still downloaded to the
// private staging directory, checked with the earlier rules, and placed.
func TestRestoreManifestFiles_StagesOutsideTheVolumeWithoutExpectation(t *testing.T) {
	data := []byte("payload")
	root := t.TempDir()
	workDir := t.TempDir()
	store := &destRecorder{fakeObjectStore: &fakeObjectStore{objects: map[string][]byte{"k1": data}}, dests: map[string]string{}}
	tally := restoreManifestFiles(context.Background(), []vmRestoreManifFile{vssEntry(1, `C:\data\1.bin`, "k1", data)}, store, root, workDir, nil)
	if tally.Restored != 1 {
		t.Fatalf("tally = %+v", tally)
	}
	if dest := store.dests["k1"]; !underRoot(workDir, dest) {
		t.Fatalf("object downloaded to %q, want it staged under %q", dest, workDir)
	}
	if left, _ := os.ReadDir(workDir); len(left) != 0 {
		t.Fatalf("staging left in the work directory: %v", left)
	}
	if got, err := os.ReadFile(filepath.Join(root, "data", "1.bin")); err != nil || string(got) != string(data) {
		t.Fatalf("destination = %q, %v", got, err)
	}
}

// A staging directory that cannot be created fails every file rather than
// falling back to downloading onto the volume.
func TestRestoreManifestFiles_StagingUnavailableFailsEveryFile(t *testing.T) {
	data := []byte("payload")
	notADir := filepath.Join(t.TempDir(), "work")
	if err := os.WriteFile(notADir, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	store := &fakeObjectStore{objects: map[string][]byte{"k1": data, "k2": data}}
	files := []vmRestoreManifFile{vssEntry(1, `C:\a\1.bin`, "k1", data), vssEntry(1, `C:\a\2.bin`, "k2", data), {SourcePath: `C:\a\d`, Kind: manifestKindDir}}
	tally := restoreManifestFiles(context.Background(), files, store, root, filepath.Join(notADir, "sub"), nil)
	if tally.Failed != 2 || tally.Restored != 0 || tally.err() == nil {
		t.Fatalf("tally = %+v, want both files failed", tally)
	}
	if !strings.Contains(strings.Join(tally.Warnings, "\n"), "staging") {
		t.Fatalf("warnings = %q, want the staging failure named", tally.Warnings)
	}
	if len(store.calls) != 0 {
		t.Fatalf("objects were downloaded without a staging directory: %v", store.calls)
	}
}

// The background sync directory is created private and never adopted
// through a link.
func TestRunBackgroundSync_LinkedSyncDirectoryDegrades(t *testing.T) {
	data := []byte("payload")
	workDir := t.TempDir()
	outside := t.TempDir()
	syncDir := filepath.Join(workDir, "sync-staging")
	if err := os.Symlink(outside, syncDir); err != nil {
		t.Fatal(err)
	}
	store := &fakeObjectStore{objects: map[string][]byte{"k1": data}}
	result := &InstantBootResult{Status: "completed"}
	runBackgroundSync(context.Background(), result, syncDir, []vmRestoreManifFile{vssEntry(1, `C:\d\1.bin`, "k1", data)}, store, nil)
	if result.Status != "degraded" || result.SyncProgress == nil || result.SyncProgress.Synced != 0 {
		t.Fatalf("result = %+v progress %+v, want degraded with nothing synced", result, result.SyncProgress)
	}
	if entries, _ := os.ReadDir(outside); len(entries) != 0 {
		t.Fatalf("the sync wrote through the link: %v", entries)
	}
}

func TestRunBackgroundSync_SyncDirectoryIsPrivate(t *testing.T) {
	data := []byte("payload")
	syncDir := filepath.Join(t.TempDir(), "sync-staging")
	store := &fakeObjectStore{objects: map[string][]byte{"k1": data}}
	result := &InstantBootResult{Status: "completed"}
	runBackgroundSync(context.Background(), result, syncDir, []vmRestoreManifFile{vssEntry(1, `C:\d\1.bin`, "k1", data)}, store, nil)
	if result.Status != "completed" {
		t.Fatalf("result = %+v", result)
	}
	info, err := os.Stat(syncDir)
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm&0o077 != 0 {
		t.Fatalf("sync directory mode = %o, want no group or other access", perm)
	}
}
