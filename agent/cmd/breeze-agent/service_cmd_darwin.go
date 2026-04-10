//go:build darwin

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/spf13/cobra"
)

const (
	darwinBinaryPath                 = "/usr/local/bin/breeze-agent"
	darwinDesktopHelperBinaryPath    = "/usr/local/bin/breeze-desktop-helper"
	darwinPlistDst                   = "/Library/LaunchDaemons/com.breeze.agent.plist"
	darwinDesktopUserPlistDst        = "/Library/LaunchAgents/com.breeze.desktop-helper-user.plist"
	darwinDesktopLoginWindowPlistDst = "/Library/LaunchAgents/com.breeze.desktop-helper-loginwindow.plist"
	darwinLogDir                     = "/Library/Logs/Breeze"
	darwinConfigDir                  = "/Library/Application Support/Breeze"
	darwinLabel                      = "com.breeze.agent"
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
    <true/>

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

const darwinDesktopUserPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.breeze.desktop-helper-user</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/breeze-desktop-helper</string>
        <string>--context</string>
        <string>user_session</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>LimitLoadToSessionType</key>
    <string>Aqua</string>
    <key>StandardOutPath</key>
    <string>/tmp/breeze-desktop-helper-user.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/breeze-desktop-helper-user.log</string>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>ProcessType</key>
    <string>Background</string>
</dict>
</plist>
`

const darwinDesktopLoginWindowPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.breeze.desktop-helper-loginwindow</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/breeze-desktop-helper</string>
        <string>--context</string>
        <string>login_window</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>LimitLoadToSessionType</key>
    <string>LoginWindow</string>
    <key>StandardOutPath</key>
    <string>/tmp/breeze-desktop-helper-loginwindow.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/breeze-desktop-helper-loginwindow.log</string>
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
		// Config dir starts restrictive (0700). Note: FixConfigPermissions() loosens this
		// to 0755 on startup so the Helper can read agent.yaml.
		if err := os.Chmod(darwinConfigDir, 0700); err != nil {
			return fmt.Errorf("failed to set permissions on %s: %w", darwinConfigDir, err)
		}

		// Stop existing service before replacing binary (safe for upgrades).
		if _, err := os.Stat(darwinPlistDst); err == nil {
			if stopErr := exec.Command("launchctl", "unload", darwinPlistDst).Run(); stopErr != nil {
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

		desktopHelperSource := filepath.Join(filepath.Dir(exePath), "breeze-desktop-helper")
		desktopHelperBytes, desktopHelperErr := os.ReadFile(desktopHelperSource)
		if desktopHelperErr != nil {
			desktopHelperBytes, desktopHelperErr = os.ReadFile(exePath)
		}
		if desktopHelperErr != nil {
			return fmt.Errorf("failed to stage desktop helper binary: %w", desktopHelperErr)
		}
		if err := os.WriteFile(darwinDesktopHelperBinaryPath, desktopHelperBytes, 0755); err != nil {
			return fmt.Errorf("failed to copy desktop helper to %s: %w", darwinDesktopHelperBinaryPath, err)
		}
		fmt.Printf("Desktop helper installed to %s\n", darwinDesktopHelperBinaryPath)

		if err := os.WriteFile(darwinDesktopUserPlistDst, []byte(darwinDesktopUserPlist), 0644); err != nil {
			fmt.Fprintf(os.Stderr, "Warning: failed to write desktop-helper user plist: %v\n", err)
		} else {
			fmt.Printf("LaunchAgent plist installed to %s\n", darwinDesktopUserPlistDst)
		}
		if err := os.WriteFile(darwinDesktopLoginWindowPlistDst, []byte(darwinDesktopLoginWindowPlist), 0644); err != nil {
			fmt.Fprintf(os.Stderr, "Warning: failed to write desktop-helper loginwindow plist: %v\n", err)
		} else {
			fmt.Printf("LaunchAgent plist installed to %s\n", darwinDesktopLoginWindowPlistDst)
		}

		// Immediately load the helper LaunchAgents so the desktop helper connects
		// right away rather than waiting for the first heartbeat.
		bootstrapDesktopHelperPlists()

		// Create breeze group for IPC socket access (best-effort)
		if err := exec.Command("dscl", ".", "-read", "/Groups/breeze").Run(); err != nil {
			if err2 := exec.Command("dscl", ".", "-create", "/Groups/breeze").Run(); err2 != nil {
				fmt.Fprintf(os.Stderr, "Warning: failed to create 'breeze' group: %v\n", err2)
			} else if err3 := exec.Command("dscl", ".", "-create", "/Groups/breeze", "PrimaryGroupID", "399").Run(); err3 != nil {
				fmt.Fprintf(os.Stderr, "Warning: failed to set group ID: %v\n", err3)
			} else {
				fmt.Println("Created 'breeze' group for IPC socket access.")
			}
		}

		fmt.Println()
		fmt.Println("Breeze Agent service installed.")

		// Show contextual next steps based on enrollment and service state.
		existingCfg, _ := config.Load(cfgFile)
		enrolled := existingCfg != nil && existingCfg.AgentID != ""
		running := isSystemServiceRunning()

		if enrolled && running {
			// Already enrolled and running — nothing more to do.
			fmt.Printf("\nAgent is enrolled and the service is running.\n")
			fmt.Printf("  Logs:    tail -f %s/agent.log\n", darwinLogDir)
		} else if enrolled {
			fmt.Println()
			fmt.Println("Next steps:")
			fmt.Printf("  1. Start:   sudo breeze-agent service start\n")
			fmt.Printf("  2. Status:  sudo breeze-agent service status\n")
			fmt.Printf("  3. Logs:    tail -f %s/agent.log\n", darwinLogDir)
		} else {
			fmt.Println()
			fmt.Println("Next steps:")
			fmt.Printf("  1. Enroll:  sudo breeze-agent enroll <key> --server https://your-server\n")
			fmt.Printf("  2. Start:   sudo breeze-agent service start\n")
			fmt.Printf("  3. Status:  sudo breeze-agent service status\n")
			fmt.Printf("  4. Logs:    tail -f %s/agent.log\n", darwinLogDir)
		}
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
		if err := os.Remove(darwinPlistDst); err != nil && !os.IsNotExist(err) {
			fmt.Fprintf(os.Stderr, "Warning: failed to remove %s: %v\n", darwinPlistDst, err)
		}
		if err := os.Remove(darwinDesktopUserPlistDst); err != nil && !os.IsNotExist(err) {
			fmt.Fprintf(os.Stderr, "Warning: failed to remove %s: %v\n", darwinDesktopUserPlistDst, err)
		}
		if err := os.Remove(darwinDesktopLoginWindowPlistDst); err != nil && !os.IsNotExist(err) {
			fmt.Fprintf(os.Stderr, "Warning: failed to remove %s: %v\n", darwinDesktopLoginWindowPlistDst, err)
		}

		// Remove binary
		if err := os.Remove(darwinBinaryPath); err != nil && !os.IsNotExist(err) {
			fmt.Fprintf(os.Stderr, "Warning: failed to remove %s: %v\n", darwinBinaryPath, err)
		}
		if err := os.Remove(darwinDesktopHelperBinaryPath); err != nil && !os.IsNotExist(err) {
			fmt.Fprintf(os.Stderr, "Warning: failed to remove %s: %v\n", darwinDesktopHelperBinaryPath, err)
		}

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

		// Bootstrap the desktop helper LaunchAgents so remote desktop connects promptly.
		if _, err := os.Stat(darwinDesktopUserPlistDst); err == nil {
			bootstrapDesktopHelperPlists()
		}
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
			// Fallback: can't get details but the job is loaded
			fmt.Println("Service: loaded (unable to retrieve details)")
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

// healLaunchdPlistsIfNeeded is the darwin implementation.
func healLaunchdPlistsIfNeeded() { healLaunchdPlists() }

// healLaunchdPlists checks the installed plists for the old SuccessfulExit
// KeepAlive config and replaces them with KeepAlive=true. This runs on daemon
// startup so existing installs self-heal after a binary-only auto-update.
func healLaunchdPlists() {
	if os.Geteuid() != 0 {
		return // only root can write to /Library/LaunchDaemons
	}
	for _, entry := range []struct {
		path    string
		content string
		label   string
		domain  string // launchd domain for reload
	}{
		{darwinPlistDst, darwinPlist, darwinLabel, "system"},
		{darwinDesktopUserPlistDst, darwinDesktopUserPlist, "com.breeze.desktop-helper-user", ""},
		{darwinDesktopLoginWindowPlistDst, darwinDesktopLoginWindowPlist, "com.breeze.desktop-helper-loginwindow", "loginwindow"},
	} {
		data, err := os.ReadFile(entry.path)
		if err != nil {
			continue // plist doesn't exist, nothing to heal
		}
		if !strings.Contains(string(data), "SuccessfulExit") {
			continue // already has KeepAlive=true
		}
		if err := os.WriteFile(entry.path, []byte(entry.content), 0644); err != nil {
			fmt.Fprintf(os.Stderr, "Warning: failed to heal plist %s: %v\n", entry.path, err)
			continue
		}
		fmt.Printf("Healed launchd plist %s (KeepAlive=true)\n", entry.path)
	}
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

// bootstrapDesktopHelperPlists immediately loads the desktop helper LaunchAgents
// into launchd for the installing user's GUI session (via SUDO_UID) and the
// loginwindow domain. Called from service install and service start so the
// helper connects right away rather than waiting for the first heartbeat.
func bootstrapDesktopHelperPlists() {
	// When run via sudo, SUDO_UID holds the real user's UID. Bootstrap the helper
	// into that user's GUI session so it can access the display immediately.
	if uid := os.Getenv("SUDO_UID"); uid != "" {
		domain := "gui/" + uid
		out, err := exec.Command("launchctl", "bootstrap", domain, darwinDesktopUserPlistDst).CombinedOutput()
		if err != nil {
			// Not fatal — kickstart will retry on next heartbeat.
			fmt.Fprintf(os.Stderr, "Note: could not bootstrap desktop helper for user %s (will retry on heartbeat): %s\n",
				uid, strings.TrimSpace(string(out)))
		} else {
			fmt.Printf("Desktop helper bootstrapped for GUI session (uid %s)\n", uid)
		}
	} else {
		fmt.Fprintln(os.Stderr, "Note: SUDO_UID not set; desktop helper GUI session bootstrap skipped (will retry on heartbeat).")
	}

	// Bootstrap the login-window helper (covers login screen remote access).
	// Use kickstart first (stable interface), fall back to bootstrap.
	const loginWindowLabel = "loginwindow/com.breeze.desktop-helper-loginwindow"
	if err := exec.Command("launchctl", "kickstart", "-k", loginWindowLabel).Run(); err == nil {
		fmt.Println("Login-window desktop helper kickstarted.")
	} else {
		out, err2 := exec.Command("launchctl", "bootstrap", "loginwindow", darwinDesktopLoginWindowPlistDst).CombinedOutput()
		if err2 != nil {
			fmt.Fprintf(os.Stderr, "Note: could not start login-window desktop helper: %s\n",
				strings.TrimSpace(string(out)))
		} else {
			fmt.Println("Login-window desktop helper bootstrapped.")
		}
	}
}
