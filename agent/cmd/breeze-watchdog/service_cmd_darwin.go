//go:build darwin

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
	watchdogBinaryPath = "/usr/local/bin/breeze-watchdog"
	watchdogPlistDst   = "/Library/LaunchDaemons/com.breeze.watchdog.plist"
	watchdogLabel      = "com.breeze.watchdog"
)

const watchdogPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.breeze.watchdog</string>

    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/breeze-watchdog</string>
        <string>run</string>
    </array>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>ThrottleInterval</key>
    <integer>5</integer>

    <key>WorkingDirectory</key>
    <string>/Library/Application Support/Breeze</string>

    <key>StandardOutPath</key>
    <string>/Library/Logs/Breeze/watchdog.log</string>

    <key>StandardErrorPath</key>
    <string>/Library/Logs/Breeze/watchdog.err</string>
</dict>
</plist>
`

func serviceCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "service",
		Short: "Manage the Breeze Watchdog system service (launchd)",
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
		Short: "Install the watchdog as a launchd service",
		RunE: func(cmd *cobra.Command, args []string) error {
			if os.Geteuid() != 0 {
				return fmt.Errorf("must run as root (sudo breeze-watchdog service install)")
			}

			// Create log directory.
			logDir := "/Library/Logs/Breeze"
			if err := os.MkdirAll(logDir, 0755); err != nil {
				return fmt.Errorf("failed to create %s: %w", logDir, err)
			}

			// Stop existing service before replacing binary.
			if _, err := os.Stat(watchdogPlistDst); err == nil {
				if stopErr := exec.Command("launchctl", "unload", watchdogPlistDst).Run(); stopErr != nil {
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

			// Write launchd plist.
			if err := os.WriteFile(watchdogPlistDst, []byte(watchdogPlist), 0644); err != nil {
				return fmt.Errorf("failed to write plist: %w", err)
			}
			fmt.Printf("LaunchDaemon plist installed to %s\n", watchdogPlistDst)

			// Bootstrap the service.
			out, err := exec.Command("launchctl", "bootstrap", "system", watchdogPlistDst).CombinedOutput()
			if err != nil {
				// Fallback to legacy load.
				out2, err2 := exec.Command("launchctl", "load", watchdogPlistDst).CombinedOutput()
				if err2 != nil {
					return fmt.Errorf("failed to load service: %s / %s",
						strings.TrimSpace(string(out)), strings.TrimSpace(string(out2)))
				}
			}

			fmt.Println("Breeze Watchdog service installed and started.")
			return nil
		},
	}
}

func serviceUninstallCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "uninstall",
		Short: "Uninstall the watchdog launchd service",
		RunE: func(cmd *cobra.Command, args []string) error {
			if os.Geteuid() != 0 {
				return fmt.Errorf("must run as root (sudo breeze-watchdog service uninstall)")
			}

			// Stop and unload.
			if isWatchdogLoaded() {
				out, err := exec.Command("launchctl", "bootout", "system/"+watchdogLabel).CombinedOutput()
				if err != nil {
					out2, err2 := exec.Command("launchctl", "unload", watchdogPlistDst).CombinedOutput()
					if err2 != nil {
						fmt.Fprintf(os.Stderr, "Warning: failed to stop service: %s / %s\n",
							strings.TrimSpace(string(out)), strings.TrimSpace(string(out2)))
					}
				}
				fmt.Println("Service stopped.")
			}

			// Remove plist.
			if err := os.Remove(watchdogPlistDst); err != nil && !os.IsNotExist(err) {
				fmt.Fprintf(os.Stderr, "Warning: failed to remove %s: %v\n", watchdogPlistDst, err)
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

			if !fileExists(watchdogPlistDst) {
				return fmt.Errorf("service not installed — run 'sudo breeze-watchdog service install' first")
			}

			if isWatchdogLoaded() {
				out, err := exec.Command("launchctl", "kickstart", "system/"+watchdogLabel).CombinedOutput()
				if err != nil {
					return fmt.Errorf("failed to start service: %s", strings.TrimSpace(string(out)))
				}
			} else {
				out, err := exec.Command("launchctl", "bootstrap", "system", watchdogPlistDst).CombinedOutput()
				if err != nil {
					out2, err2 := exec.Command("launchctl", "load", watchdogPlistDst).CombinedOutput()
					if err2 != nil {
						return fmt.Errorf("failed to load service: %s / %s",
							strings.TrimSpace(string(out)), strings.TrimSpace(string(out2)))
					}
				}
			}

			fmt.Println("Breeze Watchdog service started.")
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

			if !isWatchdogLoaded() {
				fmt.Println("Service is not running.")
				return nil
			}

			out, err := exec.Command("launchctl", "bootout", "system/"+watchdogLabel).CombinedOutput()
			if err != nil {
				out2, err2 := exec.Command("launchctl", "unload", watchdogPlistDst).CombinedOutput()
				if err2 != nil {
					return fmt.Errorf("failed to stop service: %s / %s",
						strings.TrimSpace(string(out)), strings.TrimSpace(string(out2)))
				}
			}

			fmt.Println("Breeze Watchdog service stopped.")
			return nil
		},
	}
}

// restartWatchdogService restarts the watchdog via launchctl kickstart.
func restartWatchdogService() error {
	out, err := exec.Command("launchctl", "kickstart", "-k", "system/"+watchdogLabel).CombinedOutput()
	if err != nil {
		return fmt.Errorf("launchctl kickstart failed: %s: %w", strings.TrimSpace(string(out)), err)
	}
	return nil
}

// agentBinaryPath returns the platform-specific agent binary path.
func agentBinaryPath() string {
	return "/usr/local/bin/breeze-agent"
}

func isWatchdogLoaded() bool {
	err := exec.Command("launchctl", "print", "system/"+watchdogLabel).Run()
	return err == nil
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
