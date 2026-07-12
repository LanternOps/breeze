package collectors

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"io"
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
	output, err := cmd.Output()
	if ctx.Err() != nil {
		return nil, fmt.Errorf("%s timed out: %w", name, ctx.Err())
	}
	if len(output) > collectorCommandOutputLimit {
		return nil, fmt.Errorf("%s output too large", name)
	}
	return output, err
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
	output, err := cmd.CombinedOutput()
	if ctx.Err() != nil {
		return nil, fmt.Errorf("%s timed out: %w", name, ctx.Err())
	}
	if len(output) > collectorCommandOutputLimit {
		return nil, fmt.Errorf("%s output too large", name)
	}
	return output, err
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

// runCollectorBoundedOutput runs a command, streaming stdout through an
// io.LimitReader so at most collectorCommandOutputLimit+1 bytes are ever
// buffered. Unlike runCollectorLimitedOutput it does not silently truncate:
// output exceeding the limit is an error (matching runCollectorOutput's
// semantics but enforced BEFORE buffering, not post-hoc), and a non-zero exit
// or read failure is surfaced. Use for structured output (e.g. JSON) where a
// truncated payload would be garbage anyway.
func runCollectorBoundedOutput(timeout time.Duration, name string, args ...string) ([]byte, error) {
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
