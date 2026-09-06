//go:build linux

package securefs

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func writeSource(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "source")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestInstallFileAllowedControl(t *testing.T) {
	base := t.TempDir()
	warnings, err := InstallFile(base, "nested/file.txt", writeSource(t, "allowed"), 0o640, time.Time{})
	if err != nil {
		t.Fatal(err)
	}
	if len(warnings) != 0 {
		t.Fatalf("unexpected warnings: %v", warnings)
	}
	got, err := os.ReadFile(filepath.Join(base, "nested", "file.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "allowed" {
		t.Fatalf("content = %q, want allowed", got)
	}
}

func TestInstallFileRejectsBaseSymlink(t *testing.T) {
	outside := t.TempDir()
	base := filepath.Join(t.TempDir(), "target")
	if err := os.Symlink(outside, base); err != nil {
		t.Fatal(err)
	}
	if _, err := InstallFile(base, "file.txt", writeSource(t, "denied"), 0, time.Time{}); err == nil {
		t.Fatal("base symlink was accepted")
	}
	if _, err := os.Stat(filepath.Join(outside, "file.txt")); !os.IsNotExist(err) {
		t.Fatalf("install escaped through base symlink: %v", err)
	}
}

func TestInstallFileRejectsIntermediateSymlink(t *testing.T) {
	base := t.TempDir()
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(base, "nested")); err != nil {
		t.Fatal(err)
	}
	if _, err := InstallFile(base, "nested/file.txt", writeSource(t, "denied"), 0, time.Time{}); err == nil {
		t.Fatal("intermediate symlink was accepted")
	}
	if _, err := os.Stat(filepath.Join(outside, "file.txt")); !os.IsNotExist(err) {
		t.Fatalf("install escaped through intermediate symlink: %v", err)
	}
}

func TestInstallFileReplacesFinalSymlinkWithoutFollowingIt(t *testing.T) {
	base := t.TempDir()
	outside := filepath.Join(t.TempDir(), "outside.txt")
	if err := os.WriteFile(outside, []byte("outside"), 0o600); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(base, "file.txt")
	if err := os.Symlink(outside, target); err != nil {
		t.Fatal(err)
	}
	if _, err := InstallFile(base, "file.txt", writeSource(t, "restored"), 0, time.Time{}); err != nil {
		t.Fatal(err)
	}
	gotOutside, err := os.ReadFile(outside)
	if err != nil {
		t.Fatal(err)
	}
	if string(gotOutside) != "outside" {
		t.Fatalf("outside file changed to %q", gotOutside)
	}
	info, err := os.Lstat(target)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode()&os.ModeSymlink != 0 {
		t.Fatal("final target remained a symlink")
	}
}

func TestStatFileRejectsFinalSymlink(t *testing.T) {
	base := t.TempDir()
	outside := filepath.Join(t.TempDir(), "outside.txt")
	if err := os.WriteFile(outside, []byte("outside"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(base, "file.txt")); err != nil {
		t.Fatal(err)
	}
	if _, err := StatFile(base, "file.txt"); err == nil {
		t.Fatal("StatFile followed a final symlink")
	}
}

func TestEnsurePrivateDirRejectsForeignOwner(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("foreign-owner setup requires root")
	}
	path := filepath.Join(t.TempDir(), "preowned")
	if err := os.Mkdir(path, 0o777); err != nil {
		t.Fatal(err)
	}
	if err := os.Chown(path, 65534, 65534); err != nil {
		t.Fatal(err)
	}
	if err := EnsurePrivateDir(path); err == nil {
		t.Fatal("foreign-owned private directory was accepted")
	}
}

func TestInstallFileResistsConcurrentIntermediateSwap(t *testing.T) {
	base := t.TempDir()
	outside := t.TempDir()
	parent := filepath.Join(base, "parent")
	held := filepath.Join(base, "parent-held")
	if err := os.Mkdir(parent, 0o755); err != nil {
		t.Fatal(err)
	}

	stop := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-stop:
				return
			default:
			}
			if os.Rename(parent, held) == nil {
				if os.Symlink(outside, parent) == nil {
					_ = os.Remove(parent)
				}
				_ = os.Rename(held, parent)
			}
		}
	}()

	for i := 0; i < 100; i++ {
		source := writeSource(t, fmt.Sprintf("content-%d", i))
		_, _ = InstallFile(base, filepath.Join("parent", fmt.Sprintf("file-%d", i)), source, 0, time.Time{})
	}
	close(stop)
	wg.Wait()

	entries, err := os.ReadDir(outside)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("concurrent swap wrote outside pinned hierarchy: %v", entries)
	}
}
