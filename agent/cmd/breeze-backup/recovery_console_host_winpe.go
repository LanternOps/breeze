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

// winPEProbe is the slice of rebuild.WinSystem the WinPE console host needs.
// A nil winPEProbe means the Windows rebuild engine is unavailable.
type winPEProbe interface {
	InWinPE() bool
	MediaDiskNumbers() ([]int, error)
}

// newWinPEConsoleHost is the WinPE media host (see defaultConsoleHost in
// recovery_console_host_windows.go). It is untagged so its media gating is
// unit-tested on every platform; only the Windows build calls it.
//
// The payload lives next to the executable (exeDir, X:\breeze\ on the media):
// cmdline.txt, recovery-server, recovery-trust-pin (optional) and roots.pem.
//
// D7-NOLOCK: on WinPE, winpeshl.ini starts exactly one console (there is no
// serial-getty twin, unlike the Linux media's tty1 + ttyS0 pair), so no
// cross-instance lock is taken and AcquireLock stays nil.
//
// Only WinPE-inbox tools run, by absolute path in the WinPE System32
// (hosttool.SystemTool): wpeutil.exe for power, cmd.exe for the shell.
func newWinPEConsoleHost(ws winPEProbe, exeDir string) consoleHost {
	// Everything next to the executable is media content, honoured only
	// inside WinPE. On a live Windows host (or with no WinSystem) mediaDir is
	// "": no cmdline (the guard then refuses unless --allow-host), no baked
	// server/pin (flags and env only, as on a Linux host without baked
	// files) and no roots.pem (the system root store stays in effect), so a
	// stray payload beside an installed breeze-backup.exe changes nothing.
	mediaDir := ""
	if ws != nil && ws.InWinPE() {
		mediaDir = exeDir
	}
	return consoleHost{
		Cmdline: func() (string, error) {
			if mediaDir == "" {
				return "", nil
			}
			b, err := os.ReadFile(filepath.Join(mediaDir, "cmdline.txt"))
			if errors.Is(err, fs.ErrNotExist) {
				return "", nil
			}
			if err != nil {
				return "", fmt.Errorf("read media cmdline: %w", err)
			}
			return string(b), nil
		},
		BakedServer:   joinIfDir(mediaDir, "recovery-server"),
		BakedTrustPin: joinIfDir(mediaDir, "recovery-trust-pin"),
		BakedRoots:    joinIfDir(mediaDir, "roots.pem"),
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

func joinIfDir(dir, name string) string {
	if dir == "" {
		return ""
	}
	return filepath.Join(dir, name)
}
