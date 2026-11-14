package rebuild

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup"
)

// TestValidate_UsesRestoreKey reproduces the bug backup.RestoreKey fixes:
// a Windows whole-machine snapshot's SnapshotFile carries a VSS
// shadow-copy-rewritten SourcePath plus the real OriginalPath, and the
// restored tree is keyed by RestoreKey's output — NOT by a bare
// TrimPrefix(SourcePath, "/"), which cannot even parse a Windows path.
// validate's sample checksum step must use the same key the restore phase
// actually wrote files under, or every Windows sample lookup misses and the
// checksum-sample step silently checks 0 files instead of failing loudly.
func TestValidate_UsesRestoreKey(t *testing.T) {
	dir := t.TempDir()
	// Where the restore phase writes this entry: <base>\Users\a.txt on a
	// Windows host; on Linux/macOS the recorded `\` is not a separator, so
	// the restore writes one file literally named `Users\a.txt` — build the
	// fixture the same way so the test is exact on every host.
	target := filepath.Join(dir, `Users\a.txt`)
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		t.Fatal(err)
	}
	content := []byte("hello from a Windows VSS-backed file")
	if err := os.WriteFile(target, content, 0o644); err != nil {
		t.Fatal(err)
	}
	sum, err := backup.SHA256File(target)
	if err != nil {
		t.Fatal(err)
	}
	f := backup.SnapshotFile{
		SourcePath:   `\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopy3\Users\a.txt`,
		OriginalPath: `C:\Users\a.txt`,
		Checksum:     sum,
	}
	r := &run{
		staging:  dir,
		manifest: &backup.Snapshot{Files: []backup.SnapshotFile{f}},
		opts:     Options{SkipBoot: true},
		sys:      &fakeSystem{},
	}
	// Windows source paths only volume-strip under Windows
	// filepath.VolumeName semantics — inject them on any host through the
	// exported hook Step 3 adds next to RestoreKey.
	restore := backup.SetVolumeNameForTest(func(p string) string {
		if len(p) >= 2 && p[1] == ':' {
			return p[:2]
		}
		return ""
	})
	defer restore()

	if err := validate(context.Background(), r); err != nil {
		t.Fatalf("validate() = %v, want nil (sample checksum should have found the file under its RestoreKey)", err)
	}
}

