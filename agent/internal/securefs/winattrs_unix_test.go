//go:build !windows

package securefs

import (
	"os"
	"testing"
	"time"
)

// TestInstallFileWithAttrsIgnoresWinAttrsOffWindows pins the cross-platform
// contract of #5407: a Windows manifest replayed onto Linux/macOS carries
// attributes the filesystem has no concept of, and that must be a silent
// drop — never an error, never a warning, never a changed mode.
func TestInstallFileWithAttrsIgnoresWinAttrsOffWindows(t *testing.T) {
	base := t.TempDir()
	const hiddenSystemSparse = uint32(0x0002 | 0x0004 | 0x0200)

	warnings, err := InstallFileWithAttrs(base, "file.txt", writeSource(t, "payload"), 0o640, time.Time{}, nil, hiddenSystemSparse)
	if err != nil {
		t.Fatalf("InstallFileWithAttrs: %v", err)
	}
	if len(warnings) != 0 {
		t.Fatalf("warnings = %v, want none", warnings)
	}
	info, err := os.Stat(base + "/file.txt")
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if info.Mode().Perm() != 0o640 {
		t.Fatalf("mode = %v, want 0640 (winAttrs must not disturb the Unix mode)", info.Mode().Perm())
	}
}

// TestApplyWinAttrsIsANoOpOffWindows: the pathname seam the BMR restore uses
// must not fail on a Unix target, even for a path that does not exist.
func TestApplyWinAttrsIsANoOpOffWindows(t *testing.T) {
	if err := ApplyWinAttrs(t.TempDir()+"/absent", 0x0002); err != nil {
		t.Fatalf("ApplyWinAttrs = %v, want nil off Windows", err)
	}
	if PreservedWinAttrs != 0 {
		t.Fatalf("PreservedWinAttrs = %#x, want 0 off Windows", PreservedWinAttrs)
	}
}
