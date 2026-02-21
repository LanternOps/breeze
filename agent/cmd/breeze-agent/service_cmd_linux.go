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
	linuxBinaryPath  = "/usr/local/bin/breeze-agent"
	linuxUnitDst     = "/etc/systemd/system/breeze-agent.service"
	linuxUserUnitDst = "/usr/lib/systemd/user/breeze-agent-user.service"
	linuxConfigDir   = "/etc/breeze"
	linuxDataDir     = "/var/lib/breeze"
	linuxLogDir      = "/var/log/breeze"
	linuxServiceName = "breeze-agent"
)

// Embedded systemd unit — matches agent/service/systemd/breeze-agent.service
const linuxUnit = `[Unit]
Description=Breeze RMM Agent
Documentation=https://github.com/breeze-rmm/breeze
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/breeze-agent run
WorkingDirectory=/etc/breeze
Restart=on-failure
RestartSec=5
StartLimitIntervalSec=60
StartLimitBurst=5

# Security hardening
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/etc/breeze /var/lib/breeze /var/log/breeze
PrivateTmp=true
NoNewPrivileges=false
CapabilityBoundingSet=CAP_NET_RAW CAP_NET_ADMIN CAP_SYS_PTRACE CAP_DAC_READ_SEARCH
AmbientCapabilities=CAP_NET_RAW CAP_NET_ADMIN

# Logging (stdout goes to journald)
StandardOutput=journal
StandardError=journal
SyslogIdentifier=breeze-agent

# File limits
LimitNOFILE=8192

[Install]
WantedBy=multi-user.target
`

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

func init() {
	rootCmd.AddCommand(serviceCmd)
	serviceCmd.AddCommand(serviceInstallCmd)
	serviceCmd.AddCommand(serviceUninstallCmd)
	serviceCmd.AddCommand(serviceStartCmd)
	serviceCmd.AddCommand(serviceStopCmd)
	serviceCmd.AddCommand(serviceStatusCmd)
	serviceInstallCmd.Flags().BoolVar(&withUserHelper, "with-user-helper", false, "Also install the per-user desktop helper systemd unit")
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
		if err := os.Chmod(linuxConfigDir, 0700); err != nil {
			return fmt.Errorf("failed to set permissions on %s: %w", linuxConfigDir, err)
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

		// Create breeze group for IPC socket access (best-effort)
		exec.Command("groupadd", "--system", "breeze").Run()

		// Create IPC socket directory
		ipcDir := "/var/run/breeze"
		os.MkdirAll(ipcDir, 0770)
		exec.Command("chown", "root:breeze", ipcDir).Run()

		fmt.Println()
		fmt.Println("Breeze Agent service installed and enabled.")
		fmt.Println()
		fmt.Println("Next steps:")
		fmt.Printf("  1. Enroll:  sudo breeze-agent enroll <key> --server https://your-server\n")
		fmt.Printf("  2. Start:   sudo breeze-agent service start\n")
		fmt.Printf("  3. Status:  sudo breeze-agent service status\n")
		fmt.Println("  4. Logs:    journalctl -u breeze-agent -f")
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
		exec.Command("systemctl", "stop", linuxServiceName).Run()

		// Disable the service
		exec.Command("systemctl", "disable", linuxServiceName).Run()

		// Remove unit files
		os.Remove(linuxUnitDst)
		os.Remove(linuxUserUnitDst)

		// Reload systemd
		exec.Command("systemctl", "daemon-reload").Run()

		// Remove binary
		os.Remove(linuxBinaryPath)

		fmt.Println("Breeze Agent service uninstalled.")
		fmt.Printf("Config at %s was preserved.\n", linuxConfigDir)
		fmt.Printf("To remove config: sudo rm -rf %s\n", linuxConfigDir)
		return nil
	},
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

		out, err := exec.Command("systemctl", "start", linuxServiceName).CombinedOutput()
		if err != nil {
			return fmt.Errorf("failed to start service: %s", strings.TrimSpace(string(out)))
		}

		fmt.Println("Breeze Agent service started.")
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
		// systemctl status returns non-zero if service is stopped — that's fine
		fmt.Println(strings.TrimSpace(string(out)))
		_ = err
		return nil
	},
}
