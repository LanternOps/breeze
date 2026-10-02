//go:build windows

package backup

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/providers"
)

// TestRestoreFromSnapshot_RefusesInvalidWindowsNames: manifest entries whose
// names Windows cannot store literally (a stream separator, a trailing dot
// or space) are reported failed with invalid_windows_name; every other entry
// restores, and no stream or stripped alias is written.
func TestRestoreFromSnapshot_RefusesInvalidWindowsNames(t *testing.T) {
	provider := providers.NewLocalProvider(t.TempDir())
	snapshotID := "winname-snap"
	prefix := filepath.Join("snapshots", snapshotID)

	src := filepath.Join(t.TempDir(), "content")
	if err := os.WriteFile(src, []byte("payload"), 0o644); err != nil {
		t.Fatal(err)
	}
	upload := func(name string) string {
		key := filepath.ToSlash(filepath.Join(prefix, "files", name+".gz"))
		if err := provider.Upload(src, key); err != nil {
			t.Fatalf("upload %s: %v", name, err)
		}
		return key
	}
	now := time.Now().UTC()
	files := []SnapshotFile{
		{SourcePath: `C:\data\host.txt`, BackupPath: upload("host"), Size: 7, ModTime: now},
		{SourcePath: `C:\data\host.txt:extra`, BackupPath: upload("stream"), Size: 7, ModTime: now},
		{SourcePath: `C:\data\trailing.`, BackupPath: upload("dot"), Size: 7, ModTime: now},
		{SourcePath: `C:\data\dirstream:x`, Kind: KindDir, ModTime: now},
		{SourcePath: `C:\data\space `, Kind: KindDir, ModTime: now},
	}
	manifest, err := json.Marshal(Snapshot{ID: snapshotID, Timestamp: now, Files: files, Size: 21})
	if err != nil {
		t.Fatal(err)
	}
	manifestTmp := filepath.Join(t.TempDir(), "manifest.json")
	if err := os.WriteFile(manifestTmp, manifest, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := provider.Upload(manifestTmp, filepath.Join(prefix, "manifest.json")); err != nil {
		t.Fatal(err)
	}

	target := t.TempDir()
	result, err := RestoreFromSnapshot(provider, RestoreConfig{SnapshotID: snapshotID, TargetPath: target, WorkRoot: t.TempDir()}, nil)
	if err != nil {
		t.Fatalf("restore: %v", err)
	}
	if result.FilesRestored != 1 || result.FilesFailed != 4 {
		t.Fatalf("restored=%d failed=%d, want 1/4 (warnings %v)", result.FilesRestored, result.FilesFailed, result.Warnings)
	}
	for _, p := range []string{`C:\data\host.txt:extra`, `C:\data\trailing.`, `C:\data\dirstream:x`, `C:\data\space `} {
		if !slices.Contains(result.FailedFiles, p) {
			t.Errorf("FailedFiles %v missing %q", result.FailedFiles, p)
		}
		found := false
		for _, w := range result.Warnings {
			if strings.Contains(w, p) && strings.Contains(w, "invalid_windows_name") {
				found = true
			}
		}
		if !found {
			t.Errorf("no invalid_windows_name warning for %q in %v", p, result.Warnings)
		}
	}
	if _, err := os.Stat(filepath.Join(target, "data", "host.txt:extra")); err == nil {
		t.Error("a stream was written on host.txt")
	}
	for _, alias := range []string{"trailing", "dirstream", "space"} {
		if _, err := os.Stat(filepath.Join(target, "data", alias)); err == nil {
			t.Errorf("alias %q was written", alias)
		}
	}
}
