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
	darwinBinaryPath   = "/usr/local/bin/breeze-agent"
	darwinPlistDst     = "/Library/LaunchDaemons/com.breeze.agent.plist"
	darwinUserPlistDst = "/Library/LaunchAgents/com.breeze.agent-user.plist"
	darwinLogDir       = "/Library/Logs/Breeze"
	darwinConfigDir    = "/Library/Application Support/Breeze"
	darwinLabel        = "com.breeze.agent"
)

// Embedded plist — matches agent/service/launchd/com.breeze.agent.plist
const darwinPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.breeze.agent</string>

    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/breeze-agent</string>
        <string>run</string>
    </array>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>

    <key>ThrottleInterval</key>
    <integer>5</integer>

    <key>WorkingDirectory</key>
    <string>/Library/Application Support/Breeze</string>

    <key>StandardOutPath</key>
    <string>/Library/Logs/Breeze/agent.log</string>

    <key>StandardErrorPath</key>
    <string>/Library/Logs/Breeze/agent.err</string>

    <key>SoftResourceLimits</key>
    <dict>
        <key>NumberOfFiles</key>
        <integer>8192</integer>
    </dict>
</dict>
</plist>
`

// Embedded user-helper plist
const darwinUserPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.breeze.agent-user</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/breeze-agent</string>
        <string>user-helper</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>LimitLoadToSessionType</key>
    <string>Aqua</string>
    <key>StandardOutPath</key>
    <string>/tmp/breeze-agent-user.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/breeze-agent-user.log</string>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>ProcessType</key>
    <string>Background</string>
</dict>
</plist>
`

var serviceCmd = &cobra.Command{
	Use:   "service",
	Short: "Manage the Breeze Agent system service (launchd)",
}

var withUserHelper bool

func init() {
	rootCmd.AddCommand(serviceCmd)
	serviceCmd.AddCommand(serviceInstallCmd)
	serviceCmd.AddCommand(serviceUninstallCmd)
	serviceCmd.AddCommand(serviceStartCmd)
	serviceCmd.AddCommand(serviceStopCmd)
	serviceCmd.AddCommand(serviceStatusCmd)
	serviceInstallCmd.Flags().BoolVar(&withUserHelper, "with-user-helper", false, "Also install the per-user desktop helper LaunchAgent")
}

