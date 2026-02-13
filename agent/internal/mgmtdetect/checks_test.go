package mgmtdetect

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestCheckFileExists(t *testing.T) {
	tmp := filepath.Join(t.TempDir(), "testfile")
	if err := os.WriteFile(tmp, []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}

	snap := &processSnapshot{names: make(map[string]bool)}
	d := &checkDispatcher{processSnap: snap}

	if !d.evaluate(Check{Type: CheckFileExists, Value: tmp}) {
		t.Error("should find existing file")
	}
	if d.evaluate(Check{Type: CheckFileExists, Value: "/nonexistent/path/xyz"}) {
		t.Error("should not find nonexistent file")
	}
}

func TestEvaluateProcessRunning(t *testing.T) {
	snap := &processSnapshot{names: map[string]bool{"testproc": true}}
	d := &checkDispatcher{processSnap: snap}

	c := Check{Type: CheckProcessRunning, Value: "testproc"}
	if !d.evaluate(c) {
		t.Error("expected true for running process")
	}

	c2 := Check{Type: CheckProcessRunning, Value: "notrunning"}
	if d.evaluate(c2) {
		t.Error("expected false for non-running process")
	}
}

func TestEvaluateCommand(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("echo command test uses unix shell semantics")
	}

	d := &checkDispatcher{processSnap: &processSnapshot{names: make(map[string]bool)}}

	// Command succeeds, no parse -> true
	c1 := Check{Type: CheckCommand, Value: "echo hello"}
	if !d.evaluate(c1) {
		t.Error("expected true for successful command")
	}

	// Command succeeds, matching parse -> true
	c2 := Check{Type: CheckCommand, Value: "echo hello world", Parse: "hello"}
	if !d.evaluate(c2) {
		t.Error("expected true for matching parse")
	}

	// Command succeeds, non-matching parse -> false
	c3 := Check{Type: CheckCommand, Value: "echo hello", Parse: "xyz"}
	if d.evaluate(c3) {
		t.Error("expected false for non-matching parse")
	}

	// Command fails (false command returns exit code 1) -> false
	c4 := Check{Type: CheckCommand, Value: "false"}
	if d.evaluate(c4) {
		t.Error("expected false for failing command")
	}

	// Empty command -> false
	c5 := Check{Type: CheckCommand, Value: ""}
	if d.evaluate(c5) {
		t.Error("expected false for empty command")
	}
}

func TestEvaluateOSFilter(t *testing.T) {
	d := &checkDispatcher{processSnap: &processSnapshot{names: make(map[string]bool)}}
	c := Check{Type: CheckFileExists, Value: "/", OS: "nonexistent_os"}
	if d.evaluate(c) {
		t.Error("expected false for wrong OS")
	}
}

func TestEvaluateOSFilterMatches(t *testing.T) {
	d := &checkDispatcher{processSnap: &processSnapshot{names: make(map[string]bool)}}
	// With correct OS and existing file, should match
	c := Check{Type: CheckFileExists, Value: "/", OS: runtime.GOOS}
	if !d.evaluate(c) {
		t.Error("expected true for correct OS with existing path")
	}
}

func TestEvaluateUnknownCheckType(t *testing.T) {
	d := &checkDispatcher{processSnap: &processSnapshot{names: make(map[string]bool)}}
	c := Check{Type: CheckType("unknown_type"), Value: "test"}
	if d.evaluate(c) {
		t.Error("expected false for unknown check type")
	}
}
