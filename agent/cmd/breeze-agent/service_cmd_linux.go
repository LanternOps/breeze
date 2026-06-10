//go:build linux

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/spf13/cobra"
)

const (
	linuxBinaryPath  = "/usr/local/bin/breeze-agent"
	linuxUnitDst     = "/etc/systemd/system/breeze-agent.service"
	linuxUserUnitDst = "/usr/lib/systemd/user/breeze-agent-user.service"
	linuxConfigDir   = "/etc/breeze"
	linuxDataDir     = "/var/lib/breeze"
	linuxLogDir      = "/var/log/breeze"
	linuxServiceName = "breeze-agent"

	linuxWatchdogBinaryPath  = "/usr/local/bin/breeze-watchdog"
	linuxWatchdogUnitDst     = "/etc/systemd/system/breeze-watchdog.service"
	linuxWatchdogServiceName = "breeze-watchdog"
)

// Embedded user-helper unit
const linuxUserUnit = `[Unit]
Description=Breeze RMM User Helper
Documentation=https://github.com/breeze-rmm/breeze
After=graphical-session.target

[Service]
Type=simple
ExecStart=/usr/local/bin/breeze-agent user-helper
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`

var serviceCmd = &cobra.Command{
	Use:   "service",
	Short: "Manage the Breeze Agent system service (systemd)",
}

var withUserHelper bool
var noWatchdog bool

var reconcileOnce sync.Once

// reconcileServiceUnitIfNeeded runs at startup. If the installed unit predates
// currentUnitVersion, it rewrites it. The running agent is itself sandboxed and
// cannot write /etc/systemd/system (ProtectSystem=strict on old units), so it
// escapes via a systemd-run TRANSIENT SERVICE: PID 1 spawns the reconcile in a
// fresh execution environment, outside this unit's mount namespace and
// capability bounding set. Best-effort: on failure it logs and continues.
func reconcileServiceUnitIfNeeded() {
	reconcileOnce.Do(func() {
		// Only act as the installed systemd service running as root.
		if os.Geteuid() != 0 || os.Getenv("INVOCATION_ID") == "" {
			return
		}
		data, err := os.ReadFile(linuxUnitDst)
		if err != nil {
			return // not installed via systemd / unreadable — nothing to heal
		}
		if !unitNeedsReconcile(string(data), currentUnitVersion) {
			return
		}
		if _, err := exec.LookPath("systemd-run"); err != nil {
			fmt.Fprintf(os.Stderr,
				"Warning: breeze-agent systemd unit is outdated (pre-v%d) and systemd-run is "+
					"unavailable to auto-heal it. The remote terminal/scripts may hit privilege "+
					"errors (e.g. apt). Fix: sudo breeze-agent service install\n", currentUnitVersion)
			return
		}
		// TRANSIENT SERVICE, deliberately NOT --scope: a scope child is forked
		// from this (sandboxed) process and only its cgroup moves — it would
		// inherit our read-only /etc (ProtectSystem) and restricted CapBnd and
		// fail with the same Permission denied. Without --scope, PID 1 spawns
		// the command in a fresh execution environment with full root caps and
		// an unrestricted namespace; being a child of PID 1 it also survives
		// the agent restart it triggers. --collect garbage-collects the
		// transient unit on failure so a later retry is never blocked.
		out, err := exec.Command("systemd-run", "--quiet", "--collect",
			"--unit=breeze-unit-reconcile", linuxBinaryPath, "service", "reconcile-unit").CombinedOutput()
		if err != nil {
			fmt.Fprintf(os.Stderr,
				"Warning: failed to auto-heal outdated systemd unit via systemd-run: %s. "+
					"Fix: sudo breeze-agent service install\n", strings.TrimSpace(string(out)))
		}
	})
}

func init() {
	rootCmd.AddCommand(serviceCmd)
	serviceCmd.AddCommand(serviceInstallCmd)
	serviceCmd.AddCommand(serviceUninstallCmd)
	serviceCmd.AddCommand(serviceStartCmd)
	serviceCmd.AddCommand(serviceStopCmd)
	serviceCmd.AddCommand(serviceStatusCmd)
	serviceCmd.AddCommand(serviceReconcileUnitCmd)
	serviceInstallCmd.Flags().BoolVar(&withUserHelper, "with-user-helper", false, "Also install the per-user desktop helper systemd unit")
	serviceInstallCmd.Flags().BoolVar(&noWatchdog, "no-watchdog", false, "Skip automatic watchdog installation")
}

