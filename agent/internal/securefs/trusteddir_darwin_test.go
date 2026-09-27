//go:build darwin

package securefs

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// fakeMigrationFS is an in-memory ExecutableMigrationFS that records every
// call so tests can assert on both the outcome and the ownership/mode each
// path ended up with, without touching a real filesystem or needing root.
type fakeMigrationFS struct {
	dirs  map[string]os.FileMode
	files map[string][]byte
	owner map[string][2]int // path -> [uid, gid]
	mode  map[string]os.FileMode

	mkdirAllErr error
	chownErr    error
	chmodErr    error
	copyErr     error
}

func newFakeMigrationFS() *fakeMigrationFS {
	return &fakeMigrationFS{
		dirs:  map[string]os.FileMode{},
		files: map[string][]byte{"/usr/local/bin/breeze-agent": []byte("binary-bytes")},
		owner: map[string][2]int{},
		mode:  map[string]os.FileMode{},
	}
}

func (f *fakeMigrationFS) MkdirAll(path string, perm os.FileMode) error {
	if f.mkdirAllErr != nil {
		return f.mkdirAllErr
	}
	f.dirs[path] = perm
	return nil
}

func (f *fakeMigrationFS) Chown(path string, uid, gid int) error {
	if f.chownErr != nil {
		return f.chownErr
	}
	f.owner[path] = [2]int{uid, gid}
	return nil
}

func (f *fakeMigrationFS) Chmod(path string, perm os.FileMode) error {
	if f.chmodErr != nil {
		return f.chmodErr
	}
	f.mode[path] = perm
	return nil
}

func (f *fakeMigrationFS) Copy(dstPath, srcPath string) error {
	if f.copyErr != nil {
		return f.copyErr
	}
	data, ok := f.files[srcPath]
	if !ok {
		return errors.New("source not found")
	}
	f.files[dstPath] = data
	return nil
}

// TestMigrateExecutableToTrustedDirCopiesWithRootOwnership proves the
// migration creates the trusted directory root-owned and non-writable, and
// lands the copy there also root-owned — the two properties
// VerifyTrustedExecutableOwner checks — without touching the legacy path.
func TestMigrateExecutableToTrustedDirCopiesWithRootOwnership(t *testing.T) {
	fs := newFakeMigrationFS()
	legacy := "/usr/local/bin/breeze-agent"

	got, err := MigrateExecutableToTrustedDir(fs, legacy, TrustedExecutableDir)
	if err != nil {
		t.Fatalf("MigrateExecutableToTrustedDir() error = %v, want nil", err)
	}
	want := TrustedExecutableDir + "/breeze-agent"
	if got != want {
		t.Fatalf("new path = %q, want %q", got, want)
	}

	if owner := fs.owner[TrustedExecutableDir]; owner != [2]int{0, 0} {
		t.Errorf("trusted dir owner = %v, want root:wheel (0,0)", owner)
	}
	if mode := fs.mode[TrustedExecutableDir]; mode != 0o755 {
		t.Errorf("trusted dir mode = %o, want 0755", mode)
	}
	if owner := fs.owner[want]; owner != [2]int{0, 0} {
		t.Errorf("migrated binary owner = %v, want root:wheel (0,0)", owner)
	}
	if mode := fs.mode[want]; mode != 0o755 {
		t.Errorf("migrated binary mode = %o, want 0755", mode)
	}
	if data, ok := fs.files[want]; !ok || string(data) != "binary-bytes" {
		t.Errorf("migrated binary content = %q, ok=%v, want the legacy binary's bytes", data, ok)
	}
	if _, stillThere := fs.files[legacy]; !stillThere {
		t.Errorf("legacy binary %s was removed; migration must leave it in place", legacy)
	}
}

// TestMigrateExecutableToTrustedDirPropagatesCopyFailure proves a failed
// copy is surfaced as an error rather than silently reporting success —
// callers rely on the error to decide whether it's safe to repoint the
// service definition at the new path.
func TestMigrateExecutableToTrustedDirPropagatesCopyFailure(t *testing.T) {
	fs := newFakeMigrationFS()
	fs.copyErr = errors.New("disk full")

	if _, err := MigrateExecutableToTrustedDir(fs, "/usr/local/bin/breeze-agent", TrustedExecutableDir); err == nil {
		t.Fatal("MigrateExecutableToTrustedDir() error = nil, want the copy failure surfaced")
	}
}

