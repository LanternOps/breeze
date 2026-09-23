package backup

import (
	"path/filepath"
	"testing"
)

func TestRestoreKey_WindowsShadowCopyPathUsesOriginalPath(t *testing.T) {
	withWindowsVolumeName(t)

	f := SnapshotFile{
		SourcePath:   `\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopy3\Users\a.txt`,
		OriginalPath: `C:\Users\a.txt`,
	}
	want := `Users\a.txt` // separators as recorded: exactly what resolveTargetPath joins under the base
	if got := RestoreKey(f); got != want {
		t.Errorf("RestoreKey(%+v) = %q, want %q", f, got, want)
	}
}

func TestRestoreKey_LinuxEntryUnaffected(t *testing.T) {
	f := SnapshotFile{SourcePath: "/etc/hostname"}
	want := "etc/hostname"
	if got := RestoreKey(f); got != want {
		t.Errorf("RestoreKey(%+v) = %q, want %q", f, got, want)
	}
}

func TestRestoreKey_NoVSS_WindowsSourcePathOnly(t *testing.T) {
	withWindowsVolumeName(t)
	f := SnapshotFile{SourcePath: `C:\Windows\System32\config\SYSTEM`}
	want := `Windows\System32\config\SYSTEM`
	if got := RestoreKey(f); got != want {
		t.Errorf("RestoreKey(%+v) = %q, want %q", f, got, want)
	}
}

// TestRestoreKey_MatchesResolveTargetPath pins the contract validate relies
// on: joining RestoreKey under a base gives exactly the path the restore
// loop wrote.
func TestRestoreKey_MatchesResolveTargetPath(t *testing.T) {
	withWindowsVolumeName(t)
	base := t.TempDir()
	for _, f := range []SnapshotFile{
		{SourcePath: "/etc/hostname"},
		{SourcePath: `C:\Users\a.txt`},
		{SourcePath: `\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopy3\x`, OriginalPath: `C:\x`},
		{SourcePath: "C:/Windows/System32/config/SYSTEM"},
	} {
		if got, want := filepath.Join(base, RestoreKey(f)), resolveTargetPath(base, restoreSourcePath(f)); got != want {
			t.Errorf("Join(base, RestoreKey(%+v)) = %q, restore writes %q", f, got, want)
		}
	}
}
