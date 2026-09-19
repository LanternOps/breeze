package collectors

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os/exec"
	"strings"
	"time"
)

const (
	collectorShortCommandTimeout = 10 * time.Second
	collectorLongCommandTimeout  = 30 * time.Second
	collectorCommandOutputLimit  = 4 * 1024 * 1024
	collectorScannerLimit        = 1024 * 1024
	collectorFileReadLimit       = 1024 * 1024
	collectorStringLimit         = 512
	collectorResultLimit         = 5000
)

// utf8PowerShellCommand wraps a PowerShell command so its stdout is emitted as
// UTF-8. Without this, PowerShell renders output using the console OEM codepage
// (e.g. CP852 on Polish Windows), which Go then decodes as UTF-8 and corrupts
// non-Latin characters into U+FFFD. See issue #979.
func utf8PowerShellCommand(command string) string {
	return "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;" + command
}

func runCollectorOutput(timeout time.Duration, name string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	return runCollectorOutputWithContext(ctx, timeout, name, args...)
}

func runCollectorOutputWithContext(parent context.Context, timeout time.Duration, name string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, name, args...)
	output := &cappedBuffer{max: collectorCommandOutputLimit}
	stderr := &cappedBuffer{max: collectorStderrCaptureLimit}
	cmd.Stdout = output
	cmd.Stderr = stderr
	cmd.WaitDelay = collectorWaitDelay
	err := runCollectorCommand(cmd, name)
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		// Mirror exec.Cmd.Output so callers inspecting ExitError see stderr.
		exitErr.Stderr = stderr.buf.Bytes()
	}
	if ctx.Err() != nil {
		return nil, fmt.Errorf("%s timed out: %w", name, ctx.Err())
	}
	if output.exceeded {
		return nil, fmt.Errorf("%s output too large", name)
	}
	return output.buf.Bytes(), err
}

// collectorWaitDelay bounds how long Wait blocks on stdout/stderr pipes after
// the command itself has exited (a descendant may have inherited them).
const collectorWaitDelay = 10 * time.Second

// collectorStderrCaptureLimit caps the diagnostic stderr retained for
// ExitError.Stderr; stdout carries the payload, stderr only needs to be
// enough to explain a failure.
const collectorStderrCaptureLimit = 64 * 1024

// runCollectorCommand runs cmd and normalises exec.ErrWaitDelay. os/exec only
// returns that sentinel when the process exited successfully but a descendant
// still held an inherited pipe past WaitDelay. By then the copy goroutines have
// finished, so the captured output is complete and the command did not fail.
// Callers treat any error as command failure, so surfacing the sentinel would
// silently turn a benign orphaned handle into a permanent data gap (see
// change_tracker.go, which clones the previous snapshot on error).
func runCollectorCommand(cmd *exec.Cmd, name string) error {
	err := cmd.Run()
	if errors.Is(err, exec.ErrWaitDelay) && cmd.ProcessState != nil && cmd.ProcessState.Success() {
		slog.Warn("collector command exited but a descendant kept its output pipe open; output captured, pipe force-closed",
			"command", name, "waitDelay", collectorWaitDelay)
		return nil
	}
	return err
}

func runCollectorCombinedOutput(timeout time.Duration, name string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	return runCollectorCombinedOutputWithContext(ctx, timeout, name, args...)
}

func runCollectorCombinedOutputWithContext(parent context.Context, timeout time.Duration, name string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, name, args...)
	output := &cappedBuffer{max: collectorCommandOutputLimit}
	// os/exec serializes writes when Stdout and Stderr are the same writer.
	cmd.Stdout = output
	cmd.Stderr = output
	cmd.WaitDelay = collectorWaitDelay
	err := runCollectorCommand(cmd, name)
	if ctx.Err() != nil {
		return nil, fmt.Errorf("%s timed out: %w", name, ctx.Err())
	}
	if output.exceeded {
		return nil, fmt.Errorf("%s output too large", name)
	}
	return output.buf.Bytes(), err
}