// TestOSExecutableMigrationFSCopyReplacesSymlinkedTargetWithoutFollowingIt
// proves Copy's rename-based publish replaces a pre-existing symlink at
// dstPath as a directory entry — never opening/writing through it to
// whatever it points at.
func TestOSExecutableMigrationFSCopyReplacesSymlinkedTargetWithoutFollowingIt(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "legacy-binary")
	if err := os.WriteFile(src, []byte("trusted-bytes"), 0o755); err != nil {
		t.Fatal(err)
	}

	decoyTarget := filepath.Join(dir, "decoy-target")
	if err := os.WriteFile(decoyTarget, []byte("do-not-touch"), 0o644); err != nil {
		t.Fatal(err)
	}
	dst := filepath.Join(dir, "breeze-agent")
	if err := os.Symlink(decoyTarget, dst); err != nil {
		t.Fatal(err)
	}

	if err := (osExecutableMigrationFS{}).Copy(dst, src); err != nil {
		t.Fatalf("Copy() error = %v, want nil", err)
	}

	// The decoy the symlink pointed at must be untouched.
	decoyBytes, err := os.ReadFile(decoyTarget)
	if err != nil {
		t.Fatal(err)
	}
	if string(decoyBytes) != "do-not-touch" {
		t.Fatalf("decoy target was modified: %q", decoyBytes)
	}

	// dst itself must now be the real published file, not a symlink.
	info, err := os.Lstat(dst)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode()&os.ModeSymlink != 0 {
		t.Fatal("dst is still a symlink after Copy; expected the symlink entry to be replaced")
	}
	published, err := os.ReadFile(dst)
	if err != nil {
		t.Fatal(err)
	}
	if string(published) != "trusted-bytes" {
		t.Fatalf("published content = %q, want the source bytes", published)
	}
}

// TestOSExecutableMigrationFSCopyRefusesSymlinkedDestinationDirectory proves
// Copy refuses outright when the destination's containing directory is
// itself a symlink, rather than writing through it.
func TestOSExecutableMigrationFSCopyRefusesSymlinkedDestinationDirectory(t *testing.T) {
	root := t.TempDir()
	src := filepath.Join(root, "legacy-binary")
	if err := os.WriteFile(src, []byte("trusted-bytes"), 0o755); err != nil {
		t.Fatal(err)
	}
	elsewhere := t.TempDir()
	linkedDir := filepath.Join(root, "bin")
	if err := os.Symlink(elsewhere, linkedDir); err != nil {
		t.Fatal(err)
	}

	if err := (osExecutableMigrationFS{}).Copy(filepath.Join(linkedDir, "breeze-agent"), src); err == nil {
		t.Fatal("expected refusal for a symlinked destination directory")
	}
	if _, err := os.Lstat(filepath.Join(elsewhere, "breeze-agent")); err == nil {
		t.Fatal("must not have written through the symlinked directory")
	}
}

// TestOSExecutableMigrationFSChownRefusesSymlink and
// TestOSExecutableMigrationFSChmodRefusesSymlink prove the second,
// independent guard on the real Chown/Chmod implementations fires — not
// just MkdirAll's EnsureTrustedDirChain call.
func TestOSExecutableMigrationFSChownRefusesSymlink(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "real")
	if err := os.Mkdir(target, 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "linked")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	if err := (osExecutableMigrationFS{}).Chown(link, os.Getuid(), os.Getgid()); err == nil {
		t.Fatal("expected refusal for a symlinked path")
	}
}

func TestOSExecutableMigrationFSChmodRefusesSymlink(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "real")
	if err := os.Mkdir(target, 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "linked")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	if err := (osExecutableMigrationFS{}).Chmod(link, 0o755); err == nil {
		t.Fatal("expected refusal for a symlinked path")
	}
}
