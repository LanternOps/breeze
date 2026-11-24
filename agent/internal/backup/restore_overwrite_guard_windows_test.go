//go:build windows

package backup

import (
	"os"
	"path/filepath"
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
