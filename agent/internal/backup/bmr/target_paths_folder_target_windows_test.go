//go:build windows

package bmr

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// On Windows a junction at a folder mapping's target is refused like a
// symlink: os.Lstat reports it as irregular, not as a directory.
func TestFolderTargetJunctionIsRefusedOnWindows(t *testing.T) {
	src := `C:\Users`
	parent, outside := t.TempDir(), t.TempDir()
	plantJunction(t, parent, "restore", outside)
	dst := filepath.Join(parent, "restore")
	manifest := contentManifest(`C:\Users\alice\doc.txt`)
	if _, err := planTargetPaths(manifest, map[string]string{src: dst}); err == nil || !strings.Contains(err.Error(), "not a directory") {
		t.Fatalf("plan err = %v, want the junction at the target refused", err)
	}

	// Write time: a junction that replaces the target after planning.
	real := filepath.Join(parent, "restore2")
	if err := os.Mkdir(real, 0o755); err != nil {
		t.Fatal(err)
	}
	cfg := RecoveryConfig{TargetPaths: map[string]string{src: real}}
	plan, err := planTargetPaths(manifest, cfg.TargetPaths)
	if err != nil {
		t.Fatalf("plan: %v", err)
	}
	if err := os.Remove(real); err != nil {
		t.Fatal(err)
	}
	plantJunction(t, parent, "restore2", outside)
	provider := &destRecorder{}
	_, _, warnings, failed, _ := restoreFiles(context.Background(), manifest, plan, cfg, provider)
	if failed != 1 || len(provider.dests) != 0 {
		t.Fatalf("failed=%d dests=%v warnings=%v, want the write refused", failed, provider.dests, warnings)
	}
}

// Below a folder mapping's target, a junction is refused like a symlink.
func TestFolderMappingJunctionBelowTargetIsRefusedOnWindows(t *testing.T) {
	dst, outside := t.TempDir(), t.TempDir()
	plantJunction(t, dst, "alice", outside)
	provider := &destRecorder{}
	cfg := RecoveryConfig{TargetPaths: map[string]string{`C:\Users`: dst}}
	_, _, warnings, failed, _ := restoreFilesPlanned(context.Background(), contentManifest(`C:\Users\alice\doc.txt`), cfg, provider)
	if failed != 1 || len(provider.dests) != 0 {
		t.Fatalf("failed=%d dests=%v warnings=%v, want the entry below the junction refused", failed, provider.dests, warnings)
	}
	if !strings.Contains(strings.Join(warnings, "\n"), "not a directory") {
		t.Fatalf("warnings = %v", warnings)
	}
}
