//go:build windows

package timesync

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"path/filepath"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
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

// scmStartError treats ERROR_SERVICE_ALREADY_RUNNING as success: trigger-start
// W32Time can start itself (or be start-pending) between our read and the start.
func scmStartError(err error) error {
	if err == nil || errors.Is(err, windows.ERROR_SERVICE_ALREADY_RUNNING) {
		return nil
	}
	return fmt.Errorf("start W32Time: %w", err)
}
func startTimeService(ctx context.Context) error {
	if e := ctx.Err(); e != nil {
		return e
	}
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("connect to service manager: %w", err)
	}
	defer m.Disconnect()
	s, err := m.OpenService("W32Time")
	if err != nil {
		return fmt.Errorf("open W32Time: %w", err)
	}
	defer s.Close()
	// Synchronous SCM calls; the running-state wait is bounded by ctx and 30 s.
	return startAndWaitRunning(ctx, func() error { return scmStartError(s.Start()) }, func() (bool, error) {
		st, e := s.Query()
		return st.State == svc.Running, e
	}, 500*time.Millisecond, 30*time.Second)
}
