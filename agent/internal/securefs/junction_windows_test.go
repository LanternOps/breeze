//go:build windows

package securefs

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/windows"
)

// readJunctionTarget reads link's reparse data without following it.
func readJunctionTarget(t *testing.T, link string) string {
	t.Helper()
	p, err := windows.UTF16PtrFromString(link)
	if err != nil {
		t.Fatal(err)
	}
	h, err := windows.CreateFile(p, 0, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		nil, windows.OPEN_EXISTING, windows.FILE_FLAG_OPEN_REPARSE_POINT|windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		t.Fatalf("open %s: %v", link, err)
	}
	defer windows.CloseHandle(h)
	buf := make([]byte, windows.MAXIMUM_REPARSE_DATA_BUFFER_SIZE)
	var n uint32
	if err := windows.DeviceIoControl(h, windows.FSCTL_GET_REPARSE_POINT, nil, 0, &buf[0], uint32(len(buf)), &n, nil); err != nil {
		t.Fatalf("FSCTL_GET_REPARSE_POINT %s: %v", link, err)
	}
	target, ok := junctionTargetFromBuffer(buf[:n])
	if !ok {
		t.Fatalf("%s is not a junction", link)
	}
	return target
}

// A junction InstallJunction creates is a real IO_REPARSE_TAG_MOUNT_POINT that
// resolves to its target, carries the requested Hidden/System attributes, and
// is recognised as already-correct on a resumed restore.
func TestInstallJunctionOnWindows(t *testing.T) {
	base := t.TempDir()
	target := filepath.Join(base, "Music")
	if err := os.Mkdir(target, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(target, "song.txt"), []byte("la"), 0o600); err != nil {
		t.Fatal(err)
	}
	attrs := uint32(windows.FILE_ATTRIBUTE_HIDDEN | windows.FILE_ATTRIBUTE_SYSTEM)
	warnings, err := InstallJunction(base, `Documents\My Music`, target, attrs)
	if err != nil || len(warnings) != 0 {
		t.Fatalf("InstallJunction: warnings=%v err=%v", warnings, err)
	}
	link := filepath.Join(base, "Documents", "My Music")
	if got := readJunctionTarget(t, link); !strings.EqualFold(got, target) {
		t.Fatalf("junction target = %q, want %q", got, target)
	}
	if data, err := os.ReadFile(filepath.Join(link, "song.txt")); err != nil || string(data) != "la" {
		t.Fatalf("junction does not resolve to its target: %q %v", data, err)
	}
	p, _ := windows.UTF16PtrFromString(link)
	got, err := windows.GetFileAttributes(p)
	if err != nil {
		t.Fatal(err)
	}
	if got&attrs != attrs || got&windows.FILE_ATTRIBUTE_REPARSE_POINT == 0 {
		t.Fatalf("attributes = %#x, want Hidden|System on a reparse point", got)
	}

	// Resume: the same junction again is a no-op.
	if _, err := InstallJunction(base, `Documents\My Music`, target, attrs); err != nil {
		t.Fatalf("re-installing an identical junction must succeed: %v", err)
	}
}

// Anything already at the junction's name that is not that exact junction is
// refused and left in place: a junction elsewhere, a real directory, a file.
func TestInstallJunctionRefusesToReplaceOnWindows(t *testing.T) {
	base := t.TempDir()
	target := filepath.Join(base, "target")
	other := filepath.Join(base, "other")
	for _, d := range []string{target, other, filepath.Join(base, "realdir")} {
		if err := os.Mkdir(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(base, "file"), []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	mkJunction(t, filepath.Join(base, "elsewhere"), other)

	for _, name := range []string{"elsewhere", "realdir", "file"} {
		if _, err := InstallJunction(base, name, target, 0); err == nil {
			t.Errorf("InstallJunction replaced the existing %q", name)
		}
	}
	if got := readJunctionTarget(t, filepath.Join(base, "elsewhere")); !strings.EqualFold(got, other) {
		t.Fatalf("the existing junction was retargeted to %q", got)
	}
	if data, err := os.ReadFile(filepath.Join(base, "file")); err != nil || string(data) != "keep" {
		t.Fatalf("the existing file was disturbed: %q %v", data, err)
	}
	// A junction made by mklink /J to the same target counts as already done.
	mkJunction(t, filepath.Join(base, "same"), target)
	if _, err := InstallJunction(base, "same", target, 0); err != nil {
		t.Fatalf("an mklink junction to the same target must be accepted as-is: %v", err)
	}
}

// The parent walk refuses a reparse point, so a junction is never created
// through an ancestor an earlier pass linked away.
func TestInstallJunctionRefusesReparseAncestorOnWindows(t *testing.T) {
	base := t.TempDir()
	outside := t.TempDir()
	mkJunction(t, filepath.Join(base, "linked"), outside)
	if _, err := InstallJunction(base, `linked\My Music`, `C:\Users`, 0); err == nil {
		t.Fatal("a junction was created through a junctioned ancestor")
	}
	if _, err := os.Lstat(filepath.Join(outside, "My Music")); err == nil {
		t.Fatal("the junction landed outside the restore location")
	}
}

func TestEnsureNoReparsePointsAlongOnWindows(t *testing.T) {
	base := t.TempDir()
	outside := t.TempDir()
	if err := os.MkdirAll(filepath.Join(base, "real", "deeper"), 0o755); err != nil {
		t.Fatal(err)
	}
	mkJunction(t, filepath.Join(base, "real", "jn"), outside)

	if err := EnsureNoReparsePointsAlong(base, `real\deeper\not-yet`); err != nil {
		t.Fatalf("an all-real path (missing tail) must pass: %v", err)
	}
	if err := EnsureNoReparsePointsAlong(base, `real\jn\x`); err == nil {
		t.Fatal("a path through a junction must be refused")
	}
	if err := EnsureNoReparsePointsAlong(base, `real\jn`); err == nil {
		t.Fatal("a path ending at a junction must be refused")
	}
}