var serviceInstallCmd = &cobra.Command{
	Use:   "install",
	Short: "Install the agent as a systemd service",
	RunE: func(cmd *cobra.Command, args []string) error {
		if os.Geteuid() != 0 {
			return fmt.Errorf("must run as root (sudo breeze-agent service install)")
		}

		// Create directories
		for _, dir := range []string{linuxConfigDir, linuxDataDir, linuxLogDir} {
			if err := os.MkdirAll(dir, 0755); err != nil {
				return fmt.Errorf("failed to create %s: %w", dir, err)
			}
		}
		// Note: FixConfigPermissions() loosens this to 0755 on startup so the Helper
		// can read agent.yaml.
		if err := os.Chmod(linuxConfigDir, 0700); err != nil {
			return fmt.Errorf("failed to set permissions on %s: %w", linuxConfigDir, err)
		}

		// Stop existing service before replacing binary (safe for upgrades).
		if _, err := os.Stat(linuxUnitDst); err == nil {
			if stopErr := exec.Command("systemctl", "stop", linuxServiceName).Run(); stopErr != nil {
				fmt.Fprintf(os.Stderr, "Warning: failed to stop existing service: %v\n", stopErr)
			} else {
				fmt.Println("Stopped existing Breeze Agent service.")
			}
		}

		// Copy current binary to /usr/local/bin/
		exePath, err := os.Executable()
		if err != nil {
			return fmt.Errorf("failed to determine executable path: %w", err)
		}
		exePath, err = filepath.EvalSymlinks(exePath)
		if err != nil {
			return fmt.Errorf("failed to resolve executable path: %w", err)
		}

		if exePath != linuxBinaryPath {
			data, err := os.ReadFile(exePath)
			if err != nil {
				return fmt.Errorf("failed to read binary: %w", err)
			}
			if err := os.WriteFile(linuxBinaryPath, data, 0755); err != nil {
				return fmt.Errorf("failed to copy binary to %s: %w", linuxBinaryPath, err)
			}
			fmt.Printf("Binary installed to %s\n", linuxBinaryPath)
		}

		// Write systemd unit file
		if err := os.WriteFile(linuxUnitDst, []byte(linuxUnit), 0644); err != nil {
			return fmt.Errorf("failed to write unit file: %w", err)
		}
		fmt.Printf("Systemd unit installed to %s\n", linuxUnitDst)

		// Optionally install the per-user desktop helper unit
		if withUserHelper {
			if err := os.MkdirAll(filepath.Dir(linuxUserUnitDst), 0755); err == nil {
				if err := os.WriteFile(linuxUserUnitDst, []byte(linuxUserUnit), 0644); err != nil {
					fmt.Fprintf(os.Stderr, "Warning: failed to write user-helper unit: %v\n", err)
				} else {
					fmt.Printf("User helper unit installed to %s\n", linuxUserUnitDst)
				}
			}
		}

		// Reload systemd
		if out, err := exec.Command("systemctl", "daemon-reload").CombinedOutput(); err != nil {
			return fmt.Errorf("failed to reload systemd: %s", strings.TrimSpace(string(out)))
		}

		// Enable the service
		if out, err := exec.Command("systemctl", "enable", linuxServiceName).CombinedOutput(); err != nil {
			fmt.Fprintf(os.Stderr, "Warning: failed to enable service: %s\n", strings.TrimSpace(string(out)))
		}

		// Create breeze group for IPC socket access (best-effort, idempotent)
		if err := exec.Command("getent", "group", "breeze").Run(); err != nil {
			// Group doesn't exist — create it
			if createErr := exec.Command("groupadd", "--system", "breeze").Run(); createErr != nil {
				fmt.Fprintf(os.Stderr, "Warning: failed to create 'breeze' group: %v\n", createErr)
			} else {
				fmt.Println("Created 'breeze' group for IPC socket access.")
			}
		}

		// Create IPC socket directory
		ipcDir := "/var/run/breeze"
		if err := os.MkdirAll(ipcDir, 0770); err != nil {
			fmt.Fprintf(os.Stderr, "Warning: failed to create IPC directory %s: %v\n", ipcDir, err)
		}
		if err := exec.Command("chown", "root:breeze", ipcDir).Run(); err != nil {
			fmt.Fprintf(os.Stderr, "Warning: failed to set IPC directory ownership: %v\n", err)
		}

		fmt.Println()
		fmt.Println("Breeze Agent service installed and enabled.")

		// Show contextual next steps based on enrollment and service state.
		existingCfg, _ := config.Load(cfgFile)
		enrolled := existingCfg != nil && existingCfg.AgentID != ""
		running := isSystemServiceRunning()

		if enrolled && running {
			// Already enrolled and running — show current status automatically.
			fmt.Println()
			statusCmd := exec.Command(linuxBinaryPath, "status")
			statusCmd.Stdout = os.Stdout
			statusCmd.Stderr = os.Stderr
			statusCmd.Run() // best-effort; ignore error

			fmt.Println("\nHelpful Commands:")
			fmt.Println("  Logs:    journalctl -u breeze-agent -f")
			fmt.Println("  Status:  sudo breeze-agent service status")
			fmt.Println("  Restart: sudo breeze-agent service start")
		} else if enrolled {
			fmt.Println()
			fmt.Println("Next steps:")
			fmt.Printf("  1. Start:   sudo breeze-agent service start\n")
			fmt.Printf("  2. Status:  sudo breeze-agent service status\n")
			fmt.Println("  3. Logs:    journalctl -u breeze-agent -f")
		} else {
			fmt.Println()
			fmt.Println("Next steps:")
			fmt.Printf("  1. Enroll:  sudo breeze-agent enroll <key> --server https://your-server\n")
			fmt.Printf("  2. Start:   sudo breeze-agent service start\n")
			fmt.Printf("  3. Status:  sudo breeze-agent service status\n")
			fmt.Println("  4. Logs:    journalctl -u breeze-agent -f")
		}

		if !noWatchdog {
			err := bootstrapWatchdog(bootstrapOptions{
				agentPath: exePath,
				version:   version,
				goos:      runtime.GOOS,
				goarch:    runtime.GOARCH,
			})
			if err != nil {
				fmt.Fprintf(os.Stderr,
					"Warning: watchdog bootstrap failed: %v\n"+
						"The agent service is installed and running. The watchdog is NOT installed.\n"+
						"To retry, choose one of:\n"+
						"  1. Re-run `sudo breeze-agent service install` (will retry the download).\n"+
						"  2. Download %s manually, place it next to breeze-agent,\n"+
						"     then run `sudo breeze-watchdog service install`.\n"+
						"  3. To skip the watchdog entirely, use `--no-watchdog`.\n",
					err, watchdogDownloadURL(version, runtime.GOOS, runtime.GOARCH))
			}
		}

		return nil
	},
}

