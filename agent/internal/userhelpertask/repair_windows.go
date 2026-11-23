//go:build windows

package userhelpertask

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/procspawn"
	"github.com/breeze-rmm/agent/internal/selfuninstall"
	"golang.org/x/sys/windows"
)

// schtasksTimeout bounds every schtasks.exe call.
const schtasksTimeout = 30 * time.Second

// NewWindows returns the production Repairer. dataDir is the agent's
// SYSTEM-only data directory, where the task file is written for schtasks to
// read; uninstalling reports an uninstall in progress.
func NewWindows(dataDir string, uninstalling func() bool) *Repairer {
	return New(Deps{
		TaskExists:    func() (bool, error) { return selfuninstall.ScheduledTaskExists(TaskName) },
		HelperPresent: helperPresent,
		Uninstalling:  uninstalling,
		Schtasks:      runSchtasks,
		TempDir:       dataDir,
		Now:           time.Now,
	})
}

// helperPresent: a non-empty regular file. A missing file is absent; any
// other stat failure is unknown.
func helperPresent(path string) (bool, error) {
	if path == "" {
		return false, errors.New("no helper path in the task definition")
	}
	info, err := os.Stat(path)
	switch {
	case err == nil:
		return info.Mode().IsRegular() && info.Size() > 0, nil
	case errors.Is(err, os.ErrNotExist):
		return false, nil
	default:
		return false, err
	}
}

// runSchtasks runs schtasks.exe from the system directory (never PATH) and
// returns its standard output.
func runSchtasks(args ...string) ([]byte, error) {
	systemDir, err := windows.GetSystemDirectory()
	if err != nil {
		return nil, fmt.Errorf("resolve the system directory: %w", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), schtasksTimeout)
	defer cancel()
	cmd := procspawn.CommandContext(ctx, filepath.Join(systemDir, "schtasks.exe"), args...)
	cmd.WaitDelay = time.Second
	out, err := cmd.Output()
	if err != nil {
		if ctx.Err() != nil {
			return nil, fmt.Errorf("schtasks timed out after %s", schtasksTimeout)
		}
		if exitErr, ok := errors.AsType[*exec.ExitError](err); ok {
			return nil, fmt.Errorf("%w: %s", err, truncate(strings.TrimSpace(string(exitErr.Stderr)), 300))
		}
		return nil, err
	}
	return out, nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}
