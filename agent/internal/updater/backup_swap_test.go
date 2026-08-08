package updater

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSwapCompanionBinary_SwapsContentModeAndCleansUpTemp(t *testing.T) {
	dir := t.TempDir()
	dest := filepath.Join(dir, "breeze-backup")
	if err := os.WriteFile(dest, []byte("OLD backup"), 0o755); err != nil {
		t.Fatalf("seed dest: %v", err)
	}
	src := filepath.Join(dir, "downloaded.tmp")
	if err := os.WriteFile(src, []byte("NEW backup bytes"), 0o600); err != nil {
		t.Fatalf("seed src: %v", err)
	}

	pair := &BinaryPair{Temp: src, Target: dest}
	if err := swapCompanionBinary(pair); err != nil {
		t.Fatalf("swapCompanionBinary: %v", err)
	}

	got, err := os.ReadFile(dest)
	if err != nil {
		t.Fatalf("read dest: %v", err)
	}
	if string(got) != "NEW backup bytes" {
		t.Fatalf("dest content = %q, want the new bytes", string(got))
	}

	fi, err := os.Stat(dest)
	if err != nil {
		t.Fatalf("stat dest: %v", err)
	}
	if fi.Mode().Perm() != 0o755 {
		t.Fatalf("dest mode = %o, want 0755", fi.Mode().Perm())
	}

	// The source temp file is consumed on success.
	if _, err := os.Stat(src); !os.IsNotExist(err) {
		t.Fatalf("expected src temp to be removed after a successful swap, stat err=%v", err)
	}

	// No staging file may be left behind.
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if e.Name() != "breeze-backup" {
			t.Fatalf("unexpected leftover file in dir: %q", e.Name())
		}
	}
}

func TestSwapCompanionBinary_MissingSourceLeavesDestIntactAndNoStaging(t *testing.T) {
	dir := t.TempDir()
	dest := filepath.Join(dir, "breeze-backup")
	if err := os.WriteFile(dest, []byte("OLD"), 0o755); err != nil {
		t.Fatalf("seed dest: %v", err)
	}

	pair := &BinaryPair{Temp: filepath.Join(dir, "does-not-exist"), Target: dest}
	if err := swapCompanionBinary(pair); err == nil {
		t.Fatal("expected error for missing source, got nil")
	}

	got, err := os.ReadFile(dest)
	if err != nil {
		t.Fatalf("dest must still exist after a failed swap: %v", err)
	}
	if string(got) != "OLD" {
		t.Fatalf("dest content = %q, want it unchanged on failure", string(got))
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Fatalf("expected only dest to remain, found %d entries", len(entries))
	}
}

// TestSwapCompanionBinary_CrossDirectory verifies the staging file is created
// in Target's directory (not Temp's) — this is what makes the final rename
// same-filesystem even when Temp lives in a different OS temp mount than
// Target's install directory, which is the normal case in production
// (DownloadBinary uses os.CreateTemp("", ...)).
func TestSwapCompanionBinary_CrossDirectory(t *testing.T) {
	srcDir := t.TempDir()
	destDir := t.TempDir()
	src := filepath.Join(srcDir, "downloaded.tmp")
	if err := os.WriteFile(src, []byte("cross-dir bytes"), 0o600); err != nil {
		t.Fatalf("seed src: %v", err)
	}
	dest := filepath.Join(destDir, "breeze-backup")

	pair := &BinaryPair{Temp: src, Target: dest}
	if err := swapCompanionBinary(pair); err != nil {
		t.Fatalf("swapCompanionBinary: %v", err)
	}
	got, err := os.ReadFile(dest)
	if err != nil {
		t.Fatalf("read dest: %v", err)
	}
	if string(got) != "cross-dir bytes" {
		t.Fatalf("dest content = %q, want the new bytes", string(got))
	}
}
