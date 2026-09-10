//go:build windows

package securefs

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
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
//
// It FAILS rather than skips: every reparse-point assertion in this file is
// load-bearing, CI runs `go test` without -v, and a skip is indistinguishable
// from a pass there.
func mkJunction(t *testing.T, link, target string) {
	t.Helper()
	out, err := exec.Command("cmd", "/c", "mklink", "/J", link, target).CombinedOutput()
	if err != nil {
		t.Fatalf("cannot create a junction, so the reparse-point boundary is unproven: %v (%s)", err, out)
	}
}

func tryJunction(link, target string) bool {
	return exec.Command("cmd", "/c", "mklink", "/J", link, target).Run() == nil
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

	var succeeded atomic.Int64
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			for j := 0; j < 25; j++ {
				source := writeSource(t, fmt.Sprintf("payload-%d-%d", i, j))
				if _, err := InstallFile(base, "file.txt", source, 0, time.Time{}); err == nil {
					succeeded.Add(1)
				}
			}
		}(i)
	}
	wg.Wait()
	// Without this the whole test passes vacuously when every publish fails:
	// the seed file simply stays put and the assertions below still hold.
	if succeeded.Load() != 200 {
		t.Fatalf("only %d of 200 concurrent installs succeeded; publication is broken", succeeded.Load())
	}
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

// A staging root created by an earlier agent version — or by any ordinary
// MkdirAll — already exists with an INHERITED DACL. EnsurePrivateDir must
// repair it in place (the unix implementation does the same thing with an
// unconditional fchmod) rather than refuse, or restore breaks on upgrade the
// first time the work root is reused.
func TestEnsurePrivateDirRepairsAnExistingInheritedDACL(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "restore-work")
	if err := os.MkdirAll(filepath.Join(path, "child"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := VerifyPrivateDir(path); err == nil {
		t.Fatal("fixture is not discriminating: the pre-created directory already verified")
	}
	if err := EnsurePrivateDir(path); err != nil {
		t.Fatalf("EnsurePrivateDir refused an existing directory: %v", err)
	}
	if err := VerifyPrivateDir(path); err != nil {
		t.Fatalf("EnsurePrivateDir did not repair the DACL: %v", err)
	}
	// Repair must not destroy what the directory already held.
	if _, err := os.Stat(filepath.Join(path, "child")); err != nil {
		t.Fatalf("existing content was lost during repair: %v", err)
	}
	// And it must be idempotent.
	if err := EnsurePrivateDir(path); err != nil {
		t.Fatalf("EnsurePrivateDir is not idempotent: %v", err)
	}
}

// The pinned-handle boundary: an unprivileged local identity can loop
// rmdir + "mklink /J" on a directory it owns, trying to win the window between
// the walk and the write. Because every component handle stays open (and is not
// shared for delete) and the temp create + rename are resolved relative to the
// pinned parent handle, a swap must either be refused or land inside the
// directory object we already pinned. Nothing may ever appear outside.
func TestInstallFileResistsConcurrentComponentSwap(t *testing.T) {
	base := t.TempDir()
	outside := t.TempDir()
	parent := filepath.Join(base, "parent")
	held := filepath.Join(base, "parent-held")
	if err := os.Mkdir(parent, 0o700); err != nil {
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
			// Rename rather than rmdir: a pinned handle blocks both, and this
			// exercises the "component moved away" case too.
			if os.Rename(parent, held) == nil {
				if tryJunction(parent, outside) {
					_ = os.Remove(parent)
				}
				_ = os.Rename(held, parent)
			}
		}
	}()

	succeeded := 0
	for i := 0; i < 200; i++ {
		source := writeSource(t, fmt.Sprintf("content-%d", i))
		if _, err := InstallFile(base, filepath.Join("parent", fmt.Sprintf("file-%d", i)), source, 0, time.Time{}); err == nil {
			succeeded++
		}
	}
	close(stop)
	wg.Wait()
	// Losing every iteration to the attacker's rename is a fail-closed outcome,
	// but it would also hide a publication that never works at all. The racer
	// only holds the directory away for a moment, so most iterations must land.
	if succeeded == 0 {
		t.Fatal("no install succeeded at all; publication is broken, not merely racing")
	}

	entries, err := os.ReadDir(outside)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("concurrent component swap wrote outside the pinned hierarchy: %v", entries)
	}
}

// A pre-existing directory whose DACL is protected but PERMISSIVE must still be
// tightened: "protected" only means "not inheriting", not "restrictive".
func TestEnsurePrivateDirTightensAPermissiveProtectedDACL(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "restore-work")
	if err := os.Mkdir(path, 0o755); err != nil {
		t.Fatal(err)
	}
	// D:PAI(A;OICI;FA;;;WD) — protected, but Everyone has full control.
	sd, err := windows.SecurityDescriptorFromString("D:PAI(A;OICI;FA;;;WD)")
	if err != nil {
		t.Fatal(err)
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		t.Fatal(err)
	}
	if err := windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION,
		nil, nil, dacl, nil); err != nil {
		t.Fatal(err)
	}
	if err := EnsurePrivateDir(path); err != nil {
		t.Fatalf("EnsurePrivateDir: %v", err)
	}
	got, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(got.String(), "(A;OICI;FA;;;WD)") {
		t.Fatalf("permissive Everyone ACE survived EnsurePrivateDir: %s", got.String())
	}
}

// The publish primitive on its own. installFile's other steps all worked on the
// lab host while this one returned ERROR_INVALID_PARAMETER, which made three
// higher-level tests fail and three concurrency tests pass vacuously. Exercise
// it directly so the failure is unambiguous and cannot hide again.
func TestRenameRelativePublishesUnderThePinnedParent(t *testing.T) {
	cases := []struct {
		name        string
		destination string
		seed        string
	}{
		{"replaces an existing destination", "target.txt", "old"},
		{"creates a destination that does not exist", "fresh.txt", ""},
		{"handles a long unicode name", "réstauré-ünïcode-name.txt", "old"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			base := t.TempDir()
			dest := filepath.Join(base, tc.destination)
			if tc.seed != "" {
				if err := os.WriteFile(dest, []byte(tc.seed), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			chain, err := openVerifiedDir(base, false, nil, 0)
			if err != nil {
				t.Fatal(err)
			}
			defer chain.close()

			handle, err := openRelativeComponent(chain.leaf(), "staged.tmp",
				windows.GENERIC_WRITE|windows.DELETE|windows.FILE_WRITE_ATTRIBUTES|windows.FILE_READ_ATTRIBUTES,
				windows.FILE_CREATE, ntFileOptions, nil)
			if err != nil {
				t.Fatalf("create relative temp: %v", err)
			}
			temp := os.NewFile(uintptr(handle), "staged.tmp")
			if _, err := temp.WriteString("published"); err != nil {
				t.Fatal(err)
			}
			if err := temp.Sync(); err != nil {
				t.Fatal(err)
			}
			if err := renameRelative(handle, chain.leaf(), tc.destination); err != nil {
				_ = temp.Close()
				t.Fatalf("renameRelative failed: %v", err)
			}
			if err := temp.Close(); err != nil {
				t.Fatal(err)
			}

			got, err := os.ReadFile(dest)
			if err != nil {
				t.Fatalf("destination missing after publish: %v", err)
			}
			if string(got) != "published" {
				t.Fatalf("destination content = %q, want published", got)
			}
			if _, err := os.Stat(filepath.Join(base, "staged.tmp")); !os.IsNotExist(err) {
				t.Fatalf("temporary name still exists after the rename: %v", err)
			}
		})
	}
}
