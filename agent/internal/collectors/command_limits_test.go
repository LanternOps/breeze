package collectors

import (
	"fmt"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestTruncateCollectorString(t *testing.T) {
	t.Parallel()

	short := "hello"
	if got := truncateCollectorString(short); got != short {
		t.Fatalf("truncateCollectorString(short) = %q", got)
	}

	long := strings.Repeat("x", collectorStringLimit+10)
	got := truncateCollectorString(long)
	if !strings.Contains(got, "[truncated]") {
		t.Fatalf("truncateCollectorString(long) = %q", got)
	}
}

func requirePOSIXShell(t *testing.T) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("requires a POSIX shell")
	}
}

func TestRunCollectorBoundedOutputEnforcesLimitPreBuffering(t *testing.T) {
	requirePOSIXShell(t)
	t.Parallel()

	// Emit well past the cap. The bounded runner reads through an
	// io.LimitReader, so it must reject the output while never buffering more
	// than collectorCommandOutputLimit+1 bytes — unlike the post-hoc check in
	// runCollectorOutput, which buffers the entire stream first (issue #2390).
	emit := collectorCommandOutputLimit * 4
	_, err := runCollectorBoundedOutput(30*time.Second, "/bin/sh", "-c",
		fmt.Sprintf("head -c %d /dev/zero", emit))
	if err == nil {
		t.Fatal("expected over-limit output to be rejected")
	}
	if !strings.Contains(err.Error(), "output too large") {
		t.Fatalf("expected output-too-large error, got: %v", err)
	}
}

func TestRunCollectorBoundedOutputReturnsSmallOutput(t *testing.T) {
	requirePOSIXShell(t)
	t.Parallel()

	out, err := runCollectorBoundedOutput(30*time.Second, "/bin/sh", "-c", "printf hello")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if string(out) != "hello" {
		t.Fatalf("output = %q, want %q", out, "hello")
	}

	// Output exactly at the limit is allowed.
	out, err = runCollectorBoundedOutput(30*time.Second, "/bin/sh", "-c",
		fmt.Sprintf("head -c %d /dev/zero", collectorCommandOutputLimit))
	if err != nil {
		t.Fatalf("unexpected error at exact limit: %v", err)
	}
	if len(out) != collectorCommandOutputLimit {
		t.Fatalf("len(output) = %d, want %d", len(out), collectorCommandOutputLimit)
	}
}

func TestRunCollectorBoundedOutputSurfacesCommandFailure(t *testing.T) {
	requirePOSIXShell(t)
	t.Parallel()

	// Unlike runCollectorLimitedOutput (which swallows Wait errors), the
	// bounded runner must not silently return partial output from a command
	// that failed.
	_, err := runCollectorBoundedOutput(30*time.Second, "/bin/sh", "-c", "printf partial; exit 3")
	if err == nil {
		t.Fatal("expected non-zero exit to surface as an error")
	}
}

func TestRunCollectorBoundedOutputIncludesStderrOnFailure(t *testing.T) {
	requirePOSIXShell(t)
	t.Parallel()

	// Failure diagnostics (e.g. `log show` predicate complaints) go to stderr;
	// the runner must surface them so agent Warn logs are debuggable.
	_, err := runCollectorBoundedOutput(30*time.Second, "/bin/sh", "-c",
		"echo 'bad predicate near foo' >&2; exit 64")
	if err == nil {
		t.Fatal("expected non-zero exit to surface as an error")
	}
	if !strings.Contains(err.Error(), "bad predicate near foo") {
		t.Fatalf("expected stderr in error message, got: %v", err)
	}
}

func TestCappedBufferStopsAtMax(t *testing.T) {
	t.Parallel()

	c := &cappedBuffer{max: 8}
	for i := 0; i < 10; i++ {
		n, err := c.Write([]byte("abcd"))
		if n != 4 || err != nil {
			t.Fatalf("Write = (%d, %v), want (4, nil)", n, err)
		}
	}
	if got := c.buf.String(); got != "abcdabcd" {
		t.Fatalf("captured %q, want %q", got, "abcdabcd")
	}
}

func TestRunCollectorBoundedOutputTimesOut(t *testing.T) {
	requirePOSIXShell(t)
	t.Parallel()

	_, err := runCollectorBoundedOutput(200*time.Millisecond, "/bin/sh", "-c", "sleep 5")
	if err == nil || !strings.Contains(err.Error(), "timed out") {
		t.Fatalf("expected timeout error, got: %v", err)
	}
}