// runCollectorLimitedOutput runs a command and reads up to collectorCommandOutputLimit
// bytes from stdout via a pipe, discarding the rest. Safe for line-based output
// where truncation is acceptable (e.g. pmset -g log).
func runCollectorLimitedOutput(timeout time.Duration, name string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, name, args...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("%s pipe failed: %w", name, err)
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("%s start failed: %w", name, err)
	}
	output, err := io.ReadAll(io.LimitReader(stdout, int64(collectorCommandOutputLimit)))
	if err != nil && ctx.Err() != nil {
		return nil, fmt.Errorf("%s timed out: %w", name, ctx.Err())
	}
	// Drain any remaining output so the process can exit cleanly.
	_, _ = io.Copy(io.Discard, stdout)
	_ = cmd.Wait()
	return output, nil
}

// cappedBuffer captures up to max bytes and discards the rest without ever
// failing the Write call, so the child process never sees a write error.
// exceeded records that the limit was hit so callers can still reject
// oversized output instead of consuming a silently truncated payload.
type cappedBuffer struct {
	buf      bytes.Buffer
	max      int
	exceeded bool
}

func (c *cappedBuffer) Write(p []byte) (int, error) {
	if len(p) > c.max-c.buf.Len() {
		c.exceeded = true
	}
	if remaining := c.max - c.buf.Len(); remaining > 0 {
		if len(p) > remaining {
			c.buf.Write(p[:remaining])
		} else {
			c.buf.Write(p)
		}
	}
	return len(p), nil
}

// runCollectorBoundedOutput runs a command, streaming stdout through an
// io.LimitReader so at most collectorCommandOutputLimit+1 bytes are ever
// buffered. Unlike runCollectorLimitedOutput it does not silently truncate:
// output exceeding the limit is an error (runCollectorOutput now bounds memory
// during capture too, but still runs the command to completion), and a non-zero exit
// or read failure is surfaced — with the command's (capped) stderr included so
// failures are diagnosable from agent logs. Use for structured output (e.g.
// JSON) where a truncated payload would be garbage anyway.
func runCollectorBoundedOutput(timeout time.Duration, name string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, name, args...)
	stderr := &cappedBuffer{max: 4 * 1024}
	cmd.Stderr = stderr
	// Insurance against an orphaned descendant inheriting the stdout pipe: if
	// the context is cancelled and the pipe is still open after this delay,
	// os/exec force-closes it so the ReadAll below can never block forever.
	cmd.WaitDelay = 10 * time.Second
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("%s pipe failed: %w", name, err)
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("%s start failed: %w", name, err)
	}
	// Read one byte past the limit so over-limit output is detectable without
	// buffering it.
	output, readErr := io.ReadAll(io.LimitReader(stdout, int64(collectorCommandOutputLimit)+1))
	// Drain any remaining output so the process can exit and be reaped.
	_, _ = io.Copy(io.Discard, stdout)
	waitErr := cmd.Wait()
	if ctx.Err() != nil {
		return nil, fmt.Errorf("%s timed out: %w", name, ctx.Err())
	}
	if readErr != nil {
		return nil, fmt.Errorf("%s read failed: %w", name, readErr)
	}
	if len(output) > collectorCommandOutputLimit {
		return nil, fmt.Errorf("%s output too large", name)
	}
	if waitErr != nil {
		if msg := strings.TrimSpace(stderr.buf.String()); msg != "" {
			return nil, fmt.Errorf("%s failed: %w (stderr: %s)", name, waitErr, truncateCollectorString(msg))
		}
		return nil, fmt.Errorf("%s failed: %w", name, waitErr)
	}
	return output, nil
}

func newCollectorScanner(output []byte) *bufio.Scanner {
	scanner := bufio.NewScanner(bytes.NewReader(output))
	scanner.Buffer(make([]byte, 0, 64*1024), collectorScannerLimit)
	return scanner
}

func truncateCollectorString(value string) string {
	value = strings.TrimSpace(value)
	if len(value) <= collectorStringLimit {
		return value
	}
	return strings.TrimSpace(value[:collectorStringLimit]) + "... [truncated]"
}
