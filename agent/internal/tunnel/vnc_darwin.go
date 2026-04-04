//go:build darwin

package tunnel

import (
	"fmt"
	"net"
	"os/exec"
	"time"
)

const (
	vncPort       = 5900
	vncCheckDelay = 2 * time.Second
)

// EnableScreenSharing enables macOS Screen Sharing (VNC) if not already running.
// The agent runs as root, so kickstart works without sudo.
func EnableScreenSharing() error {
	if isPortListening("127.0.0.1", vncPort) {
		log.Info("VNC server already listening on port 5900")
		return nil
	}

	log.Info("enabling macOS Screen Sharing via kickstart")

	kickstart := "/System/Library/CoreServices/RemoteManagement/ARDAgent.app/Contents/Resources/kickstart"
	cmd := exec.Command(kickstart,
		"-activate",
		"-configure", "-access", "-on",
		"-restart", "-agent",
		"-privs", "-all",
	)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("kickstart failed: %w (output: %s)", err, string(output))
	}

	// Give the VNC server a moment to start listening.
	time.Sleep(vncCheckDelay)

	if !isPortListening("127.0.0.1", vncPort) {
		return fmt.Errorf("VNC server not listening on port %d after kickstart", vncPort)
	}

	log.Info("macOS Screen Sharing enabled successfully")
	return nil
}

func isPortListening(host string, port int) bool {
	addr := fmt.Sprintf("%s:%d", host, port)
	conn, err := net.DialTimeout("tcp", addr, 2*time.Second)
	if err != nil {
		return false
	}
	conn.Close()
	return true
}
