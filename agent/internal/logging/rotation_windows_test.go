//go:build windows

package logging

import (
	"os"
	"path/filepath"
	"testing"
)

// These tests exercise the Windows platform helpers, which intentionally
// retain the agent's pre-existing os.OpenFile-based behavior: no
// no-follow/regular-file/chmod hardening (that hardening is Unix-specific,
// see rotation_unix.go and rotation_unix_test.go). They can only run on the
// Windows CI runner; `GOOS=windows GOARCH=amd64 go test -exec=true` only
// verifies this file compiles for Windows, it does not execute it.

func TestSecureLogDirectoryCreatesDirectory(t *testing.T) {
	base := t.TempDir()
	dir := filepath.Join(base, "logs")

	if err := secureLogDirectory(dir); err != nil {
		t.Fatalf("secureLogDirectory: %v", err)
	}

	info, err := os.Stat(dir)
	if err != nil {
		t.Fatalf("stat log dir: %v", err)
	}
	if !info.IsDir() {
		t.Fatalf("expected %s to be a directory", dir)
	}
}

func TestOpenSecureLogFileCreatesAndAppends(t *testing.T) {
	base := t.TempDir()
	logPath := filepath.Join(base, "agent.log")

	f, err := openSecureLogFile(logPath)
	if err != nil {
		t.Fatalf("openSecureLogFile: %v", err)
	}
	if _, err := f.WriteString("first\n"); err != nil {
		_ = f.Close()
		t.Fatalf("write: %v", err)
	}
	if err := f.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}

	f2, err := openSecureLogFile(logPath)
	if err != nil {
		t.Fatalf("openSecureLogFile (reopen): %v", err)
	}
	if _, err := f2.WriteString("second\n"); err != nil {
		_ = f2.Close()
		t.Fatalf("write: %v", err)
	}
	_ = f2.Close()

	got, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatalf("read log file: %v", err)
	}
	want := "first\nsecond\n"
	if string(got) != want {
		t.Fatalf("expected append semantics; got %q, want %q", got, want)
	}
}

func TestRepairLogFileModeIsNoOp(t *testing.T) {
	base := t.TempDir()
	logPath := filepath.Join(base, "agent.log")

	f, err := openSecureLogFile(logPath)
	if err != nil {
		t.Fatalf("openSecureLogFile: %v", err)
	}
	defer func() { _ = f.Close() }()

	if err := repairLogFileMode(f); err != nil {
		t.Fatalf("expected repairLogFileMode to be a no-op on Windows, got %v", err)
	}
}

func TestValidateRotationPathIsNoOp(t *testing.T) {
	base := t.TempDir()
	// A path that doesn't exist, and one that does — both must be a no-op
	// on Windows since rotation-path symlink rejection is Unix-specific.
	missing := filepath.Join(base, "agent.log.1")
	if err := validateRotationPath(missing); err != nil {
		t.Fatalf("expected nil for a missing path, got %v", err)
	}

	existing := filepath.Join(base, "agent.log.2")
	if err := os.WriteFile(existing, []byte("data"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := validateRotationPath(existing); err != nil {
		t.Fatalf("expected nil for an existing regular path, got %v", err)
	}
}

// TestRotatingWriterRotatesAndKeepsBackups is a basic end-to-end check that
// rotation sequencing in rotation.go still works correctly against the
// unhardened Windows helpers — i.e. the shared sequencing logic didn't
// regress Windows behavior when the platform helpers were split out.
func TestRotatingWriterRotatesAndKeepsBackups(t *testing.T) {
	base := t.TempDir()
	logPath := filepath.Join(base, "agent.log")

	rw := &RotatingWriter{filePath: logPath, maxSize: 4, maxBackups: 2}
	if err := rw.openFile(); err != nil {
		t.Fatalf("openFile: %v", err)
	}
	defer func() { _ = rw.Close() }()

	if _, err := rw.Write([]byte("12345")); err != nil { // > maxSize(4), triggers rotate
		t.Fatalf("write: %v", err)
	}

	if _, err := os.Stat(logPath + ".1"); err != nil {
		t.Fatalf("expected backup .1 to exist: %v", err)
	}
	if _, err := os.Stat(logPath); err != nil {
		t.Fatalf("expected a fresh current log to exist: %v", err)
	}
}