// TestValidate_LinuxSampleStillWorks is the existing-behavior regression
// guard: a Linux entry's SourcePath already starts with "/", so
// RestoreKey must produce the exact same relative key
// strings.TrimPrefix(f.SourcePath, "/") did before this change.
func TestValidate_LinuxSampleStillWorks(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "etc"), 0o755); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(dir, "etc", "hostname")
	if err := os.WriteFile(target, []byte("kit-lab\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	sum, err := backup.SHA256File(target)
	if err != nil {
		t.Fatal(err)
	}
	r := &run{
		staging:  dir,
		manifest: &backup.Snapshot{Files: []backup.SnapshotFile{{SourcePath: "/etc/hostname", Checksum: sum}}},
		opts:     Options{SkipBoot: true},
		sys:      &fakeSystem{},
	}
	if err := validate(context.Background(), r); err != nil {
		t.Fatalf("validate() = %v, want nil", err)
	}
}

// TestValidate_SkipsFailedFileByRestoreKey is the controller-ruling
// extension: a VSS entry (OriginalPath set, SourcePath a shadow-copy
// device path) whose restore failed must be looked up in r.failedFiles by
// its RestoreSourceKey — the exact, unstripped key RestoreResult.FailedFiles
// (and thus r.failedFiles, populated unchanged from it by restore_tree.go)
// is actually written under — not by f.SourcePath (the raw shadow path), and
// not by RestoreKey (that's a different, stripped string for any Windows
// entry). Without this, a known-failed VSS file that never landed on disk
// surfaces as a checksum mismatch instead of being silently skipped as an
// already-reported warning.
func TestValidate_SkipsFailedFileByRestoreKey(t *testing.T) {
	dir := t.TempDir()
	restore := backup.SetVolumeNameForTest(func(p string) string {
		if len(p) >= 2 && p[1] == ':' {
			return p[:2]
		}
		return ""
	})
	defer restore()

	f := backup.SnapshotFile{
		SourcePath:   `\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopy3\Users\b.txt`,
		OriginalPath: `C:\Users\b.txt`,
		Checksum:     "deadbeef", // never written to disk; would mismatch if not skipped
	}
	r := &run{
		staging:     dir,
		manifest:    &backup.Snapshot{Files: []backup.SnapshotFile{f}},
		opts:        Options{SkipBoot: true},
		sys:         &fakeSystem{},
		failedFiles: map[string]bool{backup.RestoreSourceKey(f): true},
	}
	if err := validate(context.Background(), r); err != nil {
		t.Fatalf("validate() = %v, want nil (known-failed VSS file should be skipped by its RestoreSourceKey)", err)
	}
}

// Validation reads restored files through the restored tree's root: a link
// in the tree that leads outside it is not followed, so a sampled file or
// fstab outside the tree is never read in its place.
func TestValidateReadsInsideTree(t *testing.T) {
	other := t.TempDir()
	if err := os.WriteFile(filepath.Join(other, "hostname"), []byte("kit-lab\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	sum, err := backup.SHA256File(filepath.Join(other, "hostname"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(other, "fstab"), []byte("UUID=0bad0bad-0000-0000-0000-000000000000 / ext4 defaults 0 1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Run("sample", func(t *testing.T) {
		dir := t.TempDir()
		symlinkOrSkip(t, other, filepath.Join(dir, "etc"))
		r := &run{
			staging:  dir,
			manifest: &backup.Snapshot{Files: []backup.SnapshotFile{{SourcePath: "/etc/hostname", Checksum: sum}}},
			opts:     Options{SkipBoot: true},
			sys:      &fakeSystem{},
			result:   &Result{Plan: &Plan{}},
		}
		if err := validate(context.Background(), r); err == nil {
			t.Fatal("expected a sample mismatch for a file outside the tree")
		}
	})
	t.Run("fstab", func(t *testing.T) {
		dir := t.TempDir()
		symlinkOrSkip(t, other, filepath.Join(dir, "etc"))
		r := &run{staging: dir, opts: Options{SkipBoot: true}, sys: &fakeSystem{}, result: &Result{Plan: &Plan{}}}
		_ = validate(context.Background(), r)
		for _, w := range r.warnings {
			if strings.Contains(w, "0bad0bad") {
				t.Fatalf("fstab read from outside the tree: %v", r.warnings)
			}
		}
	})
}

func TestHashTreeFile(t *testing.T) {
	root, other := t.TempDir(), t.TempDir()
	mustWriteFile(t, filepath.Join(root, "usr", "lib", "file"), "content")
	mustWriteFile(t, filepath.Join(other, "file"), "content")
	want, err := backup.SHA256File(filepath.Join(other, "file"))
	if err != nil {
		t.Fatal(err)
	}
	if got, err := hashTreeFile(root, filepath.Join("usr", "lib", "file")); err != nil || got != want {
		t.Fatalf("regular file: %q %v", got, err)
	}
	symlinkOrSkip(t, other, filepath.Join(root, "outside"))
	if _, err := hashTreeFile(root, filepath.Join("outside", "file")); err == nil {
		t.Fatal("hashed a file outside the tree")
	}
	if err := os.Symlink(filepath.Join("usr", "lib"), filepath.Join(root, "lib")); err != nil {
		t.Fatal(err)
	}
	if got, err := hashTreeFile(root, filepath.Join("lib", "file")); err != nil || got != want {
		t.Fatalf("file through a link inside the tree: %q %v", got, err)
	}
	if _, err := hashTreeFile(root, "usr"); err == nil {
		t.Fatal("hashed a directory")
	}
}
