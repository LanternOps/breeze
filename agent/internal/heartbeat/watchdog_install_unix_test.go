//go:build linux || darwin

package heartbeat

import (
	"os"
	"path/filepath"
	"testing"
)

func TestReplaceWatchdogBinaryUnix_SwapsContentAndMode(t *testing.T) {
	dir := t.TempDir()
	dest := filepath.Join(dir, "breeze-watchdog")
	if err := os.WriteFile(dest, []byte("OLD watchdog"), 0o755); err != nil {
		t.Fatalf("seed dest: %v", err)
	}
	src := filepath.Join(dir, "downloaded.tmp")
	if err := os.WriteFile(src, []byte("NEW watchdog bytes"), 0o600); err != nil {
		t.Fatalf("seed src: %v", err)
	}

	if err := replaceWatchdogBinaryUnix(src, dest); err != nil {
		t.Fatalf("replaceWatchdogBinaryUnix: %v", err)
	}

	got, err := os.ReadFile(dest)
	if err != nil {
		t.Fatalf("read dest: %v", err)
	}
	if string(got) != "NEW watchdog bytes" {
		t.Fatalf("dest content = %q, want the new bytes", string(got))
	}

	fi, err := os.Stat(dest)
	if err != nil {
		t.Fatalf("stat dest: %v", err)
	}
	// Must be executable so the service manager can re-exec it — a non-exec
	// watchdog is exactly the fleet-stuck failure this feature exists to fix.
	if fi.Mode().Perm() != 0o755 {
		t.Fatalf("dest mode = %o, want 0755", fi.Mode().Perm())
	}

	// No staging file may be left behind on the success path.
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		name := e.Name()
		if name != "breeze-watchdog" && name != "downloaded.tmp" {
			t.Fatalf("unexpected leftover file in dir: %q", name)
		}
	}
}

func TestReplaceWatchdogBinaryUnix_MissingSourceLeavesNoStaging(t *testing.T) {
	dir := t.TempDir()
	dest := filepath.Join(dir, "breeze-watchdog")
	if err := os.WriteFile(dest, []byte("OLD"), 0o755); err != nil {
		t.Fatalf("seed dest: %v", err)
	}

	err := replaceWatchdogBinaryUnix(filepath.Join(dir, "does-not-exist"), dest)
	if err == nil {
		t.Fatal("expected error for missing source, got nil")
	}

	// dest must be untouched and no staging file left behind.
	got, _ := os.ReadFile(dest)
	if string(got) != "OLD" {
		t.Fatalf("dest content = %q, want it unchanged on failure", string(got))
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Fatalf("expected only dest to remain, found %d entries", len(entries))
	}
}