var serviceUninstallCmd = &cobra.Command{
	Use:   "uninstall",
	Short: "Uninstall the agent systemd service",
	RunE: func(cmd *cobra.Command, args []string) error {
		if os.Geteuid() != 0 {
			return fmt.Errorf("must run as root (sudo breeze-agent service uninstall)")
		}

		// Stop the service
		if err := exec.Command("systemctl", "stop", linuxServiceName).Run(); err != nil {
			fmt.Fprintf(os.Stderr, "Warning: failed to stop service: %v\n", err)
		}

		// Disable the service
		if err := exec.Command("systemctl", "disable", linuxServiceName).Run(); err != nil {
			fmt.Fprintf(os.Stderr, "Warning: failed to disable service: %v\n", err)
		}

		uninstallLinuxWatchdog()

		// Remove unit files
		if err := os.Remove(linuxUnitDst); err != nil && !os.IsNotExist(err) {
			fmt.Fprintf(os.Stderr, "Warning: failed to remove %s: %v\n", linuxUnitDst, err)
		}
		if err := os.Remove(linuxUserUnitDst); err != nil && !os.IsNotExist(err) {
			fmt.Fprintf(os.Stderr, "Warning: failed to remove %s: %v\n", linuxUserUnitDst, err)
		}

		// Reload systemd
		if err := exec.Command("systemctl", "daemon-reload").Run(); err != nil {
			fmt.Fprintf(os.Stderr, "Warning: failed to reload systemd: %v\n", err)
		}

		// Remove binary
		if err := os.Remove(linuxBinaryPath); err != nil && !os.IsNotExist(err) {
			fmt.Fprintf(os.Stderr, "Warning: failed to remove %s: %v\n", linuxBinaryPath, err)
		}

		fmt.Println("Breeze Agent service uninstalled.")
		fmt.Printf("Config at %s was preserved.\n", linuxConfigDir)
		fmt.Printf("To remove config: sudo rm -rf %s\n", linuxConfigDir)
		return nil
	},
}

