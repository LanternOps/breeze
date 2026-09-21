//go:build windows

package securefs

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

func fileAttrs(t *testing.T, path string) uint32 {
	t.Helper()
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		t.Fatalf("UTF16PtrFromString: %v", err)
	}
	attrs, err := windows.GetFileAttributes(p)
	if err != nil {
		t.Fatalf("GetFileAttributes(%s): %v", path, err)
	}
	return attrs
}

// TestInstallFileWithAttrsRestoresHiddenSystemSparse is the regression test
// for #5407 itself: before the fix a byte-exact restore published every file
// as plain Archive, so Hidden and System vanished and a sparse file came back
// fully allocated. All three must now survive publication.
func TestInstallFileWithAttrsRestoresHiddenSystemSparse(t *testing.T) {
	base := t.TempDir()
	want := uint32(windows.FILE_ATTRIBUTE_HIDDEN | windows.FILE_ATTRIBUTE_SYSTEM | windows.FILE_ATTRIBUTE_SPARSE_FILE)

	warnings, err := InstallFileWithAttrs(base, "hidden.bin", writeSource(t, "payload"), 0o644, time.Time{}, nil, want)
	if err != nil {
		t.Fatalf("InstallFileWithAttrs: %v", err)
	}
	if len(warnings) != 0 {
		t.Fatalf("warnings = %v, want none on NTFS", warnings)
	}
	got := fileAttrs(t, filepath.Join(base, "hidden.bin"))
	for name, bit := range map[string]uint32{
		"HIDDEN":      windows.FILE_ATTRIBUTE_HIDDEN,
		"SYSTEM":      windows.FILE_ATTRIBUTE_SYSTEM,
		"SPARSE_FILE": windows.FILE_ATTRIBUTE_SPARSE_FILE,
	} {
		if got&bit == 0 {
			t.Errorf("restored file is missing FILE_ATTRIBUTE_%s (attrs=%#x)", name, got)
		}
	}
	if got&windows.FILE_ATTRIBUTE_NORMAL != 0 {
		t.Errorf("attrs=%#x still carries FILE_ATTRIBUTE_NORMAL, which is only valid standing alone", got)
	}
}

// TestInstallFileWithZeroAttrsMatchesLegacyBehavior: a pre-#5407 manifest
// (winAttrs absent → 0) must publish exactly as it did before — NORMAL, or
// READONLY when the mode says so.
func TestInstallFileWithZeroAttrsMatchesLegacyBehavior(t *testing.T) {
	base := t.TempDir()
	if _, err := InstallFileWithAttrs(base, "plain.bin", writeSource(t, "payload"), 0o644, time.Time{}, nil, 0); err != nil {
		t.Fatalf("InstallFileWithAttrs: %v", err)
	}
	if got := fileAttrs(t, filepath.Join(base, "plain.bin")); got&(windows.FILE_ATTRIBUTE_HIDDEN|windows.FILE_ATTRIBUTE_SYSTEM) != 0 {
		t.Fatalf("attrs = %#x, want no Hidden/System for a zero-winAttrs manifest", got)
	}
	if _, err := InstallFileWithAttrs(base, "ro.bin", writeSource(t, "payload"), 0o444, time.Time{}, nil, 0); err != nil {
		t.Fatalf("InstallFileWithAttrs(readonly): %v", err)
	}
	if got := fileAttrs(t, filepath.Join(base, "ro.bin")); got&windows.FILE_ATTRIBUTE_READONLY == 0 {
		t.Fatalf("attrs = %#x, want FILE_ATTRIBUTE_READONLY preserved from the mode", got)
	}
}

// TestInstallFileWithAttrsMasksUnsettableAttributes proves the manifest cannot
// smuggle in an attribute the restore never intended to honor: DIRECTORY on a
// regular file would be nonsense, and REPARSE_POINT is exactly what this
// package's pinning exists to keep out of a restore tree.
func TestInstallFileWithAttrsMasksUnsettableAttributes(t *testing.T) {
	base := t.TempDir()
	hostile := uint32(windows.FILE_ATTRIBUTE_DIRECTORY | windows.FILE_ATTRIBUTE_REPARSE_POINT | windows.FILE_ATTRIBUTE_HIDDEN)
	if _, err := InstallFileWithAttrs(base, "masked.bin", writeSource(t, "payload"), 0o644, time.Time{}, nil, hostile); err != nil {
		t.Fatalf("InstallFileWithAttrs: %v", err)
	}
	got := fileAttrs(t, filepath.Join(base, "masked.bin"))
	if got&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		t.Fatalf("attrs = %#x, REPARSE_POINT must never be honored from a manifest", got)
	}
	if got&windows.FILE_ATTRIBUTE_HIDDEN == 0 {
		t.Fatalf("attrs = %#x, the legitimate HIDDEN bit should still have been applied", got)
	}
	info, err := os.Stat(filepath.Join(base, "masked.bin"))
	if err != nil || info.IsDir() {
		t.Fatalf("stat = (%v, %v), want a regular file", info, err)
	}
}

// TestApplyWinAttrsByPathname covers the BMR restore's pathname seam.
func TestApplyWinAttrsByPathname(t *testing.T) {
	path := filepath.Join(t.TempDir(), "bmr.bin")
	if err := os.WriteFile(path, []byte("payload"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := ApplyWinAttrs(path, windows.FILE_ATTRIBUTE_HIDDEN|windows.FILE_ATTRIBUTE_SYSTEM); err != nil {
		t.Fatalf("ApplyWinAttrs: %v", err)
	}
	got := fileAttrs(t, path)
	if got&windows.FILE_ATTRIBUTE_HIDDEN == 0 || got&windows.FILE_ATTRIBUTE_SYSTEM == 0 {
		t.Fatalf("attrs = %#x, want Hidden|System", got)
	}
	if got&windows.FILE_ATTRIBUTE_NORMAL != 0 {
		t.Fatalf("attrs = %#x still carries NORMAL alongside other bits", got)
	}
}
