//go:build windows

package wakeconfig

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"

	"github.com/breeze-rmm/agent/internal/procspawn"
)

const (
	writeTimeout = 60 * time.Second
	powerKeyPath = `SYSTEM\CurrentControlSet\Control\Session Manager\Power`
)

// NewWriter returns the Windows writer. Until writesActivated is true the
// manager never calls it.
func NewWriter() Writer { return windowsWriter{} }

type windowsWriter struct{}

func (windowsWriter) Write(ctx context.Context, op Op) error {
	if op.Kind == OpFastStartupOff {
		return writeFastStartupOff()
	}
	script, err := writeScript(op)
	if err != nil {
		return err
	}
	return runWriteScript(ctx, script)
}

// writeFastStartupOff sets HiberbootEnabled from 1 to 0 and reads it back
// (the onedrivehelper write-then-read pattern). Any other current value,
// including a missing one, is left alone: the plan only asks when it read 1.
func writeFastStartupOff() error {
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, powerKeyPath, registry.QUERY_VALUE|registry.SET_VALUE)
	if err != nil {
		return fmt.Errorf("open power key: %w", err)
	}
	defer func() { _ = k.Close() }()
	got, _, err := k.GetIntegerValue("HiberbootEnabled")
	if err != nil {
		return fmt.Errorf("read HiberbootEnabled: %w", err)
	}
	if got == 0 {
		return nil // already correct; never rewritten
	}
	if got != 1 {
		return fmt.Errorf("HiberbootEnabled is %d, not 1; left alone", got)
	}
	if err := k.SetDWordValue("HiberbootEnabled", 0); err != nil {
		return fmt.Errorf("set HiberbootEnabled: %w", err)
	}
	if got, _, err := k.GetIntegerValue("HiberbootEnabled"); err != nil || got != 0 {
		return fmt.Errorf("HiberbootEnabled read-back: got %d (err %v)", got, err)
	}
	return nil
}

// runWriteScript runs Windows PowerShell from System32 by absolute path
// (timesync/writer_windows.go pattern), never through PATH.
func runWriteScript(parent context.Context, script string) error {
	ctx, cancel := context.WithTimeout(parent, writeTimeout)
	defer cancel()
	dir, err := windows.GetSystemDirectory()
	if err != nil {
		return fmt.Errorf("locate powershell: %w", err)
	}
	exe := filepath.Join(dir, "WindowsPowerShell", "v1.0", "powershell.exe")
	cmd := procspawn.CommandContext(ctx, exe, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	cmd.WaitDelay = 10 * time.Second
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if exit, ok := errors.AsType[*exec.ExitError](err); ok {
			return fmt.Errorf("powershell exit %d: %s", exit.ExitCode(), strings.TrimSpace(truncate(stderr.String(), 300)))
		}
		return err
	}
	return nil
}
