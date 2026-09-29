//go:build windows

package timesync

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"path/filepath"
	"time"

	"github.com/breeze-rmm/agent/internal/remote/tools"
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

func NewWriter() Writer {
	return &commandWriter{run: runTimeCommand, poll: writeTimePoll, start: startTimeService, zone: windowsZoneExists}
}
func runTimeCommand(parent context.Context, name string, args ...string) (int, error) {
	ctx, cancel := context.WithTimeout(parent, 10*time.Second)
	defer cancel()
	dir, err := windows.GetSystemDirectory()
	if err != nil {
		return 1, err
	}
	// Fixed filenames supplied only by commandWriter; never a policy-controlled path.
	cmd := exec.CommandContext(ctx, filepath.Join(dir, name), args...)
	cmd.WaitDelay = time.Second
	// Output is neither needed nor parsed; nil streams go to the null device.
	err = cmd.Run()
	if ctx.Err() != nil {
		return 1, ctx.Err()
	}
	if err == nil {
		return 0, nil
	}
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return ee.ExitCode(), err
	}
	return 1, err
}
func writeTimePoll(n int) error {
	key, err := registry.OpenKey(registry.LOCAL_MACHINE, `SYSTEM\CurrentControlSet\Services\W32Time\TimeProviders\NtpClient`, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer key.Close()
	return key.SetDWordValue("SpecialPollInterval", uint32(n))
}
func windowsZoneExists(id string) error {
	if !zoneSyntax(id) {
		return fmt.Errorf("invalid timezone ID")
	}
	key, err := registry.OpenKey(registry.LOCAL_MACHINE, `SOFTWARE\Microsoft\Windows NT\CurrentVersion\Time Zones\`+id, registry.QUERY_VALUE)
	if err != nil {
		return fmt.Errorf("timezone ID is not installed: %w", err)
	}
	return key.Close()
}
func startTimeService(ctx context.Context) error {
	if e := ctx.Err(); e != nil {
		return e
	}
	// The reused SCM helper has a 30 s wait and no context parameter.
	if deadline, ok := ctx.Deadline(); ok && time.Until(deadline) < 31*time.Second {
		return context.DeadlineExceeded
	}
	// services_windows.go:114-133 uses SCM, closes handles, and waits at most 30 s.
	result := tools.StartService(map[string]any{"name": "W32Time"})
	if result.Status != "completed" {
		return fmt.Errorf("start W32Time: %s", result.Error)
	}
	return ctx.Err()
}
