package backup

import (
	"path/filepath"
	"testing"
)

// windowsVolumeName mimics filepath.VolumeName's drive-letter handling on
// Windows (e.g. "C:") so the embedded-drive restore bug can be exercised on any
// host. filepath.VolumeName is a no-op off Windows, so without this injection a
// Linux/macOS CI run would assert the wrong (unstripped) behavior.
func windowsVolumeName(p string) string {
	if len(p) >= 2 && p[1] == ':' &&
		((p[0] >= 'A' && p[0] <= 'Z') || (p[0] >= 'a' && p[0] <= 'z')) {
		return p[:2]
	}
	return ""
}

func withWindowsVolumeName(t *testing.T) {
	t.Helper()
	orig := volumeName
	volumeName = windowsVolumeName
	t.Cleanup(func() { volumeName = orig })
}

func TestStripVolumeAndLeadingSeparators(t *testing.T) {
	withWindowsVolumeName(t)

	tests := []struct {
		name       string
		sourcePath string
		want       string
	}{
		{
			name:       "windows absolute path strips drive and leading separator",
			sourcePath: `C:\Users\alice\report.txt`,
			want:       `Users\alice\report.txt`,
		},
		{
			name:       "lowercase drive letter",
			sourcePath: `d:\data\file.bin`,
			want:       `data\file.bin`,
		},
		{
			name:       "unix absolute path strips leading slash (no volume)",
			sourcePath: `/home/alice/report.txt`,
			want:       `home/alice/report.txt`,
		},
		{
			name:       "relative path unchanged",
			sourcePath: `path_0/reports/config.json`,
			want:       `path_0/reports/config.json`,
		},
		{
			name:       "drive with no trailing separator",
			sourcePath: `C:file.txt`,
			want:       `file.txt`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := stripVolumeAndLeadingSeparators(tt.sourcePath); got != tt.want {
				t.Errorf("stripVolumeAndLeadingSeparators(%q) = %q, want %q", tt.sourcePath, got, tt.want)
			}
		})
	}
}

// TestResolveTargetPathStripsEmbeddedDrive reproduces the PR's failing case:
// restoring a Windows absolute source path under a Windows target base must not
// produce an embedded drive letter like "C:\restore\C:\Users\...". With the
// volume stripped, the file maps cleanly UNDER the target base.
func TestResolveTargetPathStripsEmbeddedDrive(t *testing.T) {
	withWindowsVolumeName(t)

	const targetBase = `C:\restore`
	const sourcePath = `C:\Users\alice\report.txt`

	got := resolveTargetPath(targetBase, sourcePath)

	// The result is a host-native join of targetBase + the volume-stripped
	// source, so compute the expectation with filepath.Join for GOOS-independence.
	want := filepath.Join(targetBase, `Users\alice\report.txt`)
	if got != want {
		t.Fatalf("resolveTargetPath(%q, %q) = %q, want %q", targetBase, sourcePath, got, want)
	}

	// Regression guard: the stripped source's drive letter must not survive into
	// the joined path a second time.
	if got == filepath.Join(targetBase, sourcePath) {
		t.Fatalf("embedded drive not stripped: %q contains the full source path", got)
	}
}
