package patching

import (
	"bytes"
	"context"
	"errors"
	"os/exec"
	"time"
)

// DefaultRunner is the production cmdRunner: it runs name/args via os/exec
// under a context timeout, capturing stdout and stderr separately. Non-zero
// exit codes are reported via the returned exitCode, not err — err is
// reserved for cases where the command could not be started/waited on at
// all (e.g. binary not found, killed by context deadline). On Windows it
// hides the console window via hideWindowCmd so SYSTEM-context invocations
// don't flash a console.
func DefaultRunner(name string, args []string, timeout time.Duration) (string, string, int, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, name, args...)
	hideWindowCmd(cmd)

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err := cmd.Run()
	if err == nil {
		return stdout.String(), stderr.String(), 0, nil
	}

	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		return stdout.String(), stderr.String(), exitErr.ExitCode(), nil
	}

	return stdout.String(), stderr.String(), 0, err
}