var serviceInstallCmd = &cobra.Command{
	Use:   "install",
	Short: "Install the agent as a launchd service",
	RunE: func(cmd *cobra.Command, args []string) error {
		if os.Geteuid() != 0 {
			return fmt.Errorf("must run as root (sudo breeze-agent service install)")
		}

		// Create directories
		for _, dir := range []string{darwinConfigDir, darwinLogDir} {
			if err := os.MkdirAll(dir, 0755); err != nil {
				return fmt.Errorf("failed to create %s: %w", dir, err)
			}
		}
		// Config dir is more restrictive
		if err := os.Chmod(darwinConfigDir, 0700); err != nil {
			return fmt.Errorf("failed to set permissions on %s: %w", darwinConfigDir, err)
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

		if exePath != darwinBinaryPath {
			data, err := os.ReadFile(exePath)
			if err != nil {
				return fmt.Errorf("failed to read binary: %w", err)
			}
			if err := os.WriteFile(darwinBinaryPath, data, 0755); err != nil {
				return fmt.Errorf("failed to copy binary to %s: %w", darwinBinaryPath, err)
			}
			fmt.Printf("Binary installed to %s\n", darwinBinaryPath)
		}

		// Write launchd plist
		if err := os.WriteFile(darwinPlistDst, []byte(darwinPlist), 0644); err != nil {
			return fmt.Errorf("failed to write plist: %w", err)
		}
		fmt.Printf("LaunchDaemon plist installed to %s\n", darwinPlistDst)

		// Optionally install the per-user desktop helper LaunchAgent
		if withUserHelper {
			if err := os.WriteFile(darwinUserPlistDst, []byte(darwinUserPlist), 0644); err != nil {
				fmt.Fprintf(os.Stderr, "Warning: failed to write user-helper plist: %v\n", err)
			} else {
				fmt.Printf("LaunchAgent plist installed to %s\n", darwinUserPlistDst)
			}
		}

		// Create breeze group for IPC socket access (best-effort)
		if err := exec.Command("dscl", ".", "-read", "/Groups/breeze").Run(); err != nil {
			_ = exec.Command("dscl", ".", "-create", "/Groups/breeze").Run()
			_ = exec.Command("dscl", ".", "-create", "/Groups/breeze", "PrimaryGroupID", "399").Run()
			fmt.Println("Created 'breeze' group for IPC socket access.")
		}

		fmt.Println()
		fmt.Println("Breeze Agent service installed.")
		fmt.Println()
		fmt.Println("Next steps:")
		fmt.Printf("  1. Enroll:  sudo breeze-agent enroll <key> --server https://your-server\n")
		fmt.Printf("  2. Start:   sudo breeze-agent service start\n")
		fmt.Printf("  3. Status:  sudo breeze-agent service status\n")
		fmt.Printf("  4. Logs:    tail -f %s/agent.log\n", darwinLogDir)
		return nil
	},
}

var serviceUninstallCmd = &cobra.Command{
	Use:   "uninstall",
	Short: "Uninstall the agent launchd service",
	RunE: func(cmd *cobra.Command, args []string) error {
		if os.Geteuid() != 0 {
			return fmt.Errorf("must run as root (sudo breeze-agent service uninstall)")
		}

		// Stop and unload the daemon
		if isLaunchdLoaded(darwinLabel) {
			out, err := exec.Command("launchctl", "bootout", "system/"+darwinLabel).CombinedOutput()
			if err != nil {
				// Fallback to legacy unload
				out2, err2 := exec.Command("launchctl", "unload", darwinPlistDst).CombinedOutput()
				if err2 != nil {
					fmt.Fprintf(os.Stderr, "Warning: failed to stop service: %s / %s\n",
						strings.TrimSpace(string(out)), strings.TrimSpace(string(out2)))
				}
			} else {
				_ = out
			}
			fmt.Println("Service stopped.")
		}

		// Remove plists
		os.Remove(darwinPlistDst)
		os.Remove(darwinUserPlistDst)

		// Remove binary
		os.Remove(darwinBinaryPath)

		fmt.Println("Breeze Agent service uninstalled.")
		fmt.Printf("Config at %s was preserved.\n", darwinConfigDir)
		fmt.Printf("To remove config: sudo rm -rf '%s'\n", darwinConfigDir)
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

		if !fileExists(darwinPlistDst) {
			return fmt.Errorf("service not installed — run 'sudo breeze-agent service install' first")
		}

		// Use bootstrap (modern) with fallback to load (legacy)
		if isLaunchdLoaded(darwinLabel) {
			// Already loaded, just kick it
			out, err := exec.Command("launchctl", "kickstart", "system/"+darwinLabel).CombinedOutput()
			if err != nil {
				return fmt.Errorf("failed to start service: %s", strings.TrimSpace(string(out)))
			}
		} else {
			out, err := exec.Command("launchctl", "bootstrap", "system", darwinPlistDst).CombinedOutput()
			if err != nil {
				// Fallback to legacy load
				out2, err2 := exec.Command("launchctl", "load", darwinPlistDst).CombinedOutput()
				if err2 != nil {
					return fmt.Errorf("failed to load service: %s / %s",
						strings.TrimSpace(string(out)), strings.TrimSpace(string(out2)))
				}
			}
		}

		fmt.Println("Breeze Agent service started.")
		fmt.Printf("Logs: tail -f %s/agent.log\n", darwinLogDir)
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

		if !isLaunchdLoaded(darwinLabel) {
			fmt.Println("Service is not running.")
			return nil
		}

		out, err := exec.Command("launchctl", "bootout", "system/"+darwinLabel).CombinedOutput()
		if err != nil {
			// Fallback to legacy unload
			out2, err2 := exec.Command("launchctl", "unload", darwinPlistDst).CombinedOutput()
			if err2 != nil {
				return fmt.Errorf("failed to stop service: %s / %s",
					strings.TrimSpace(string(out)), strings.TrimSpace(string(out2)))
			}
		}

		fmt.Println("Breeze Agent service stopped.")
		return nil
	},
}

var serviceStatusCmd = &cobra.Command{
	Use:   "status",
	Short: "Show agent service status",
	RunE: func(cmd *cobra.Command, args []string) error {
		if !fileExists(darwinPlistDst) {
			fmt.Println("Service: not installed")
			return nil
		}

		if !isLaunchdLoaded(darwinLabel) {
			fmt.Println("Service: installed but not loaded")
			return nil
		}

		// Get detailed info from launchctl print
		out, err := exec.Command("launchctl", "print", "system/"+darwinLabel).CombinedOutput()
		if err != nil {
			// Fallback: just report as running
			fmt.Println("Service: running")
			return nil
		}

		// Parse PID and state from output
		lines := strings.Split(string(out), "\n")
		for _, line := range lines {
			trimmed := strings.TrimSpace(line)
			if strings.HasPrefix(trimmed, "pid = ") || strings.HasPrefix(trimmed, "state = ") {
				fmt.Println(trimmed)
			}
		}

		fmt.Printf("Logs: %s/agent.log\n", darwinLogDir)
		return nil
	},
}

// isLaunchdLoaded checks if the given label is loaded in launchd.
func isLaunchdLoaded(label string) bool {
	err := exec.Command("launchctl", "print", "system/"+label).Run()
	return err == nil
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
