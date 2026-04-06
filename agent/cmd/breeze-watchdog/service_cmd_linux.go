//go:build linux

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"
)

const (
	watchdogBinaryPath  = "/usr/local/bin/breeze-watchdog"
	watchdogUnitDst     = "/etc/systemd/system/breeze-watchdog.service"
	watchdogServiceName = "breeze-watchdog"
)

const watchdogUnit = `[Unit]
Description=Breeze RMM Agent Watchdog
Documentation=https://github.com/breeze-rmm/breeze
After=breeze-agent.service
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=10

[Service]
Type=simple
ExecStart=/usr/local/bin/breeze-watchdog run
WorkingDirectory=/etc/breeze
Restart=always
RestartSec=5

# Security hardening
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/etc/breeze /var/lib/breeze /var/log/breeze /var/run/breeze /usr/local/bin
PrivateTmp=true

# Logging (stdout goes to journald)
StandardOutput=journal
StandardError=journal
SyslogIdentifier=breeze-watchdog

[Install]
WantedBy=multi-user.target
`

func serviceCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "service",
		Short: "Manage the Breeze Watchdog system service (systemd)",
	}
	cmd.AddCommand(serviceInstallCmd())
	cmd.AddCommand(serviceUninstallCmd())
	cmd.AddCommand(serviceStartCmd())
	cmd.AddCommand(serviceStopCmd())
	return cmd
}

func serviceInstallCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "install",
		Short: "Install the watchdog as a systemd service",
		RunE: func(cmd *cobra.Command, args []string) error {
			if os.Geteuid() != 0 {
				return fmt.Errorf("must run as root (sudo breeze-watchdog service install)")
			}

			// Create log directory.
			logDir := "/var/log/breeze"
			if err := os.MkdirAll(logDir, 0755); err != nil {
				return fmt.Errorf("failed to create %s: %w", logDir, err)
			}

			// Stop existing service before replacing binary.
			if _, err := os.Stat(watchdogUnitDst); err == nil {
				if stopErr := exec.Command("systemctl", "stop", watchdogServiceName).Run(); stopErr != nil {
					fmt.Fprintf(os.Stderr, "Warning: failed to stop existing service: %v\n", stopErr)
				} else {
					fmt.Println("Stopped existing Breeze Watchdog service.")
				}
			}

			// Copy current binary to /usr/local/bin/.
			exePath, err := os.Executable()
			if err != nil {
				return fmt.Errorf("failed to determine executable path: %w", err)
			}
			exePath, err = filepath.EvalSymlinks(exePath)
			if err != nil {
				return fmt.Errorf("failed to resolve executable path: %w", err)
			}

			if exePath != watchdogBinaryPath {
				data, err := os.ReadFile(exePath)
				if err != nil {
					return fmt.Errorf("failed to read binary: %w", err)
				}
				if err := os.WriteFile(watchdogBinaryPath, data, 0755); err != nil {
					return fmt.Errorf("failed to copy binary to %s: %w", watchdogBinaryPath, err)
				}
				fmt.Printf("Binary installed to %s\n", watchdogBinaryPath)
			}

			// Write systemd unit file.
			if err := os.WriteFile(watchdogUnitDst, []byte(watchdogUnit), 0644); err != nil {
				return fmt.Errorf("failed to write unit file: %w", err)
			}
			fmt.Printf("Systemd unit installed to %s\n", watchdogUnitDst)

			// Reload systemd.
			if out, err := exec.Command("systemctl", "daemon-reload").CombinedOutput(); err != nil {
				return fmt.Errorf("failed to reload systemd: %s", strings.TrimSpace(string(out)))
			}

			// Enable the service.
			if out, err := exec.Command("systemctl", "enable", watchdogServiceName).CombinedOutput(); err != nil {
				fmt.Fprintf(os.Stderr, "Warning: failed to enable service: %s\n", strings.TrimSpace(string(out)))
			}

			fmt.Println("Breeze Watchdog service installed and enabled.")
			fmt.Println("Start with: sudo breeze-watchdog service start")
			return nil
		},
	}
}

func serviceUninstallCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "uninstall",
		Short: "Uninstall the watchdog systemd service",
		RunE: func(cmd *cobra.Command, args []string) error {
			if os.Geteuid() != 0 {
				return fmt.Errorf("must run as root (sudo breeze-watchdog service uninstall)")
			}

			// Stop the service.
			if err := exec.Command("systemctl", "stop", watchdogServiceName).Run(); err != nil {
				fmt.Fprintf(os.Stderr, "Warning: failed to stop service: %v\n", err)
			}

			// Disable the service.
			if err := exec.Command("systemctl", "disable", watchdogServiceName).Run(); err != nil {
				fmt.Fprintf(os.Stderr, "Warning: failed to disable service: %v\n", err)
			}

			// Remove unit file.
			if err := os.Remove(watchdogUnitDst); err != nil && !os.IsNotExist(err) {
				fmt.Fprintf(os.Stderr, "Warning: failed to remove %s: %v\n", watchdogUnitDst, err)
			}

			// Reload systemd.
			if err := exec.Command("systemctl", "daemon-reload").Run(); err != nil {
				fmt.Fprintf(os.Stderr, "Warning: failed to reload systemd: %v\n", err)
			}

			// Remove binary.
			if err := os.Remove(watchdogBinaryPath); err != nil && !os.IsNotExist(err) {
				fmt.Fprintf(os.Stderr, "Warning: failed to remove %s: %v\n", watchdogBinaryPath, err)
			}

			fmt.Println("Breeze Watchdog service uninstalled.")
			return nil
		},
	}
}

func serviceStartCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "start",
		Short: "Start the watchdog service",
		RunE: func(cmd *cobra.Command, args []string) error {
			if os.Geteuid() != 0 {
				return fmt.Errorf("must run as root (sudo breeze-watchdog service start)")
			}

			if _, err := os.Stat(watchdogUnitDst); os.IsNotExist(err) {
				return fmt.Errorf("service not installed — run 'sudo breeze-watchdog service install' first")
			}

			out, err := exec.Command("systemctl", "start", watchdogServiceName).CombinedOutput()
			if err != nil {
				return fmt.Errorf("failed to start service: %s", strings.TrimSpace(string(out)))
			}

			fmt.Println("Breeze Watchdog service started.")
			fmt.Println("Logs: journalctl -u breeze-watchdog -f")
			return nil
		},
	}
}

func serviceStopCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "stop",
		Short: "Stop the watchdog service",
		RunE: func(cmd *cobra.Command, args []string) error {
			if os.Geteuid() != 0 {
				return fmt.Errorf("must run as root (sudo breeze-watchdog service stop)")
			}

			out, err := exec.Command("systemctl", "stop", watchdogServiceName).CombinedOutput()
			if err != nil {
				return fmt.Errorf("failed to stop service: %s", strings.TrimSpace(string(out)))
			}

			fmt.Println("Breeze Watchdog service stopped.")
			return nil
		},
	}
}

// restartWatchdogService restarts the watchdog via systemctl.
func restartWatchdogService() error {
	out, err := exec.Command("systemctl", "restart", watchdogServiceName).CombinedOutput()
	if err != nil {
		return fmt.Errorf("systemctl restart failed: %s: %w", strings.TrimSpace(string(out)), err)
	}
	return nil
}

// agentBinaryPath returns the platform-specific agent binary path.
func agentBinaryPath() string {
	return "/usr/local/bin/breeze-agent"
}
