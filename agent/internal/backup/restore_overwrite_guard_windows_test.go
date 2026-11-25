//go:build windows

package backup

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"

	"golang.org/x/sys/windows"
)

// On Windows a volume root has spellings the lexical check cannot equate
// with its drive letter: the volume GUID path, above all. File identity
// catches them, and the `\\?\` form is caught either way (#12638).
func TestOverwritesOriginals_WindowsVolumeAliases(t *testing.T) {
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	original := filepath.Join(dir, "docs", "x.txt")
	if err := os.MkdirAll(filepath.Dir(original), 0o755); err != nil {
		t.Fatal(err)
	}
	root := filepath.VolumeName(original) + `\`
	rootUTF16, err := windows.UTF16PtrFromString(root)
	if err != nil {
		t.Fatal(err)
	}
	guid := make([]uint16, windows.MAX_PATH)
	if err := windows.GetVolumeNameForVolumeMountPoint(rootUTF16, &guid[0], uint32(len(guid))); err != nil {
		t.Fatalf("volume GUID path of %s: %v", root, err)
	}
	for _, target := range []string{root, `\\?\` + root, windows.UTF16ToString(guid)} {
		if _, count, err := overwritesOriginals(target, []string{original}); err != nil || count != 1 {
			t.Errorf("target %q for %s: count %d, %v; want 1", target, original, count, err)
		}
	}
	if _, count, err := overwritesOriginals(t.TempDir(), []string{original}); err != nil || count != 0 {
		t.Errorf("plain new folder: count %d, %v; want 0", count, err)
	}
}

// A junction to the volume root is the root under another name: file
// identity catches it, as a symlink to / is caught on POSIX.
func TestOverwritesOriginals_WindowsJunctionAlias(t *testing.T) {
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	original := filepath.Join(dir, "docs", "x.txt")
	if err := os.MkdirAll(filepath.Dir(original), 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(t.TempDir(), "rootjunction")
	root := filepath.VolumeName(original) + `\`
	if out, err := exec.Command("cmd", "/c", "mklink", "/J", link, root).CombinedOutput(); err != nil {
		t.Fatalf("mklink /J %s %s: %v: %s", link, root, err, out)
	}
	t.Cleanup(func() { _ = os.Remove(link) })
	if _, count, err := overwritesOriginals(link, []string{original}); err != nil || count != 1 {
		t.Fatalf("junction to %s: count %d, %v; want 1", root, count, err)
	}
}

// A drive with no media or an unreachable share is not an original that a
// destination could be: it must not refuse a restore. A denied one must.
func TestOverwritesOriginals_WindowsUnreachableVolume(t *testing.T) {
	for _, code := range []windows.Errno{windows.ERROR_NOT_READY, windows.ERROR_BAD_NET_NAME} {
		if !unreachableVolume(&os.PathError{Op: "stat", Path: `E:\`, Err: syscall.Errno(code)}) {
			t.Errorf("%v (%d): want unreachable", code, code)
		}
	}
	if unreachableVolume(&os.PathError{Op: "stat", Path: `E:\`, Err: syscall.Errno(windows.ERROR_ACCESS_DENIED)}) {
		t.Error("access denied: want not unreachable (fail closed)")
	}
	if unreachableVolume(errors.New("other")) {
		t.Error("a non-errno error: want not unreachable (fail closed)")
	}
}
