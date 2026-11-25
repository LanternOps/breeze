//go:build windows

package backup

import (
	"errors"
	"maps"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
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

// A link already beneath the target (left by an earlier run of the same
// restore) is followed only while it points at a local path: one that
// points elsewhere, directly or through a chain, is not followed, and
// nothing beneath it can be an original the restore writes through.
func TestDirIdentityCheck_DestinationLinkOffTheMachineIsNotFollowed(t *testing.T) {
	withWindowsPaths(t)
	dirs := map[string]string{`T:\restore`: "t", `C:\`: "c", `C:\data`: "cd", `T:\restore\data`: "td"}
	for name, links := range map[string]map[string]string{
		"direct": {`T:\restore\data\lnk`: `\\srv.invalid\share`},
		"chain":  {`T:\restore\data\lnk`: `T:\restore\hop\x`, `T:\restore\hop`: `\\srv.invalid\share`},
		"device": {`T:\restore\data\lnk`: `\Device\Mup\srv.invalid\share`},
	} {
		d := map[string]string{`C:\data\lnk`: "cl"}
		maps.Copy(d, dirs)
		c, r := newRecordingWindowsCheck(`T:\restore`, d, links)
		same, err := c.aliasesOriginal(`C:\data\lnk\x\y`)
		if err != nil || same {
			t.Errorf("%s: alias %v, %v; want not an overwrite", name, same, err)
		}
		for _, call := range r.calls {
			if strings.HasPrefix(call, "stat ") && strings.Contains(windowsKey(call), `\lnk`) {
				t.Errorf("%s: the link was followed: %v", name, r.calls)
				break
			}
		}
		if hits := r.touched("srv.invalid"); len(hits) > 0 {
			t.Errorf("%s: examined off the machine: %v", name, hits)
		}
	}
}

// The original's own directories are resolved the same way: a link there
// to a path that is not local is not followed.
func TestDirIdentityCheck_OriginalLinkOffTheMachineIsNotFollowed(t *testing.T) {
	withWindowsPaths(t)
	dirs := map[string]string{`T:\restore`: "t", `T:\restore\data`: "td", `T:\restore\data\sub`: "tds", `C:\`: "c"}
	c, r := newRecordingWindowsCheck(`T:\restore`, dirs, map[string]string{`C:\data`: `\\srv.invalid\share`})
	same, err := c.aliasesOriginal(`C:\data\sub\x`)
	if err != nil || same {
		t.Errorf("alias %v, %v; want not an overwrite", same, err)
	}
	for _, call := range r.calls {
		if strings.HasPrefix(call, "stat ") && strings.HasPrefix(windowsKey(strings.TrimPrefix(call, "stat ")), `c:\data`) {
			t.Errorf("the original's link was followed: %v", r.calls)
			break
		}
	}
	if hits := r.touched("srv.invalid"); len(hits) > 0 {
		t.Errorf("examined off the machine: %v", hits)
	}
}