func uninstallLinuxWatchdog() {
	if err := exec.Command("systemctl", "stop", linuxWatchdogServiceName).Run(); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: failed to stop watchdog service: %v\n", err)
	}
	if err := exec.Command("systemctl", "disable", linuxWatchdogServiceName).Run(); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: failed to disable watchdog service: %v\n", err)
	}
	if err := os.Remove(linuxWatchdogUnitDst); err != nil && !os.IsNotExist(err) {
		fmt.Fprintf(os.Stderr, "Warning: failed to remove %s: %v\n", linuxWatchdogUnitDst, err)
	}
	if err := os.Remove(linuxWatchdogBinaryPath); err != nil && !os.IsNotExist(err) {
		fmt.Fprintf(os.Stderr, "Warning: failed to remove %s: %v\n", linuxWatchdogBinaryPath, err)
	}
}

var serviceStartCmd = &cobra.Command{
	Use:   "start",
	Short: "Start the agent service",
	RunE: func(cmd *cobra.Command, args []string) error {
		if os.Geteuid() != 0 {
			return fmt.Errorf("must run as root (sudo breeze-agent service start)")
		}

		if _, err := os.Stat(linuxUnitDst); os.IsNotExist(err) {
			return fmt.Errorf("service not installed — run 'sudo breeze-agent service install' first")
		}

		// Reload systemd so any updated unit file on disk is recognized before enabling.
		exec.Command("systemctl", "daemon-reload").Run() //nolint:errcheck — best-effort

		// Enable the service for auto-start on reboot before starting it.
		if out, err := exec.Command("systemctl", "enable", linuxServiceName).CombinedOutput(); err != nil {
			fmt.Fprintf(os.Stderr, "Warning: failed to enable service for auto-start: %s\n", strings.TrimSpace(string(out)))
		}

		out, err := exec.Command("systemctl", "start", linuxServiceName).CombinedOutput()
		if err != nil {
			return fmt.Errorf("failed to start service: %s", strings.TrimSpace(string(out)))
		}

		fmt.Println("Breeze Agent service started and enabled for auto-start.")
		fmt.Println("Logs: journalctl -u breeze-agent -f")
		return nil
	},
}

var serviceStopCmd = &cobra.Command{
	Use:   "stop",
	Short: "Stop the agent service",
	RunE: func(cmd *cobra.Command, args []string) error {
		if os.Geteuid() != 0 {
			return fmt.Errorf("must run as root (sudo breeze-agent service stop)")
		}

		out, err := exec.Command("systemctl", "stop", linuxServiceName).CombinedOutput()
		if err != nil {
			return fmt.Errorf("failed to stop service: %s", strings.TrimSpace(string(out)))
		}

		fmt.Println("Breeze Agent service stopped.")
		return nil
	},
}

var serviceStatusCmd = &cobra.Command{
	Use:   "status",
	Short: "Show agent service status",
	RunE: func(cmd *cobra.Command, args []string) error {
		if _, err := os.Stat(linuxUnitDst); os.IsNotExist(err) {
			fmt.Println("Service: not installed")
			return nil
		}

		out, err := exec.Command("systemctl", "status", linuxServiceName, "--no-pager").CombinedOutput()
		if err != nil {
			// systemctl status returns exit code 3 if service is stopped — not an error
			if exitErr, ok := err.(*exec.ExitError); ok && exitErr.ExitCode() == 3 {
				// Service is stopped; output still contains useful status info
			} else if !ok {
				fmt.Fprintf(os.Stderr, "Warning: failed to query service status: %v\n", err)
			}
		}
		fmt.Println(strings.TrimSpace(string(out)))
		return nil
	},
}

var serviceReconcileUnitCmd = &cobra.Command{
	Use:    "reconcile-unit",
	Short:  "Rewrite the systemd unit to the current version and restart (internal)",
	Hidden: true,
	RunE: func(cmd *cobra.Command, args []string) error {
		if os.Geteuid() != 0 {
			return fmt.Errorf("must run as root")
		}
		if err := os.WriteFile(linuxUnitDst, []byte(linuxUnit), 0644); err != nil {
			return fmt.Errorf("write unit: %w", err)
		}
		if out, err := exec.Command("systemctl", "daemon-reload").CombinedOutput(); err != nil {
			return fmt.Errorf("daemon-reload: %s", strings.TrimSpace(string(out)))
		}
		fmt.Printf("Reconciled %s to unit version %d; restarting service.\n", linuxUnitDst, currentUnitVersion)
		// Restart so the relaxed sandbox applies to the live process. This kills
		// the old agent; we run as a systemd-run transient service whose parent
		// is PID 1 (not the agent), so this child survives to finish the restart.
		if out, err := exec.Command("systemctl", "restart", linuxServiceName).CombinedOutput(); err != nil {
			return fmt.Errorf("restart: %s", strings.TrimSpace(string(out)))
		}
		return nil
	},
}
