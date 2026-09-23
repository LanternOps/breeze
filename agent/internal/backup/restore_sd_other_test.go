//go:build !windows

package backup

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/breeze-rmm/agent/internal/securefs"
)

// TestRestore_ManifestWithSecurityDescriptorsIgnoredOnLinux is R37: a
// manifest carrying a table (including a corrupt slot) and SDIndex values
// restores normally off Windows, never reaches applySecurity, and raises no
// security-descriptor warning. Tagged !windows: on Windows the fake 4-byte
// descriptor would (correctly) produce an apply warning.
func TestRestore_ManifestWithSecurityDescriptorsIgnoredOnLinux(t *testing.T) {
	provider, snapshotID := setupRestoreTestSnapshotWithSD(t,
		[]sdTestFile{
			{name: "motd", content: "hello", sourcePath: "/etc/motd", sdIndex: 1},
			{name: "hosts", content: "127.0.0.1", sourcePath: "/etc/hosts"},     // SDIndex 0
			{name: "fstab", content: "x", sourcePath: "/etc/fstab", sdIndex: 9}, // past the table
		},
		[]string{"AQIDBA==", "not-valid-base64!!"},
	)
	target := t.TempDir()
	origApplier := restoreSecurityApplier
	t.Cleanup(func() { restoreSecurityApplier = origApplier })
	calls := 0
	restoreSecurityApplier = func([]byte) (*securefs.SecurityApplier, error) { calls++; return nil, nil }

	result, err := RestoreFromSnapshot(provider, RestoreConfig{SnapshotID: snapshotID, TargetPath: target}, nil)
	if err != nil {
		t.Fatalf("RestoreFromSnapshot: %v", err)
	}
	if result.FilesRestored != 3 || result.FilesFailed != 0 {
		t.Fatalf("result = %+v, want 3 restored, 0 failed", result)
	}
	if calls != 0 {
		t.Errorf("the security applier was built %d times on a non-Windows restore", calls)
	}
	if w := sdWarnings(result.Warnings); len(w) != 0 {
		t.Errorf("unexpected security-descriptor warnings on a non-Windows restore: %q", w)
	}
	if _, err := os.Stat(filepath.Join(target, "etc", "motd")); err != nil {
		t.Errorf("restored file missing: %v", err)
	}
}
