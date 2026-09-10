//go:build linux || darwin

package securefs

import (
	"fmt"
	"os"
	"path/filepath"
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
			if _, err := InstallFile(tc.base, tc.relative, writeSource(t, "denied"), 0, time.Time{}); err == nil {
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
	if _, err := InstallFile(base, "file.txt", filepath.Join(t.TempDir(), "missing"), 0, time.Time{}); err == nil {
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
				if _, err := InstallFile(base, "file.txt", writeSource(t, fmt.Sprintf("payload-%d-%d", i, j)), 0, time.Time{}); err != nil {
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
