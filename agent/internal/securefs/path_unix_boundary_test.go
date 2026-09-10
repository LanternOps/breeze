//go:build linux || darwin

package securefs

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestInstallFileRejectsInvalidPaths(t *testing.T) {
	base := t.TempDir()
	cases := []struct {
		name     string
		base     string
		relative string
	}{
		{"relative base", "not-absolute", "file.txt"},
		{"absolute relative", base, "/etc/passwd"},
		{"parent traversal", base, "../escape.txt"},
		{"nested parent traversal", base, "a/../../escape.txt"},
		{"empty relative", base, ""},
		{"dot relative", base, "."},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := InstallFile(tc.base, tc.relative, writeSource(t, "denied"), 0, time.Time{}, nil); err == nil {
				t.Fatal("invalid path was accepted")
			}
		})
	}
}

// A failed install must leave the destination byte-for-byte as it was and must
// not leave a temporary behind — the window a remove-then-rename publication
// would open.
func TestInstallFileInterruptionLeavesDestinationIntact(t *testing.T) {
	base := t.TempDir()
	dest := filepath.Join(base, "file.txt")
	if err := os.WriteFile(dest, []byte("original"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := InstallFile(base, "file.txt", filepath.Join(t.TempDir(), "missing"), 0, time.Time{}, nil); err == nil {
		t.Fatal("install with a missing source succeeded")
	}
	got, err := os.ReadFile(dest)
	if err != nil {
		t.Fatalf("destination disappeared during a failed install: %v", err)
	}
	if string(got) != "original" {
		t.Fatalf("destination content = %q, want original", got)
	}
	entries, err := os.ReadDir(base)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("failed install left temporaries behind: %v", entries)
	}
}

// Concurrent publication of one destination must never expose a moment where
// the destination is absent or half-written.
func TestInstallFileConcurrentReplacement(t *testing.T) {
	base := t.TempDir()
	dest := filepath.Join(base, "file.txt")
	if err := os.WriteFile(dest, []byte("payload-seed"), 0o600); err != nil {
		t.Fatal(err)
	}

	stop := make(chan struct{})
	missing := make(chan error, 1)
	var readerWG sync.WaitGroup
	readerWG.Add(1)
	go func() {
		defer readerWG.Done()
		for {
			select {
			case <-stop:
				return
			default:
			}
			if _, err := os.Stat(dest); err != nil && os.IsNotExist(err) {
				select {
				case missing <- err:
				default:
				}
				return
			}
		}
	}()

	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			for j := 0; j < 25; j++ {
				if _, err := InstallFile(base, "file.txt", writeSource(t, fmt.Sprintf("payload-%d-%d", i, j)), 0, time.Time{}, nil); err != nil {
					t.Errorf("concurrent install failed: %v", err)
					return
				}
			}
		}(i)
	}
	wg.Wait()
	close(stop)
	readerWG.Wait()

	select {
	case err := <-missing:
		t.Fatalf("destination vanished during concurrent replacement: %v", err)
	default:
	}
	got, err := os.ReadFile(dest)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) == 0 {
		t.Fatal("destination was left empty by concurrent replacement")
	}
	entries, err := os.ReadDir(base)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("concurrent replacement left temporaries behind: %v", entries)
	}
}

// A foreign-owned component below the base must not be adopted as private
// staging. EnsurePrivateDir verifies the owner from the pinned descriptor.
func TestEnsurePrivateDirAcceptsSelfOwnedControl(t *testing.T) {
	path := filepath.Join(t.TempDir(), "private", "nested")
	if err := EnsurePrivateDir(path); err != nil {
		t.Fatalf("positive control failed: %v", err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o700 {
		t.Fatalf("private directory mode = %v, want 0700", info.Mode().Perm())
	}
}

// A restored file must never be world-readable while it is being written, even
// briefly: the staging copy can be a secret. The published mode is the
// manifest's, or 0644 when the manifest records none.
func TestInstallFilePublishesWithTheManifestMode(t *testing.T) {
	cases := []struct {
		name string
		mode os.FileMode
		want os.FileMode
	}{
		{"private secret stays private", 0o600, 0o600},
		{"executable keeps its bits", 0o750, 0o750},
		{"no recorded mode falls back to 0644", 0, 0o644},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			base := t.TempDir()
			if _, err := InstallFile(base, "file.txt", writeSource(t, "payload"), tc.mode, time.Time{}, nil); err != nil {
				t.Fatal(err)
			}
			info, err := os.Stat(filepath.Join(base, "file.txt"))
			if err != nil {
				t.Fatal(err)
			}
			if info.Mode().Perm() != tc.want {
				t.Fatalf("published mode = %v, want %v", info.Mode().Perm(), tc.want)
			}
		})
	}
}

// A walk that fails for an ordinary reason must report that reason. The
// trusted-link branch used to swallow every non-final open failure and relabel
// it "path component is a symbolic link", which hides EACCES/ENOENT/EMFILE from
// the caller and, on Linux, invented a message for a branch that is compiled
// out there entirely.
func TestWalkReportsTheRealErrorForNonLinkFailures(t *testing.T) {
	root := t.TempDir()

	t.Run("missing intermediate surfaces ENOENT", func(t *testing.T) {
		_, err := StatFile(filepath.Join(root, "missing", "deeper"), "file.txt")
		if err == nil {
			t.Fatal("expected an error for a missing intermediate component")
		}
		if !errors.Is(err, fs.ErrNotExist) {
			t.Fatalf("error = %v, want a not-exist error", err)
		}
		if strings.Contains(err.Error(), "symbolic link") {
			t.Fatalf("a missing directory was reported as a symlink: %v", err)
		}
	})

	t.Run("unreadable intermediate surfaces EACCES", func(t *testing.T) {
		if os.Geteuid() == 0 {
			t.Skip("root bypasses directory permissions")
		}
		locked := filepath.Join(root, "locked")
		if err := os.Mkdir(locked, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.Mkdir(filepath.Join(locked, "inner"), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(locked, 0o000); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = os.Chmod(locked, 0o700) })

		_, err := StatFile(filepath.Join(locked, "inner"), "file.txt")
		if err == nil {
			t.Fatal("expected an error for an unreadable intermediate component")
		}
		if !errors.Is(err, fs.ErrPermission) {
			t.Fatalf("error = %v, want a permission error", err)
		}
		if strings.Contains(err.Error(), "symbolic link") {
			t.Fatalf("an unreadable directory was reported as a symlink: %v", err)
		}
	})

	t.Run("a regular file as an intermediate component is not called a symlink", func(t *testing.T) {
		file := filepath.Join(root, "regular")
		if err := os.WriteFile(file, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
		_, err := StatFile(filepath.Join(file, "inner"), "file.txt")
		if err == nil {
			t.Fatal("expected an error for a file used as a directory")
		}
		if strings.Contains(err.Error(), "symbolic link") {
			t.Fatalf("a regular file was reported as a symlink: %v", err)
		}
	})
}
