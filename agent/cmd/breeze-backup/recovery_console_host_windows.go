//go:build windows

package main

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"

	"github.com/breeze-rmm/agent/internal/backup/hosttool"
	"github.com/breeze-rmm/agent/internal/backup/layout"
	"github.com/breeze-rmm/agent/internal/backup/rebuild"
	"github.com/breeze-rmm/agent/internal/backup/windisks"
)

// defaultConsoleHost is the WinPE media host. The payload lives next to the
// executable (X:\breeze\ on the media): cmdline.txt, recovery-server,
// recovery-trust-pin (optional) and roots.pem.
//
// D7-NOLOCK: on WinPE, winpeshl.ini starts exactly one console (there is no
// serial-getty twin, unlike the Linux media's tty1 + ttyS0 pair), so no
// cross-instance lock is taken and AcquireLock stays nil.
//
// Only WinPE-inbox tools run, by absolute path in the WinPE System32
// (hosttool.SystemTool): wpeutil.exe for power, cmd.exe for the shell.
func defaultConsoleHost() consoleHost {
	exeDir := executableDir()
	ws := rebuild.NewWinSystem()
	return consoleHost{
		Cmdline: func() (string, error) {
			// cmdline.txt is media content, honoured only inside WinPE:
			// on a live Windows host the guard then refuses unless
			// --allow-host is passed.
			if ws == nil || !ws.InWinPE() || exeDir == "" {
				return "", nil
			}
			b, err := os.ReadFile(filepath.Join(exeDir, "cmdline.txt"))
			if errors.Is(err, fs.ErrNotExist) {
				return "", nil
			}
			if err != nil {
				return "", fmt.Errorf("read media cmdline: %w", err)
			}
			return string(b), nil
		},
		BakedServer:   joinIfDir(exeDir, "recovery-server"),
		BakedTrustPin: joinIfDir(exeDir, "recovery-trust-pin"),
		BakedRoots:    joinIfDir(exeDir, "roots.pem"),
		Collect: func(context.Context) (*layout.Manifest, error) {
			ds, err := windisks.List()
			if err != nil {
				return nil, err
			}
			return disksToManifest(ds), nil
		},
		MediaSources: func() ([]string, error) {
			if ws == nil {
				return nil, rebuild.ErrUnsupportedHost
			}
			nums, err := ws.MediaDiskNumbers()
			if err != nil {
				return nil, err
			}
			out := make([]string, 0, len(nums))
			for _, n := range nums {
				out = append(out, fmt.Sprintf(`\\.\PhysicalDrive%d`, n))
			}
			return out, nil
		},
		Power: func(action string) error {
			exe, args, err := winPEPowerArgs(action)
			if err != nil {
				return err
			}
			return exec.Command(exe, args...).Run()
		},
		Shell: func() error {
			c := exec.Command(hosttool.SystemTool("cmd.exe"))
			c.Stdin, c.Stdout, c.Stderr = os.Stdin, os.Stdout, os.Stderr
			return c.Run()
		},
		HostCheck: func() error {
			if ws == nil {
				return rebuild.ErrUnsupportedHost
			}
			return nil
		},
	}
}

// executableDir is the directory holding this binary (X:\breeze on the
// media), with symlinks resolved. "" when it cannot be determined; the
// media-relative paths are then left empty (no cmdline, nothing baked), so
// the guard refuses rather than reading files from the working directory.
func executableDir() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	return filepath.Dir(exe)
}

func joinIfDir(dir, name string) string {
	if dir == "" {
		return ""
	}
	return filepath.Join(dir, name)
}
