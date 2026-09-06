package collectors

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime"
	"strconv"
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
	// than collectorCommandOutputLimit+1 bytes (issue #2390).
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
	if !c.exceeded {
		t.Fatal("over-limit writes were not recorded")
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

// TestCollectorCommandHelper is a portable subprocess, including on Windows.
func TestCollectorCommandHelper(t *testing.T) {
	args := os.Args
	for len(args) > 0 && args[0] != "collector-command-helper" {
		args = args[1:]
	}
	if len(args) == 0 {
		return
	}
	args = args[1:]
	if args[0] == "inherit" {
		cmd := exec.Command(os.Args[0], collectorHelperArgs("wait", args[1]+".ready")...)
		cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
		if err := cmd.Start(); err != nil {
			os.Exit(2)
		}
		if err := os.WriteFile(args[1], []byte(strconv.Itoa(cmd.Process.Pid)), 0600); err != nil {
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
			os.Exit(2)
		}
		// Output written before a clean exit must survive the pipe cleanup.
		_, _ = os.Stdout.WriteString("inherit-ok")
		os.Exit(0)
	}
	if args[0] == "wait" {
		// Signal readiness before blocking so cancellation tests kill a running child.
		if err := os.WriteFile(args[1], []byte("ready"), 0600); err != nil {
			os.Exit(2)
		}
		time.Sleep(time.Minute)
		os.Exit(0)
	}
	for i, stream := range []io.Writer{os.Stdout, os.Stderr} {
		n, err := strconv.Atoi(args[i])
		if err != nil {
			os.Exit(2)
		}
		chunk := bytes.Repeat([]byte{byte('a' + i)}, 32768)
		for n > 0 {
			count := min(n, len(chunk))
			if _, err := stream.Write(chunk[:count]); err != nil {
				os.Exit(2)
			}
			n -= count
		}
	}
	code, _ := strconv.Atoi(args[2])
	os.Exit(code)
}

func collectorHelperArgs(args ...string) []string {
	return append([]string{"-test.run=^TestCollectorCommandHelper$", "--", "collector-command-helper"}, args...)
}

func TestCollectorCommandCapture(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	for _, combined := range []bool{false, true} {
		for _, tc := range []struct {
			name                 string
			stdout, stderr, exit int
			tooLarge             bool
		}{
			{"empty", 0, 0, 0, false},
			{"small", 20, 30, 0, false},
			{"exact", collectorCommandOutputLimit, 0, 0, false},
			{"over", collectorCommandOutputLimit + 1, 0, 0, true},
			{"drain", collectorCommandOutputLimit * 3, collectorCommandOutputLimit * 3, 0, true},
			{"both_exact", collectorCommandOutputLimit / 2, collectorCommandOutputLimit / 2, 0, false},
			{"both_over", collectorCommandOutputLimit / 2, collectorCommandOutputLimit/2 + 1, 0, combined},
			{"failure", 20, 30, 3, false},
			{"large_stderr", 20, collectorCommandOutputLimit * 2, 3, combined},
		} {
			t.Run(fmt.Sprintf("combined=%v/%s", combined, tc.name), func(t *testing.T) {
				run := runCollectorOutputWithContext
				if combined {
					run = runCollectorCombinedOutputWithContext
				}
				out, err := run(context.Background(), 15*time.Second, exe, collectorHelperArgs(strconv.Itoa(tc.stdout), strconv.Itoa(tc.stderr), strconv.Itoa(tc.exit))...)
				if tc.tooLarge {
					if err == nil || !strings.Contains(err.Error(), "output too large") || out != nil {
						t.Fatalf("len(out)=%d, err=%v; want rejected oversized output", len(out), err)
					}
					return
				}
				want := bytes.Repeat([]byte("a"), tc.stdout)
				if combined {
					want = append(want, bytes.Repeat([]byte("b"), tc.stderr)...)
				}
				if (!combined && !bytes.Equal(out, want)) || (combined && (len(out) != len(want) || bytes.Count(out, []byte("a")) != tc.stdout || bytes.Count(out, []byte("b")) != tc.stderr)) {
					t.Fatalf("unexpected captured output: len=%d want=%d", len(out), len(want))
				}
				if tc.exit == 0 {
					if err != nil {
						t.Fatal(err)
					}
					return
				}
				var exitErr *exec.ExitError
				if !errors.As(err, &exitErr) || exitErr.ExitCode() != tc.exit {
					t.Fatalf("expected exit %d, got %v", tc.exit, err)
				}
				if combined {
					if len(exitErr.Stderr) != 0 {
						t.Fatal("combined error has separate stderr")
					}
				} else if want := min(tc.stderr, collectorStderrCaptureLimit); !bytes.Equal(exitErr.Stderr, bytes.Repeat([]byte("b"), want)) {
					t.Fatalf("stderr diagnostics wrong: len=%d want=%d", len(exitErr.Stderr), want)
				}
			})
		}
	}
}

func TestCollectorCommandCancellation(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	for _, combined := range []bool{false, true} {
		t.Run(fmt.Sprintf("combined=%v", combined), func(t *testing.T) {
			run := runCollectorOutputWithContext
			if combined {
				run = runCollectorCombinedOutputWithContext
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			ready := t.TempDir() + "/ready"
			done := make(chan error, 1)
			go func() {
				_, err := run(ctx, 15*time.Second, exe, collectorHelperArgs("wait", ready)...)
				done <- err
			}()
			deadline := time.Now().Add(10 * time.Second)
			for {
				if _, err := os.Stat(ready); err == nil {
					break
				}
				if time.Now().After(deadline) {
					t.Fatal("helper did not start")
				}
				time.Sleep(10 * time.Millisecond)
			}
			cancel()
			select {
			case err := <-done:
				if !errors.Is(err, context.Canceled) {
					t.Fatalf("expected canceled context, got %v", err)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("canceled child was not reaped promptly")
			}
			_, err := run(context.Background(), 100*time.Millisecond, exe, collectorHelperArgs("wait", ready)...)
			if !errors.Is(err, context.DeadlineExceeded) {
				t.Fatalf("expected timeout, got %v", err)
			}
		})
	}
}

func TestCappedBufferExactLimit(t *testing.T) {
	c := &cappedBuffer{max: 8}
	_, _ = c.Write([]byte("12345678"))
	_, _ = c.Write(nil)
	if c.exceeded {
		t.Fatal("exact-limit output rejected")
	}
}

func TestCollectorCommandInheritedPipeCleanup(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	for _, combined := range []bool{false, true} {
		t.Run(fmt.Sprintf("combined=%v", combined), func(t *testing.T) {
			t.Parallel()
			pidPath := t.TempDir() + "/descendant.pid"
			t.Cleanup(func() {
				data, err := os.ReadFile(pidPath)
				if err != nil {
					t.Error(err)
					return
				}
				pid, err := strconv.Atoi(string(data))
				if err != nil {
					t.Error(err)
					return
				}
				process, err := os.FindProcess(pid)
				if err != nil {
					t.Error(err)
					return
				}
				defer process.Release()
				if err := process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
					t.Error(err)
				}
			})
			run := runCollectorOutputWithContext
			if combined {
				run = runCollectorCombinedOutputWithContext
			}
			start := time.Now()
			out, err := run(context.Background(), 25*time.Second, exe, collectorHelperArgs("inherit", pidPath)...)
			// The command exited 0 and its output was fully captured; a descendant
			// holding the pipe is a cleanup concern, not a command failure.
			if err != nil {
				t.Fatalf("expected success after inherited pipe cleanup, got %v", err)
			}
			if string(out) != "inherit-ok" {
				t.Fatalf("captured output lost: %q", out)
			}
			if time.Since(start) < 5*time.Second {
				t.Fatal("WaitDelay cleanup did not engage; descendant pipe was not inherited")
			}
		})
	}
}
