//go:build windows

package securefs

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

func writeSource(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "source")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// mkJunction creates a directory junction, the reparse point an unprivileged
// local identity CAN create (unlike a symlink, which needs
// SeCreateSymbolicLinkPrivilege or developer mode). It is therefore the
// realistic planting primitive for this finding on Windows.
func mkJunction(t *testing.T, link, target string) {
	t.Helper()
	out, err := exec.Command("cmd", "/c", "mklink", "/J", link, target).CombinedOutput()
	if err != nil {
		t.Skipf("cannot create a junction on this host: %v (%s)", err, out)
	}
}

func TestInstallFilePositiveControl(t *testing.T) {
	base := t.TempDir()
	warnings, err := InstallFile(base, filepath.Join("nested", "file.txt"), writeSource(t, "allowed"), 0o644, time.Time{})
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

func TestInstallFileRejectsInvalidPaths(t *testing.T) {
	base := t.TempDir()
	cases := []struct {
		name     string
		base     string
		relative string
	}{
		{"relative base", "not-absolute", "file.txt"},
		{"base without a volume", `\no-volume`, "file.txt"},
		{"absolute relative", base, `C:\Windows\System32\file.txt`},
		{"parent traversal", base, filepath.Join("..", "escape.txt")},
		{"nested parent traversal", base, filepath.Join("a", "..", "..", "escape.txt")},
		{"empty relative", base, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := InstallFile(tc.base, tc.relative, writeSource(t, "denied"), 0, time.Time{}); err == nil {
				t.Fatal("invalid path was accepted")
			}
		})
	}
}

// A reparse point at ANY depth of the walked path must be refused, so a
// planted junction cannot redirect a SYSTEM-privileged restore.
func TestInstallFileRejectsReparsePointAtEveryDepth(t *testing.T) {
	cases := []struct {
		name string
		// build returns (base, relative) with a junction planted at the depth
		// under test, plus the outside directory that must stay empty.
		build func(t *testing.T) (base, relative, outside string)
	}{
		{
			name: "junction as the base itself",
			build: func(t *testing.T) (string, string, string) {
				outside := t.TempDir()
				base := filepath.Join(t.TempDir(), "target")
				mkJunction(t, base, outside)
				return base, "file.txt", outside
			},
		},
		{
			name: "junction as an intermediate component of the base",
			build: func(t *testing.T) (string, string, string) {
				outside := t.TempDir()
				root := t.TempDir()
				mkJunction(t, filepath.Join(root, "link"), outside)
				return filepath.Join(root, "link", "inner"), "file.txt", outside
			},
		},
		{
			name: "junction below the base",
			build: func(t *testing.T) (string, string, string) {
				outside := t.TempDir()
				base := t.TempDir()
				mkJunction(t, filepath.Join(base, "nested"), outside)
				return base, filepath.Join("nested", "file.txt"), outside
			},
		},
		{
			name: "junction deeper below the base",
			build: func(t *testing.T) (string, string, string) {
				outside := t.TempDir()
				base := t.TempDir()
				if err := os.MkdirAll(filepath.Join(base, "a"), 0o700); err != nil {
					t.Fatal(err)
				}
				mkJunction(t, filepath.Join(base, "a", "b"), outside)
				return base, filepath.Join("a", "b", "file.txt"), outside
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			base, relative, outside := tc.build(t)
			if _, err := InstallFile(base, relative, writeSource(t, "denied"), 0, time.Time{}); err == nil {
				t.Fatal("reparse point was traversed")
			}
			entries, err := os.ReadDir(outside)
			if err != nil {
				t.Fatal(err)
			}
			if len(entries) != 0 {
				t.Fatalf("install escaped through the reparse point: %v", entries)
			}
		})
	}
}

// The FINAL component is replaced by name, not written through: a symlinked
// destination must be replaced without the outside file changing.
func TestInstallFileReplacesFinalLinkWithoutFollowingIt(t *testing.T) {
	base := t.TempDir()
	outside := filepath.Join(t.TempDir(), "outside.txt")
	if err := os.WriteFile(outside, []byte("outside"), 0o600); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(base, "file.txt")
	if err := os.Symlink(outside, target); err != nil {
		t.Skipf("creating a file symlink requires privilege on this host: %v", err)
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
		t.Fatal("final target remained a link")
	}
}

