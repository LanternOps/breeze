//go:build windows

package backup

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup/providers"
)

// makeJunction creates a real NTFS junction (IO_REPARSE_TAG_MOUNT_POINT) with
// mklink /J, which needs no privilege — unlike os.Symlink.
func makeJunction(t *testing.T, link, target string) {
	t.Helper()
	out, err := exec.Command("cmd", "/c", "mklink", "/J", link, target).CombinedOutput()
	if err != nil {
		t.Fatalf("mklink /J %s %s: %v: %s", link, target, err, out)
	}
}

func TestPlatformSkippedReparsePoint_ClassifiesRealJunction(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "target")
	if err := os.Mkdir(target, 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "link")
	makeJunction(t, link, target)

	info, err := os.Lstat(link)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode()&os.ModeIrregular == 0 {
		// The premise of #7051: Go 1.23+ reports junctions as ModeIrregular.
		t.Fatalf("junction mode = %v, expected ModeIrregular", info.Mode())
	}
	sp, ok := platformSkippedReparsePoint(link, info)
	if !ok {
		t.Fatal("a junction must be classified as a skipped reparse point")
	}
	if sp.kind != reparseKindJunction {
		t.Fatalf("kind = %q, want %q (detail %q)", sp.kind, reparseKindJunction, sp.detail)
	}
	if !strings.EqualFold(filepath.Clean(sp.target), filepath.Clean(target)) {
		t.Fatalf("target = %q, want %q", sp.target, target)
	}

	regular := createTempFile(t, root, "plain.txt", "x")
	rinfo, err := os.Lstat(regular)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := platformSkippedReparsePoint(regular, rinfo); ok {
		t.Fatal("a regular file is not a reparse point")
	}
}

// #7325: a real junction is captured as a link (target = its substitute
// name), never traversed, and never a files entry.
func TestCollectBackupFiles_JunctionCapturedNotTraversed(t *testing.T) {
	outside := t.TempDir()
	createTempFile(t, outside, "secret-elsewhere.txt", "must not be reached through the junction")

	root := t.TempDir()
	createTempFile(t, root, "data.txt", "payload")
	makeJunction(t, filepath.Join(root, "Documents Link"), outside)

	files, skips, err := NewBackupManager(BackupConfig{}).collectBackupFilesWithSkips(context.Background(), []string{root}, nil, nil)
	if err != nil {
		t.Fatalf("collect: %v", err)
	}
	for _, f := range files {
		if strings.Contains(f.snapshotPath, "Documents Link") {
			t.Fatalf("junction (or content behind it) leaked into the manifest files: %s", f.snapshotPath)
		}
	}
	if skips.total != 0 {
		t.Fatalf("a junction to a drive path is captured, not skipped: %+v", skips)
	}
	if len(skips.junctions) != 1 || !strings.EqualFold(filepath.Clean(skips.junctions[0].Target), filepath.Clean(outside)) {
		t.Fatalf("junctions = %+v, want one to %q", skips.junctions, outside)
	}
}

// #7325 end to end on a real NTFS volume: back a tree with a junction up,
// restore it to another location, and the restored junction points at the
// equivalent path under the restore location and resolves there.
func TestJunction_BackupRestoreRoundTripOnWindows(t *testing.T) {
	root := t.TempDir()
	music := filepath.Join(root, "Music")
	if err := os.Mkdir(music, 0o755); err != nil {
		t.Fatal(err)
	}
	createTempFile(t, music, "song.txt", "la la")
	makeJunction(t, filepath.Join(root, "My Music"), music)

	provider := providers.NewLocalProvider(t.TempDir())
	mgr := NewBackupManager(BackupConfig{Provider: provider, Paths: []string{root}, StagingDir: t.TempDir()})
	job, err := mgr.RunBackupContext(context.Background(), nil)
	if err != nil {
		t.Fatalf("backup: %v", err)
	}
	if job.Snapshot == nil || len(job.Snapshot.Junctions) != 1 {
		t.Fatalf("snapshot junctions = %+v", job.Snapshot)
	}

	restoreRoot := t.TempDir()
	res, err := RestoreFromSnapshot(provider, RestoreConfig{SnapshotID: job.Snapshot.ID, TargetPath: restoreRoot}, nil)
	if err != nil {
		t.Fatalf("restore: %v", err)
	}
	if res.Status != "completed" || res.FilesFailed != 0 {
		t.Fatalf("restore result = %+v", res)
	}
	restoredMusic := filepath.Join(restoreRoot, stripVolumeAndLeadingSeparators(music))
	link := filepath.Join(restoreRoot, stripVolumeAndLeadingSeparators(root), "My Music")
	info, err := os.Lstat(link)
	if err != nil {
		t.Fatalf("restored junction missing: %v", err)
	}
	if info.Mode()&os.ModeIrregular == 0 && info.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("restored entry is not a reparse point: mode %v", info.Mode())
	}
	sp, ok := platformSkippedReparsePoint(link, info)
	if !ok || sp.kind != reparseKindJunction || !strings.EqualFold(sp.target, restoredMusic) {
		t.Fatalf("restored junction = %+v, want a junction to %q", sp, restoredMusic)
	}
	if data, err := os.ReadFile(filepath.Join(link, "song.txt")); err != nil || string(data) != "la la" {
		t.Fatalf("restored junction does not resolve into the restore location: %q %v", data, err)
	}
}

// Real symlinks are unchanged by #7051: still captured as KindSymlink, never
// recorded as skipped. os.Symlink needs SeCreateSymbolicLinkPrivilege or
// Developer Mode, so skip when the host cannot create one.
func TestCollectBackupFiles_SymlinkStillCapturedNotSkipped(t *testing.T) {
	root := t.TempDir()
	createTempFile(t, root, "real.txt", "x")
	if err := os.Symlink(filepath.Join(root, "real.txt"), filepath.Join(root, "sym.txt")); err != nil {
		t.Skipf("cannot create symlink on this host: %v", err)
	}
	files, skips, err := NewBackupManager(BackupConfig{}).collectBackupFilesWithSkips(context.Background(), []string{root}, nil, nil)
	if err != nil {
		t.Fatalf("collect: %v", err)
	}
	if skips.total != 0 {
		t.Fatalf("a symlink must not be recorded as skipped: %+v", skips)
	}
	for _, f := range files {
		if f.snapshotPath == "path_0/sym.txt" {
			if f.kind != KindSymlink {
				t.Fatalf("sym.txt kind = %q, want %q", f.kind, KindSymlink)
			}
			return
		}
	}
	t.Fatal("symlink missing from the manifest")
}
