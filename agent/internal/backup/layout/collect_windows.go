//go:build windows

package layout

import (
	"context"
	"fmt"
	"os/exec"
	"time"
)

var runCommand = func(ctx context.Context, name string, args ...string) ([]byte, error) {
	return exec.CommandContext(ctx, name, args...).Output()
}

const collectTimeout = 60 * time.Second

// Collect captures the Windows disk layout through one PowerShell invocation.
func Collect(ctx context.Context) (*Manifest, error) {
	ctx, cancel := context.WithTimeout(ctx, collectTimeout)
	defer cancel()
	out, err := runCommand(ctx, "powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", windowsLayoutScript)
	if err != nil {
		return nil, fmt.Errorf("powershell disk layout: %w", err)
	}
	m, err := parseWindowsLayout(out)
	if err != nil {
		return nil, err
	}
	m.CollectedAt = time.Now().UTC()
	return m, nil
}
