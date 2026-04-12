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
// via System Settings > General > Sharing > Screen Sharing, and set a VNC
// legacy password under "Computer Settings…".
var ErrScreenSharingRequiresManualEnable = fmt.Errorf(
	"macOS Screen Sharing is not enabled and kickstart cannot enable it on this macOS version. " +
		"Enable it in System Settings > General > Sharing > Screen Sharing, click Options…, turn on " +
		"\"VNC viewers may control screen with password\", and set a password")

// EnableScreenSharing enables macOS Screen Sharing (VNC) with an optional
// VNC legacy password. If password is empty, VNC legacy auth is not configured.
// The agent runs as root, so kickstart works without sudo.
//
// On recent macOS (13+), Apple's kickstart tool can no longer flip Screen
// Sharing on from a non-interactive / LaunchDaemon context — it exits with
// "Screen Sharing or Remote Management must be enabled from System Settings
// or via MDM" and a Perl nil-pointer error. If Screen Sharing is already
// running (user enabled it manually or via MDM), we skip kickstart entirely
// and use the existing listener. In that case `password` is ignored — the
// VNC session authenticates with whatever the user configured.
func EnableScreenSharing(password string) error {
	// Fast path: if port 5900 is already listening, Screen Sharing is already
	// on. This is the modern macOS path where the user enabled it manually.
	if isPortListening("127.0.0.1", vncPort) {
		log.Info("macOS Screen Sharing already running — skipping kickstart")
		return nil
	}

	log.Info("enabling macOS Screen Sharing via kickstart", "hasPassword", password != "")

	args := []string{
		"-activate",
		"-configure", "-access", "-on",
		"-restart", "-agent",
		"-privs", "-all",
	}

	if password != "" {
		args = append(args, "-configure", "-clientopts",
			"-setvnclegacy", "-vnclegacy", "yes",
			"-setvncpw", "-vncpw", password,
		)
	}

	cmd := exec.Command(kickstartPath, args...)
	output, err := cmd.CombinedOutput()
	if err != nil {
		// Atomic rollback: disable if enable failed partway
		if rollbackErr := DisableScreenSharing(); rollbackErr != nil {
			log.Error("rollback of screen sharing failed — port may be left open",
				"enableError", err.Error(), "rollbackError", rollbackErr.Error())
		}
		// Recent macOS: surface a friendly error the UI can show the user
		// instead of the raw Perl crash.
		if strings.Contains(string(output), "must be enabled from System Settings") ||
			strings.Contains(string(output), "Can't call method") {
			return ErrScreenSharingRequiresManualEnable
		}
		return fmt.Errorf("kickstart failed: %w (output: %s)", err, string(output))
	}

	// Give the VNC server a moment to start listening.
	time.Sleep(vncCheckDelay)

	if !isPortListening("127.0.0.1", vncPort) {
		portErr := fmt.Errorf("VNC server not listening on port %d after kickstart", vncPort)
		// Atomic rollback: disable if port never came up
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

	// Clear VNC legacy password before deactivating
	clearCmd := exec.Command(kickstartPath, "-configure", "-clientopts",
		"-setvnclegacy", "-vnclegacy", "no")
	if output, err := clearCmd.CombinedOutput(); err != nil {
		log.Warn("failed to clear VNC legacy password", "error", err.Error(), "output", string(output))
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
