//go:build windows

package wakeconfig

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

const collectTimeout = 60 * time.Second

// CollectWindows reads fast startup and the wired adapters' wake settings in
// one PowerShell call.
func CollectWindows(ctx context.Context) (*WindowsReadings, error) {
	ctx, cancel := context.WithTimeout(ctx, collectTimeout)
	defer cancel()
	cmd := procspawn.CommandContext(ctx, "powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", readScript)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	cmd.WaitDelay = 10 * time.Second
	if err := cmd.Run(); err != nil {
		var exit *exec.ExitError
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if errors.As(err, &exit) {
			return nil, fmt.Errorf("powershell exit %d: %s", exit.ExitCode(), strings.TrimSpace(truncate(stderr.String(), 300)))
		}
		return nil, err
	}
	return ParseWindowsReadings(bytes.TrimPrefix(bytes.TrimSpace(stdout.Bytes()), []byte("\xef\xbb\xbf")))
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
