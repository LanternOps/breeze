package patching

import (
	"runtime"
	"strings"
	"testing"
	"time"
)

// TestDefaultRunner exercises DefaultRunner against a trivial command that
// exists on every platform we build for, asserting stdout capture and a
// zero exit code. Kept OS-agnostic so it runs on darwin CI as well as
// Windows/Linux.
func TestDefaultRunner(t *testing.T) {
	name, args := trivialEchoCommand("hi")

	stdout, stderr, code, err := DefaultRunner(name, args, 10*time.Second)
	if err != nil {
		t.Fatalf("unexpected error: %v (stderr=%q)", err, stderr)
	}
	if code != 0 {
		t.Fatalf("expected exit code 0, got %d (stderr=%q)", code, stderr)
	}
	if !strings.Contains(stdout, "hi") {
		t.Fatalf("expected stdout to contain %q, got %q", "hi", stdout)
	}
}

// TestDefaultRunner_NonZeroExit asserts non-zero exit codes are surfaced via
// the returned exitCode, not err.
func TestDefaultRunner_NonZeroExit(t *testing.T) {
	name, args := failingCommand()

	_, _, code, err := DefaultRunner(name, args, 10*time.Second)
	if err != nil {
		t.Fatalf("expected nil err for a non-zero exit, got %v", err)
	}
	if code == 0 {
		t.Fatal("expected non-zero exit code")
	}
}

func trivialEchoCommand(msg string) (string, []string) {
	if runtime.GOOS == "windows" {
		return "cmd.exe", []string{"/C", "echo", msg}
	}
	return "/bin/echo", []string{msg}
}

func failingCommand() (string, []string) {
	if runtime.GOOS == "windows" {
		return "cmd.exe", []string{"/C", "exit", "3"}
	}
	return "/bin/sh", []string{"-c", "exit 3"}
}
