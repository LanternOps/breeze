//go:build unix

package backup

import (
	"context"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/vss"
)

// stubJunctionClassifier makes every irregular entry the walk meets a junction
// to target (a FIFO stands in for the junction on Unix).
func stubJunctionClassifier(t *testing.T, target string) {
	t.Helper()
	orig := skippedReparsePointFor
	skippedReparsePointFor = func(path string, info os.FileInfo) (skippedReparsePoint, bool) {
		return skippedReparsePoint{path: path, kind: reparseKindJunction, target: target}, true
	}
	t.Cleanup(func() { skippedReparsePointFor = orig })
}

// On a VSS run the walk sees the junction under the shadow copy; the manifest
// must record the live path it mirrors as OriginalPath, which is what restore
// places it under and what a selection matches. A non-VSS run leaves
// OriginalPath empty (TestRunBackupContext_JunctionInManifestNotWarning).
func TestRunBackupContext_VSSJunctionRecordsLiveOriginalPath(t *testing.T) {
	shadowRoot := t.TempDir()
	srcDir := t.TempDir()
	shadowed := shadowedSourceDir(t, shadowRoot, srcDir)
	createTempFile(t, shadowed, "real.txt", "keep me")
	if err := syscall.Mkfifo(filepath.Join(shadowed, "My Music"), 0o644); err != nil {
		t.Skipf("mkfifo unsupported here: %v", err)
	}
	stubJunctionClassifier(t, `C:\Users\a\Music`)

	vssProvider := &fakeVSSProvider{
		session: &vss.VSSSession{
			ID:          "shadow-set-1",
			Volumes:     []string{filepath.VolumeName(srcDir)},
			ShadowPaths: map[string]string{filepath.VolumeName(srcDir): shadowRoot},
			CreatedAt:   time.Now().UTC(),
		},
	}
	mgr := NewBackupManager(BackupConfig{
		Provider:    newMockProvider(),
		Paths:       []string{srcDir},
		VSSEnabled:  true,
		VSSProvider: vssProvider,
		StagingDir:  t.TempDir(),
	})
	job, err := mgr.RunBackupContext(context.Background(), nil)
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if job.Snapshot == nil || len(job.Snapshot.Junctions) != 1 {
		t.Fatalf("snapshot junctions = %+v", job.Snapshot)
	}
	j := job.Snapshot.Junctions[0]
	if j.SourcePath != filepath.Join(shadowed, "My Music") {
		t.Fatalf("SourcePath = %q, want the shadow path the walk read", j.SourcePath)
	}
	if j.OriginalPath != filepath.Join(srcDir, "My Music") {
		t.Fatalf("OriginalPath = %q, want the live path %q", j.OriginalPath, filepath.Join(srcDir, "My Music"))
	}
	if j.restorePath() != j.OriginalPath {
		t.Fatal("restore must place the junction under its live path")
	}
}

// An excluded junction is not captured: the exclude check runs before the
// walk classifies the entry.
func TestCollectBackupFiles_ExcludedJunctionNotCaptured(t *testing.T) {
	root := t.TempDir()
	createTempFile(t, root, "data.txt", "payload")
	if err := syscall.Mkfifo(filepath.Join(root, "My Music"), 0o644); err != nil {
		t.Skipf("mkfifo unsupported here: %v", err)
	}
	stubJunctionClassifier(t, `C:\Users\a\Music`)

	_, skips, err := NewBackupManager(BackupConfig{}).collectBackupFilesWithSkips(context.Background(), []string{root}, newExcludeMatcher([]string{"My Music"}), nil)
	if err != nil {
		t.Fatalf("collect: %v", err)
	}
	if len(skips.junctions) != 0 || skips.total != 0 {
		t.Fatalf("an excluded junction must be neither captured nor reported: %+v", skips)
	}
}
