//go:build windows

package biosconfig

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/procspawn"
)

const dellReadTimeout = 60 * time.Second

func newDellAdapter() Adapter {
	return &dellAdapter{run: runPowerShell}
}

// runPowerShell runs a read-only script and returns its stdout.
func runPowerShell(ctx context.Context, script string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, dellReadTimeout)
	defer cancel()
	cmd := procspawn.CommandContext(ctx, "powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	cmd.WaitDelay = 10 * time.Second
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if exit, ok := errors.AsType[*exec.ExitError](err); ok {
			msg := strings.TrimSpace(stderr.String())
			if len(msg) > 300 {
				msg = msg[:300]
			}
			return nil, fmt.Errorf("powershell exit %d: %s", exit.ExitCode(), msg)
		}
		return nil, err
	}
	return stdout.Bytes(), nil
}