func TestStatFileRejectsFinalLink(t *testing.T) {
	base := t.TempDir()
	outside := filepath.Join(t.TempDir(), "outside.txt")
	if err := os.WriteFile(outside, []byte("outside"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(base, "file.txt")); err != nil {
		t.Skipf("creating a file symlink requires privilege on this host: %v", err)
	}
	if _, err := StatFile(base, "file.txt"); err == nil {
		t.Fatal("StatFile followed a final link")
	}
}

// D19: restored app config very often carries FILE_ATTRIBUTE_READONLY. The
// replace must still succeed, and must still never remove-then-rename.
func TestInstallFileReplacesReadOnlyDestination(t *testing.T) {
	base := t.TempDir()
	dest := filepath.Join(base, "file.txt")
	if err := os.WriteFile(dest, []byte("old"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dest, 0o400); err != nil {
		t.Fatal(err)
	}
	if _, err := InstallFile(base, "file.txt", writeSource(t, "new"), 0o644, time.Time{}); err != nil {
		t.Fatalf("read-only destination was not replaced: %v", err)
	}
	got, err := os.ReadFile(dest)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "new" {
		t.Fatalf("content = %q, want new", got)
	}
}

// An install that fails after the temporary file exists must leave the
// destination exactly as it was — the crash/data-loss window a remove-then-
// rename publication would open.
func TestInstallFileInterruptionLeavesDestinationIntact(t *testing.T) {
	base := t.TempDir()
	dest := filepath.Join(base, "file.txt")
	if err := os.WriteFile(dest, []byte("original"), 0o600); err != nil {
		t.Fatal(err)
	}
	// A source that cannot be opened aborts the install after the destination
	// directory has been pinned but before anything is published.
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
	for _, e := range entries {
		if e.Name() != "file.txt" {
			t.Fatalf("failed install left %q behind", e.Name())
		}
	}
}

// Concurrent publication of the same destination must never expose a moment
// where the destination is absent or partially written.
func TestInstallFileConcurrentReplacement(t *testing.T) {
	base := t.TempDir()
	dest := filepath.Join(base, "file.txt")
	if err := os.WriteFile(dest, []byte("payload-seed"), 0o600); err != nil {
		t.Fatal(err)
	}

	stop := make(chan struct{})
	var readerWG sync.WaitGroup
	readerWG.Add(1)
	missing := make(chan error, 1)
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
				source := writeSource(t, fmt.Sprintf("payload-%d-%d", i, j))
				_, _ = InstallFile(base, "file.txt", source, 0, time.Time{})
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

func TestEnsurePrivateDirProducesAProtectedDACL(t *testing.T) {
	path := filepath.Join(t.TempDir(), "private")
	if err := EnsurePrivateDir(path); err != nil {
		t.Fatalf("EnsurePrivateDir: %v", err)
	}
	if err := VerifyPrivateDir(path); err != nil {
		t.Fatalf("directory created by EnsurePrivateDir failed verification: %v", err)
	}
}

// Positive control for the DACL check itself: a directory created the ordinary
// way inherits its parent's ACEs and MUST fail verification. Without this, the
// assertion above would pass even if VerifyPrivateDir returned nil for
// everything.
func TestVerifyPrivateDirRejectsAnInheritedDACL(t *testing.T) {
	path := filepath.Join(t.TempDir(), "inherited")
	if err := os.Mkdir(path, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := VerifyPrivateDir(path); err == nil {
		t.Fatal("a directory with an inherited DACL passed verification")
	}
}

func TestVerifyPrivateDirRejectsAReparsePoint(t *testing.T) {
	real := t.TempDir()
	link := filepath.Join(t.TempDir(), "link")
	mkJunction(t, link, real)
	if err := VerifyPrivateDir(link); err == nil {
		t.Fatal("a reparse point passed private-directory verification")
	}
}

func TestPrivateDirSecurityAttributesCarriesAProtectedDescriptor(t *testing.T) {
	sa, err := PrivateDirSecurityAttributes()
	if err != nil {
		t.Fatal(err)
	}
	if sa.SecurityDescriptor == nil {
		t.Fatal("no security descriptor was built")
	}
	control, _, err := sa.SecurityDescriptor.Control()
	if err != nil {
		t.Fatal(err)
	}
	if control&windows.SE_DACL_PROTECTED == 0 {
		t.Fatal("security descriptor DACL is not protected against inheritance")
	}
}
