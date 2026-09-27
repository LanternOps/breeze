//go:build darwin || linux

package securefs

import (
	"os"
	"path/filepath"
	"testing"
)

// TestEnsureTrustedDirChainCreatesFreshChain proves a from-scratch chain
// (neither component exists yet) is created with the requested owner/mode
// at every level, not just the leaf.
func TestEnsureTrustedDirChainCreatesFreshChain(t *testing.T) {
	root := t.TempDir()
	uid, gid := os.Getuid(), os.Getgid()
	dir := filepath.Join(root, "Breeze", "bin")

	if err := EnsureTrustedDirChain(root, dir, uid, gid, 0o755); err != nil {
		t.Fatalf("EnsureTrustedDirChain() error = %v, want nil", err)
	}

	for _, p := range []string{filepath.Join(root, "Breeze"), dir} {
		info, err := os.Lstat(p)
		if err != nil {
			t.Fatalf("Lstat(%s) error = %v", p, err)
		}
		if info.Mode()&os.ModeSymlink != 0 {
			t.Fatalf("%s unexpectedly a symlink", p)
		}
		if !info.IsDir() {
			t.Fatalf("%s is not a directory", p)
		}
		if info.Mode().Perm() != 0o755 {
			t.Fatalf("%s mode = %o, want 0755", p, info.Mode().Perm())
		}
	}
}

// TestEnsureTrustedDirChainRefusesSymlinkedIntermediateDir proves a
// pre-planted symlink standing in for the intermediate directory (the
// "Breeze" component) is refused, not followed.
func TestEnsureTrustedDirChainRefusesSymlinkedIntermediateDir(t *testing.T) {
	root := t.TempDir()
	elsewhere := t.TempDir()
	if err := os.Symlink(elsewhere, filepath.Join(root, "Breeze")); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(root, "Breeze", "bin")

	if err := EnsureTrustedDirChain(root, dir, os.Getuid(), os.Getgid(), 0o755); err == nil {
		t.Fatal("expected refusal for a symlinked intermediate directory")
	}
	if _, err := os.Lstat(filepath.Join(elsewhere, "bin")); err == nil {
		t.Fatal("must not have created anything through the symlink target")
	}
}

// TestEnsureTrustedDirChainRefusesSymlinkedLeafDir proves the same for the
// leaf directory ("bin") itself, with a safe intermediate already in place.
func TestEnsureTrustedDirChainRefusesSymlinkedLeafDir(t *testing.T) {
	root := t.TempDir()
	uid, gid := os.Getuid(), os.Getgid()
	if err := os.Mkdir(filepath.Join(root, "Breeze"), 0o755); err != nil {
		t.Fatal(err)
	}
	elsewhere := t.TempDir()
	if err := os.Symlink(elsewhere, filepath.Join(root, "Breeze", "bin")); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(root, "Breeze", "bin")

	if err := EnsureTrustedDirChain(root, dir, uid, gid, 0o755); err == nil {
		t.Fatal("expected refusal for a symlinked leaf directory")
	}
	if _, err := os.Lstat(filepath.Join(elsewhere, "marker")); err == nil {
		t.Fatal("must not have written through the symlink target")
	}
}

// TestEnsureTrustedDirChainRefusesNonEmptyForeignOwnedDir proves a
// pre-existing, non-empty directory that is not owned by the requested
// uid (or is group/other-writable) is refused outright rather than
// silently taken over.
func TestEnsureTrustedDirChainRefusesNonEmptyForeignOwnedDir(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "Breeze", "bin")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "planted"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	// A uid that is guaranteed not to be this directory's real owner (the
	// test process itself) reproduces "not root-owned" without needing root.
	wrongUID := os.Getuid() + 1

	if err := EnsureTrustedDirChain(root, dir, wrongUID, os.Getgid(), 0o755); err == nil {
		t.Fatal("expected refusal for a non-empty, foreign-owned directory")
	}
	if _, err := os.Stat(filepath.Join(dir, "planted")); err != nil {
		t.Fatalf("planted file must survive a refused repair: %v", err)
	}
}

// TestEnsureTrustedDirChainRepairsEmptyForeignOwnedDir proves the one safe
// repair case: an EMPTY directory with the wrong ownership/mode is removed
// and recreated correctly rather than refused.
func TestEnsureTrustedDirChainRepairsEmptyForeignOwnedDir(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "Breeze", "bin")
	if err := os.MkdirAll(dir, 0o777); err != nil {
		t.Fatal(err)
	}
	uid, gid := os.Getuid(), os.Getgid()

	if err := EnsureTrustedDirChain(root, dir, uid, gid, 0o755); err != nil {
		t.Fatalf("EnsureTrustedDirChain() error = %v, want nil (safe repair of an empty dir)", err)
	}
	info, err := os.Lstat(dir)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o755 {
		t.Fatalf("repaired dir mode = %o, want 0755", info.Mode().Perm())
	}
}

// TestEnsureTrustedDirChainRefusesWorldWritableDirEvenIfOwned proves the
// mode check fires independently of ownership: a dir already owned by the
// right uid but left group/world-writable is not treated as safe.
func TestEnsureTrustedDirChainRefusesWorldWritableDirEvenIfOwned(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "Breeze", "bin")
	if err := os.MkdirAll(dir, 0o777); err != nil {
		t.Fatal(err)
	}
	// MkdirAll's mode is clipped by umask, so force it explicitly to prove
	// the mode check fires rather than relying on the process umask.
	if err := os.Chmod(dir, 0o777); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "planted"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	uid, gid := os.Getuid(), os.Getgid()

	// Owned by us, but world-writable AND non-empty: must still be refused.
	if err := EnsureTrustedDirChain(root, dir, uid, gid, 0o755); err == nil {
		t.Fatal("expected refusal for a world-writable, non-empty directory even when uid-owned")
	}
}
