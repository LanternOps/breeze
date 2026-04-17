//go:build darwin

package tunnel

import (
	"fmt"
	"net"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

const (
	vncPort       = 5900
	vncCheckDelay = 2 * time.Second
	kickstartPath = "/System/Library/CoreServices/RemoteManagement/ARDAgent.app/Contents/Resources/kickstart"
)

// IsScreenSharingSupported returns true on macOS where kickstart is available.
func IsScreenSharingSupported() bool {
	return true
}

// ErrScreenSharingRequiresManualEnable indicates that kickstart refused to
// enable Screen Sharing programmatically — the user (or MDM) must enable it
// via System Settings > General > Sharing > Screen Sharing.
var ErrScreenSharingRequiresManualEnable = fmt.Errorf(
	"macOS Screen Sharing is not enabled and kickstart cannot enable it on this macOS version. " +
		"Enable it in System Settings > General > Sharing > Screen Sharing.")

// EnableScreenSharing enables macOS Screen Sharing (VNC). Auth is delegated
// to whatever the user / MDM has configured — typically Apple Remote Desktop
// (the user authenticates with their macOS account credentials when the
// noVNC client prompts).
//
// On recent macOS (13+), Apple's kickstart tool can no longer flip Screen
// Sharing on from a non-interactive / LaunchDaemon context. The fast path
// checks if port 5900 is already listening and returns nil if so.
func EnableScreenSharing() error {
	if isPortListening("127.0.0.1", vncPort) {
		log.Info("macOS Screen Sharing already running — skipping kickstart")
		return nil
	}

	log.Info("enabling macOS Screen Sharing via kickstart")

	args := []string{
		"-activate",
		"-configure", "-access", "-on",
		"-restart", "-agent",
		"-privs", "-all",
	}

	cmd := exec.Command(kickstartPath, args...)
	output, err := cmd.CombinedOutput()
	if err != nil {
		if rollbackErr := DisableScreenSharing(); rollbackErr != nil {
			log.Error("rollback of screen sharing failed — port may be left open",
				"enableError", err.Error(), "rollbackError", rollbackErr.Error())
		}
		if strings.Contains(string(output), "must be enabled from System Settings") ||
			strings.Contains(string(output), "Can't call method") {
			return ErrScreenSharingRequiresManualEnable
		}
		return fmt.Errorf("kickstart failed: %w (output: %s)", err, string(output))
	}

	time.Sleep(vncCheckDelay)
	if !isPortListening("127.0.0.1", vncPort) {
		portErr := fmt.Errorf("VNC server not listening on port %d after kickstart", vncPort)
		if rollbackErr := DisableScreenSharing(); rollbackErr != nil {
			log.Error("rollback of screen sharing failed — port may be left open",
				"enableError", portErr.Error(), "rollbackError", rollbackErr.Error())
		}
		return portErr
	}

	log.Info("macOS Screen Sharing enabled successfully")
	return nil
}

// DisableScreenSharing deactivates macOS Screen Sharing (ARD agent).
// Idempotent — safe to call if already disabled.
func DisableScreenSharing() error {
	log.Info("disabling macOS Screen Sharing via kickstart")

	// Clear any legacy VNC password left over from older agent versions that
	// supported ephemeral per-session passwords. Idempotent — no-op when unset.
	// We standardize on ARD authentication (macOS user accounts) so any
	// legacy password must not linger on upgraded hosts.
	clearCmd := exec.Command(kickstartPath, "-configure", "-clientopts",
		"-setvnclegacy", "-vnclegacy", "no")
	if output, err := clearCmd.CombinedOutput(); err != nil {
		log.Warn("failed to clear legacy VNC password (older agent residue)",
			"error", err.Error(), "output", string(output))
	}

	cmd := exec.Command(kickstartPath, "-deactivate", "-stop")
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("kickstart deactivate failed: %w (output: %s)", err, string(output))
	}
	log.Info("macOS Screen Sharing disabled")
	return nil
}

// IsScreenSharingRunning checks if VNC is listening on port 5900.
func IsScreenSharingRunning() bool {
	return isPortListening("127.0.0.1", vncPort)
}

func isPortListening(host string, port int) bool {
	addr := net.JoinHostPort(host, strconv.Itoa(port))
	conn, err := net.DialTimeout("tcp", addr, 2*time.Second)
	if err != nil {
		return false
	}
	conn.Close()
	return true
}
