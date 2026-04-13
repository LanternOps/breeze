//go:build !windows

package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"runtime"
	"syscall"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/logging"
)

// isWindowsService reports whether the process is running as a system service.
// On macOS, returns true when running as a LaunchDaemon (root + no console),
// which means the process cannot access the user's Quartz session directly
// and must route desktop capture/input through the user helper via IPC.
func isWindowsService() bool {
	if runtime.GOOS == "darwin" {
		return os.Geteuid() == 0 && !hasConsole()
	}
	return false
}

// hasConsole reports whether stdout is connected to a terminal.
// Returns false when running as a launchd daemon or systemd service.
func hasConsole() bool {
	fi, err := os.Stdout.Stat()
	if err != nil {
		return false
	}
	return fi.Mode()&os.ModeCharDevice != 0
}

// isHeadless reports whether the machine lacks any graphical display.
//
// macOS: always false — even LaunchDaemons can reach user-session displays
// via the session broker + helper. The desktopAccess heartbeat field provides
// the detailed capability check (permissions, entitlements, OS version).
//
// Linux: check whether any graphical session exists. Headless servers
// (Ubuntu Core, containers) have no X11/Wayland session; desktop distros do.
func isHeadless() bool {
	if runtime.GOOS == "darwin" {
		return false
	}
	return !linuxHasGraphicalSession()
}

// linuxHasGraphicalSession checks for any active graphical user session.
// First checks common environment variables, then falls back to scanning
// /run/user/*/dbus-session for evidence of a desktop session.
func linuxHasGraphicalSession() bool {
	// If the agent itself has display env vars (rare for services, but possible)
	if os.Getenv("DISPLAY") != "" || os.Getenv("WAYLAND_DISPLAY") != "" {
		return true
	}
	// Check if any user has an active graphical session by looking for
	// X11 or Wayland sockets under /tmp/.X11-unix or /run/user/*/
	if entries, err := os.ReadDir("/tmp/.X11-unix"); err == nil && len(entries) > 0 {
		return true
	}
	// Check for Wayland sockets in any user's runtime dir
	if userDirs, err := os.ReadDir("/run/user"); err == nil {
		for _, ud := range userDirs {
			dirPath := "/run/user/" + ud.Name()
			if dirEntries, err := os.ReadDir(dirPath); err == nil {
				for _, e := range dirEntries {
					if len(e.Name()) > 8 && e.Name()[:8] == "wayland-" {
						return true
					}
				}
			}
		}
	}
	return false
}

// redirectStderr points fd 2 at the given file so that Go runtime panics
// are captured in the log file.
func redirectStderr(f *os.File) {
	syscall.Dup2(int(f.Fd()), 2)
}

// runAsService runs the agent as a system daemon on Unix (launchd / systemd).
// Unlike Windows, there is no SCM handshake. We load config, wait for
// enrollment if needed, then start components and block on SIGTERM.
// cfgFile is the path to the agent config file (same as the global cfgFile var).
func runAsService(cfgFile string) error {
	cfg, err := config.Load(cfgFile)
	if err != nil {
		return fmt.Errorf("failed to load config: %w", err)
	}
	initBootstrapLogging(cfg)

	ctx, cancel := signal.NotifyContext(context.Background(),
		os.Interrupt, syscall.SIGTERM)
	defer cancel()

	if !config.IsEnrolled(cfg) {
		cfg = waitForEnrollmentFn(ctx, cfgFile)
		if cfg == nil {
			log.Info("agent shutting down without enrollment (service mode)",
				"reason", ctx.Err().Error())
			return nil
		}
	}

	comps, err := startAgentFn(cfg)
	if err != nil {
		return err
	}
	defer logging.StopShipper()

	<-ctx.Done()
	log.Info("shutting down agent (service mode)", "reason", ctx.Err().Error())
	shutdownAgent(comps)
	return nil
}

// ensureSASPolicy is a no-op on non-Windows platforms.
func ensureSASPolicy() {}
