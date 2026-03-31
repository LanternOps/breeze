package collectors

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
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
