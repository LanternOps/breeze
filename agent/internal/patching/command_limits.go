package patching

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"regexp"
	"strings"
	"time"
)

const (
	patchScanTimeout      = 2 * time.Minute
	patchListTimeout      = 2 * time.Minute
	patchMutateTimeout    = 30 * time.Minute
	patchScannerLimit     = 1024 * 1024
	patchOutputLimit      = 16 * 1024
	patchFieldLimit       = 256
	patchDescriptionLimit = 1024
	patchResultItemLimit  = 5000
)

var validAptPkgName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9+._:@~-]{0,127}$`)
var validYumPkgName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9+._:@~-]{0,127}$`)
var validBrewPkgName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9+._/@-]{0,255}$`)

func commandOutputWithTimeout(timeout time.Duration, name string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, name, args...)
	output, err := cmd.Output()
	if ctx.Err() != nil {
		return nil, fmt.Errorf("%s timed out: %w", name, ctx.Err())
	}
	return output, err
}

func runCmdOutputWithTimeout(cmd *exec.Cmd, timeout time.Duration) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	timeoutCmd := exec.CommandContext(ctx, cmd.Path, cmd.Args[1:]...)
	timeoutCmd.Env = cmd.Env
	timeoutCmd.Dir = cmd.Dir
	output, err := timeoutCmd.Output()
	if ctx.Err() != nil {
		return nil, fmt.Errorf("%s timed out: %w", cmd.Path, ctx.Err())
	}
	return output, err
}

func commandCombinedOutputWithTimeout(timeout time.Duration, name string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, name, args...)
	output, err := cmd.CombinedOutput()
	if ctx.Err() != nil {
		return nil, fmt.Errorf("%s timed out: %w", name, ctx.Err())
	}
	return output, err
}

func runCmdCombinedOutputWithTimeout(cmd *exec.Cmd, timeout time.Duration) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	timeoutCmd := exec.CommandContext(ctx, cmd.Path, cmd.Args[1:]...)
	timeoutCmd.Env = cmd.Env
	timeoutCmd.Dir = cmd.Dir
	output, err := timeoutCmd.CombinedOutput()
	if ctx.Err() != nil {
		return nil, fmt.Errorf("%s timed out: %w", cmd.Path, ctx.Err())
	}
	return output, err
}

func newPatchScanner(output []byte) *bufio.Scanner {
	scanner := bufio.NewScanner(bytes.NewReader(output))
	scanner.Buffer(make([]byte, 0, 64*1024), patchScannerLimit)
	return scanner
}

func truncatePatchOutput(output []byte) string {
	text := strings.TrimSpace(string(output))
	if len(text) <= patchOutputLimit {
		return text
	}
	return strings.TrimSpace(text[:patchOutputLimit]) + "... [truncated]"
}

func truncatePatchField(value string) string {
	value = strings.TrimSpace(value)
	if len(value) <= patchFieldLimit {
		return value
	}
	return strings.TrimSpace(value[:patchFieldLimit]) + "... [truncated]"
}

func truncatePatchDescription(value string) string {
	value = strings.TrimSpace(value)
	if len(value) <= patchDescriptionLimit {
		return value
	}
	return strings.TrimSpace(value[:patchDescriptionLimit]) + "... [truncated]"
}

func validateAptPackageName(name string) error {
	if !validAptPkgName.MatchString(name) || strings.HasPrefix(name, "-") {
		return fmt.Errorf("invalid package name: %q", name)
	}
	return nil
}

func validateYumPackageName(name string) error {
	if !validYumPkgName.MatchString(name) || strings.HasPrefix(name, "-") {
		return fmt.Errorf("invalid package name: %q", name)
	}
	return nil
}

func validateBrewPackageName(name string) error {
	if !validBrewPkgName.MatchString(name) || strings.HasPrefix(name, "-") || strings.HasPrefix(name, "/") || strings.Contains(name, "..") {
		return fmt.Errorf("invalid package name: %q", name)
	}
	return nil
}

func validateConsoleUsername(username string) error {
	username = strings.TrimSpace(username)
	if username == "" || len(username) > 64 || strings.ContainsAny(username, " \t\r\n/\\") {
		return fmt.Errorf("invalid console username")
	}
	return nil
}
