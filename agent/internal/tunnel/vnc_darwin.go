//go:build darwin

package tunnel

import (
	"fmt"
	"net"
	"os/exec"
	"strconv"
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

// EnableScreenSharing enables macOS Screen Sharing (VNC) with an optional
// VNC legacy password. If password is empty, VNC legacy auth is not configured.
// The agent runs as root, so kickstart works without sudo.
func EnableScreenSharing(password string) error {
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
