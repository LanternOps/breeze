//go:build windows

package biosconfig

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os/exec"
	"time"

	"golang.org/x/sys/windows"

	"github.com/breeze-rmm/agent/internal/procspawn"
)

// RunReadOnlyPowerShell runs one of this package's constant read scripts with
// stdin as data. stdout is returned to the caller only; neither stdout nor
// stderr is logged or returned in an error, since either could carry a BIOS
// value that the allowlist has not yet filtered.
func RunReadOnlyPowerShell(ctx context.Context, script string, stdin []byte) ([]byte, error) {
	cmd := procspawn.CommandContext(ctx, "powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script)
	var stdout bytes.Buffer
	cmd.Stdout = &stdout
	if stdin != nil {
		cmd.Stdin = bytes.NewReader(stdin)
	}
	cmd.WaitDelay = 10 * time.Second
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if exit, ok := errors.AsType[*exec.ExitError](err); ok {
			return nil, fmt.Errorf("powershell exit %d", exit.ExitCode())
		}
		return nil, errors.New("powershell did not run")
	}
	return stdout.Bytes(), nil
}

// NativeArch is the machine's own architecture, read with IsWow64Process2:
// the Windows agent is amd64 and runs emulated on ARM64, so GOARCH is not it.
func NativeArch() string {
	var process, native uint16
	if err := windows.IsWow64Process2(windows.CurrentProcess(), &process, &native); err != nil {
		return "unknown"
	}
	return archOf(native)
}
